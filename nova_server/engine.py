"""Nova's proactive care engine.

Alexa+ answers when spoken to. Caregiving needs the opposite too: someone who
notices the 6 PM pill wasn't taken, asks again kindly, and tells the family only
when it matters. The engine runs on the household clock and turns the care plan
into announcements, with an escalation ladder:

    T        remind Rose ("It's 6 PM, time for your Metformin with dinner")
    T+30m    follow up with Rose, gently
    T+90m    tell the primary caregiver, open an alert

It also prompts the morning check-in, reminds about appointments, runs a
wellness check when the home has been quiet all morning, and reacts to front
door events (Ring). Every trigger is idempotent (dedupe keys), and jumps of the
household clock skip past triggers instead of replaying them.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Any

from . import insights as ins
from .store import Store, iso, now, parse

log = logging.getLogger("nova.engine")

FOLLOW_UP_AFTER = timedelta(minutes=30)
ESCALATE_AFTER = timedelta(minutes=90)
CHECKIN_AT = (9, 0)
WELLNESS_AT = (11, 0)
WELLNESS_ESCALATE_AFTER = timedelta(minutes=30)
MAX_CATCH_UP = timedelta(hours=3)  # a bigger jump is treated as a time skip


def speak_list(items: list[str]) -> str:
    items = [i for i in items if i]
    if len(items) <= 1:
        return "".join(items)
    return ", ".join(items[:-1]) + " and " + items[-1]


class CareEngine:
    def __init__(self, store: Store) -> None:
        self.store = store
        self.last_tick: datetime | None = None
        self._stop = threading.Event()
        self.fired: list[str] = []  # dedupe keys fired this process (for tests and logs)

    # -- loop -----------------------------------------------------------------
    def run_forever(self, interval: float = 1.0) -> None:
        while not self._stop.is_set():
            try:
                self.tick()
            except Exception:  # never let the loop die
                log.exception("engine tick failed")
            time.sleep(interval)

    def start(self) -> threading.Thread:
        th = threading.Thread(target=self.run_forever, name="nova-care-engine", daemon=True)
        th.start()
        return th

    def stop(self) -> None:
        self._stop.set()

    def reset(self) -> None:
        self.last_tick = None

    def tick(self, t: datetime | None = None) -> list[str]:
        t = t or now()
        last = self.last_tick
        self.last_tick = t
        if last is None or t <= last or t - last > MAX_CATCH_UP:
            return []  # first tick, clock went back, or a big jump: don't replay the past
        fired: list[str] = []
        for elder in self.store.elders():
            fired += self._doses(elder, last, t)
            fired += self._checkin(elder, last, t)
            fired += self._bp_prompt(elder, last, t)
            fired += self._appointments(elder, last, t)
            fired += self._wellness(elder, last, t)
            fired += self._refills(elder, last, t)
        self.fired += fired
        return fired

    # -- helpers --------------------------------------------------------------
    @staticmethod
    def _crossed(moment: datetime, last: datetime, t: datetime) -> bool:
        return last < moment <= t

    def _primary(self) -> dict[str, Any] | None:
        cgs = self.store.caregivers()
        return next((p for p in cgs if (p.get("relation") or "").startswith("daughter")), cgs[0] if cgs else None)

    def _family(self) -> list[dict[str, Any]]:
        return [p for p in self.store.caregivers() if not (p.get("relation") or "").startswith("home aide")]

    def _fire(self, key: str, to: str, kind: str, title: str, speech: str, **kw: Any) -> list[str]:
        if self.store.announce(to, kind, title, speech, dedupe=key, **kw) is None:
            return []
        log.info("announce %s -> %s: %s", kind, to, speech)
        return [key]

    # -- medication ladder ----------------------------------------------------
    def _doses(self, elder: dict[str, Any], last: datetime, t: datetime) -> list[str]:
        fired: list[str] = []
        days = {last.date(), t.date()}
        for day in sorted(days):
            day_dt = datetime.combine(day, datetime.min.time())
            groups: dict[datetime, list[dict[str, Any]]] = defaultdict(list)
            for d in ins.doses_for_day(self.store, elder["id"], day_dt, t):
                groups[parse(d["scheduled_for"])].append(d)
            for at, doses in sorted(groups.items()):
                pending = [d for d in doses if d["status"] not in ("taken", "skipped")]
                if not pending:
                    continue
                slot = f"{at.date()}:{at.strftime('%H%M')}"
                names = speak_list([d["name"] for d in pending])
                looks = speak_list([f"the {d['appearance']}" for d in pending if d.get("appearance")])
                food = " with your meal" if any(d.get("with_food") for d in pending) else ""
                related = {"doses": [d["med_id"] for d in pending], "scheduled_for": iso(at)}
                name = elder["short_name"]

                if self._crossed(at, last, t):
                    fired += self._fire(
                        f"dose_reminder:{slot}", elder["id"], "dose_reminder", f"{ins.time_label(at)} medicines",
                        f"It's {ins.time_label(at)}, {name}. Time for your {names}{food}. That's {looks}.",
                        due_at=at, expects_reply=True, replies=["I took it", "Remind me in 10 minutes", "I'll skip it tonight"],
                        related=related,
                    )
                if self._crossed(at + FOLLOW_UP_AFTER, last, t) and not self.store.has_dedupe(f"snoozed:{slot}"):
                    fired += self._fire(
                        f"dose_followup:{slot}", elder["id"], "dose_followup", "Just checking",
                        f"Just checking, {name}: have you taken your {ins.time_label(at)} {names} yet?",
                        due_at=at + FOLLOW_UP_AFTER, expects_reply=True, replies=["Yes, I took it", "Not yet", "Remind me in 10 minutes"],
                        related=related,
                    )
                if self._crossed(at + ESCALATE_AFTER, last, t):
                    cg = self._primary()
                    if cg:
                        reminded = ins.time_label(at) + (" and " + ins.time_label(at + FOLLOW_UP_AFTER)
                                                         if self.store.has_dedupe(f"dose_followup:{slot}") else "")
                        mom = (elder.get("relation") or "mom").split("/")[0].capitalize()
                        res = self._fire(
                            f"escalate:{slot}", cg["id"], "caregiver_escalation", f"{name} missed her {ins.time_label(at)} medicines",
                            f"{mom} hasn't taken her {ins.time_label(at)} {names}. I reminded her at {reminded}.",
                            severity="watch", expects_reply=True, due_at=at + ESCALATE_AFTER,
                            replies=["Remind Mom again", "Tell Mom I'll call her", "I'll handle it"],
                            related=related,
                        )
                        fired += res
                        if res:
                            self.store.add_alert(elder["id"], "watch", f"missed-{slot}",
                                                 f"{name} hasn't taken her {ins.time_label(at)} {names}. Nova reminded her at {reminded}.")
        return fired

    # -- morning check-in -----------------------------------------------------
    def _checkin(self, elder: dict[str, Any], last: datetime, t: datetime) -> list[str]:
        at = t.replace(hour=CHECKIN_AT[0], minute=CHECKIN_AT[1], second=0)
        if not self._crossed(at, last, t):
            return []
        start = t.replace(hour=0, minute=0, second=0)
        if self.store.checkins(elder["id"], start):
            return []
        return self._fire(
            f"checkin:{t.date()}", elder["id"], "checkin_prompt", "Good morning",
            f"Good morning, {elder['short_name']}! How are you feeling today?",
            expects_reply=True, replies=["I feel good today", "A bit dizzy again", "My knee hurts"],
        )

    # -- morning blood pressure (when the doctor asked for it) ------------------
    def _bp_prompt(self, elder: dict[str, Any], last: datetime, t: datetime) -> list[str]:
        at = t.replace(hour=7, minute=45, second=0)
        if not self._crossed(at, last, t):
            return []
        asked = any("blood pressure every morning" in n["text"].lower() for n in self.store.care_notes(elder["id"]))
        if not asked or self.store.bp(elder["id"], t.replace(hour=0, minute=0, second=0)):
            return []
        return self._fire(
            f"bp:{t.date()}", elder["id"], "checkin_prompt", "Blood pressure",
            f"Good morning, {elder['short_name']}. Dr. Patel asked for a blood pressure reading every morning before "
            "your pills. Tell me the numbers when you're ready.",
            due_at=at, expects_reply=True, replies=["It's 118 over 72", "Remind me in 10 minutes"],
        )

    # -- appointments ---------------------------------------------------------
    def _appointments(self, elder: dict[str, Any], last: datetime, t: datetime) -> list[str]:
        fired: list[str] = []
        for a in self.store.appointments(elder["id"], t - timedelta(hours=3), t + timedelta(days=2)):
            if a["provider"] and a["provider"].split()[0] in a["title"]:
                continue  # personal visits (Grace) don't need reminders
            at = parse(a["at"])
            evening_before = (at - timedelta(days=1)).replace(hour=18, minute=0, second=0)
            two_hours = at - timedelta(hours=2)
            driver = self._driver_for(a)
            ride = f" {driver['short_name']} is driving you." if driver else ""
            if self._crossed(evening_before, last, t):
                fired += self._fire(
                    f"appt-eve:{a['id']}:{at.date()}", elder["id"], "appointment_reminder", "Tomorrow",
                    f"Tomorrow at {ins.time_label(at)} you see {a['provider']} for your {a['title'].lower()}.{ride} "
                    "Want me to get your visit brief ready?",
                    expects_reply=True, replies=["Yes, prepare my visit brief", "No thanks"],
                )
            if self._crossed(two_hours, last, t):
                fired += self._fire(
                    f"appt-2h:{a['id']}:{at.date()}", elder["id"], "appointment_reminder", "Appointment soon",
                    f"In two hours you see {a['provider']}.{ride} Remember your pill bottles and your blood pressure log.",
                )
                if driver:
                    fired += self._fire(
                        f"appt-2h-driver:{a['id']}:{at.date()}", driver["id"], "appointment_reminder", "Driving Mom",
                        f"Reminder: you're driving Mom to {a['provider']} at {ins.time_label(at)}, {a['location']}.",
                    )
        return fired

    def _driver_for(self, appt: dict[str, Any]) -> dict[str, Any] | None:
        for m in self.store.recent_messages(now() - timedelta(days=14)):
            if "drive" in m["body"].lower() and ("appointment" in m["body"].lower() or "cardio" in m["body"].lower()):
                return self.store.person(m["from_id"])
        return None

    # -- wellness check (quiet home) ------------------------------------------
    def activity_today(self, elder: dict[str, Any], t: datetime) -> list[str]:
        start = t.replace(hour=0, minute=0, second=0)
        signs = []
        if self.store.q("SELECT 1 FROM dose_events e JOIN medications m ON m.id = e.med_id "
                        "WHERE m.person_id = ? AND e.logged_at >= ? AND e.logged_by = ?", (elder["id"], iso(start), elder["id"])):
            signs.append("dose logged")
        if self.store.checkins(elder["id"], start):
            signs.append("check-in")
        if [s for s in self.store.signals(elder["id"], start) if s["kind"] in ("motion", "door_open") and s["who"] in ("rose", "unknown", None)]:
            signs.append("movement")
        if [m for m in self.store.recent_messages(start) if m["from_id"] == elder["id"]]:
            signs.append("message")
        return signs

    def _wellness(self, elder: dict[str, Any], last: datetime, t: datetime) -> list[str]:
        fired: list[str] = []
        at = t.replace(hour=WELLNESS_AT[0], minute=WELLNESS_AT[1], second=0)
        if self._crossed(at, last, t) and not self.activity_today(elder, t):
            fired += self._fire(
                f"wellness:{t.date()}", elder["id"], "wellness_check", "Checking in",
                f"Hi {elder['short_name']}, it's been quiet this morning. Is everything okay?",
                expects_reply=True, replies=["I'm fine, just resting", "I need help"],
            )
        if self._crossed(at + WELLNESS_ESCALATE_AFTER, last, t) and self.store.has_dedupe(f"wellness:{t.date()}") \
                and not self.activity_today(elder, t):
            for cg in self._family():
                fired += self._fire(
                    f"wellness-escalate:{t.date()}:{cg['id']}", cg["id"], "caregiver_escalation", "No activity at Mom's",
                    f"There's been no activity at Mom's this morning: no pills logged, no movement at the front door, "
                    f"and she didn't answer my check-in at {ins.time_label(at)}. You may want to call her.",
                    severity="urgent", expects_reply=True, replies=["Call Mom", "Ask Grace to stop by"],
                )
            self.store.add_alert(elder["id"], "urgent", f"quiet-{t.date()}",
                                 f"No activity at {elder['short_name']}'s home this morning and no answer to Nova's check-in.")
        return fired

    # -- refills --------------------------------------------------------------
    def _refills(self, elder: dict[str, Any], last: datetime, t: datetime) -> list[str]:
        fired: list[str] = []
        ten = t.replace(hour=10, minute=0, second=0)
        if self._crossed(ten, last, t):
            open_ids = {r["med_id"] for r in self.store.refills(elder["id"])}
            for m in self.store.medications(elder["id"]):
                if m.get("supply") is None or m["id"] in open_ids:
                    continue
                days = m["supply"] // max(1, len(m["times"]))
                if days <= 5:
                    fired += self._fire(
                        f"low:{m['id']}:{t.date()}", elder["id"], "info", "Running low",
                        f"{elder['short_name']}, you have about {days} days of {m['name']} left. "
                        "Want me to order a refill from Elm Street Pharmacy?",
                        due_at=ten, expects_reply=True, replies=["Yes, order a refill", "Not now"],
                    )
        for r in self.store.refills(elder["id"], ("requested",)):
            if r["ready_at"] and self._crossed(parse(r["ready_at"]), last, t):
                self.store.x("UPDATE refills SET status = 'ready' WHERE id = ?", (r["id"],))
                for to in [elder["id"]] + [p["id"] for p in self.store.caregivers()]:
                    fired += self._fire(f"refill-ready:{r['id']}:{to}", to, "info", "Refill ready",
                                        f"The {r['name']} refill is ready at {r['pharmacy']}.")
        return fired

    # -- Ring (front door) ----------------------------------------------------
    def on_ring_event(self, kind: str, who: str | None) -> dict[str, Any]:
        """Turn a front-door event into a signal plus the right announcements."""
        elders = self.store.elders()
        if not elders:
            return {"ok": False}
        elder = elders[0]
        t = now()
        who = (who or "unknown").lower()
        label = {"grace": "Grace", "delivery": "A delivery driver", "rose": elder["short_name"], "unknown": "Someone"}.get(who, who.title())
        text = {
            "ding": f"{label} rang the doorbell",
            "motion": "Motion at the front door",
            "door_open": f"{label} opened the front door" if who != "rose" else f"{elder['short_name']} went out the front door",
        }.get(kind, f"Front door: {kind}")
        sid = self.store.add_signal(elder["id"], "ring", kind, who, text, at=t)
        out = {"ok": True, "signal": {"id": sid, "at": iso(t), "kind": kind, "who": who, "text": text}, "announced": []}
        key = f"ring:{sid}"
        if kind == "ding" and who == "grace":
            out["announced"] += self._fire(key + ":rose", elder["id"], "visitor", "Front door",
                                           "Grace is at the front door.")
            for cg in self._family():
                out["announced"] += self._fire(key + f":{cg['id']}", cg["id"], "visitor", "Grace arrived",
                                               f"Grace arrived at Mom's at {ins.time_label(t)}.")
        elif kind == "ding" and who == "delivery":
            out["announced"] += self._fire(key + ":rose", elder["id"], "visitor", "Package",
                                           "Someone dropped off a package at the front door.")
        elif kind == "ding":
            out["announced"] += self._fire(key + ":rose", elder["id"], "visitor", "Front door",
                                           "Someone is at the front door.")
        elif kind == "door_open" and who == "rose" and (t.hour >= 22 or t.hour < 6):
            for cg in self._family():
                out["announced"] += self._fire(key + f":{cg['id']}", cg["id"], "caregiver_escalation",
                                               "Front door at night",
                                               f"Mom's front door opened at {ins.time_label(t)}. That's unusual for her.",
                                               severity="urgent", expects_reply=True, replies=["Call Mom"])
            self.store.add_alert(elder["id"], "urgent", f"night-door-{sid}",
                                 f"Front door opened at {ins.time_label(t)}, late at night.")
        return out
