"""Nova MCP server: a care circle for Alexa+.

Transport: Streamable HTTP (MCP spec 2025-11-25 and later; the SDK also speaks
2026-07-28). Every request carries a bearer token that identifies one person
in the circle, which is how Alexa+ account linking hands identity to an MCP
server. The same tool answers differently for Rose (the person being cared
for) and for Maya (her daughter): Rose's own voice is the source of truth,
and Rose decides what her family can see.

Run:  python -m nova_server            (http://127.0.0.1:8765/mcp)
      python -m nova_server --stdio --as maya
"""

from __future__ import annotations

import logging
import os
import re
from datetime import timedelta
from pathlib import Path
from typing import Annotated, Any, Literal

import anyio
from mcp.server.apps import Apps
from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.auth.provider import AccessToken
from mcp.server.auth.settings import AuthSettings
from mcp.server.elicitation import AcceptedElicitation, ElicitationResult
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.resolve import Elicit, Resolve
from mcp.server.mcpserver.prompts.base import UserMessage
from mcp.server.mcpserver.resources import Resource
from mcp_types import Icon, ToolAnnotations
from pydantic import BaseModel, Field
from starlette.requests import Request
from starlette.responses import JSONResponse

from . import insights as ins
from . import vision
from .engine import CareEngine
from .seed import DEMO_TOKENS, ensure_seeded, seed
from .store import SHARING_CATEGORIES, Store, clock_speed, iso, now, parse, set_clock

log = logging.getLogger("nova.server")

ROOT = Path(__file__).resolve().parent
DB_PATH = Path(os.getenv("NOVA_DB", ROOT.parent / "data" / "nova.db"))
HOST = os.getenv("NOVA_MCP_HOST", "127.0.0.1")
PORT = int(os.getenv("NOVA_MCP_PORT", "8765"))
PUBLIC_URL = os.getenv("NOVA_PUBLIC_URL", f"http://{HOST}:{PORT}")

store = Store(DB_PATH)
ensure_seeded(store)
engine = CareEngine(store)
RING_SECRET = os.getenv("NOVA_RING_SECRET", "nova-demo-ring")

NOVA_ICON = Icon(
    src=(
        "data:image/svg+xml;base64,"
        "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+PHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9"
        "IjY0IiByeD0iMTYiIGZpbGw9IiMwYjEyMjAiLz48cGF0aCBkPSJNMzIgMTBsNSAxNyAxNyA1LTE3IDUtNSAxNy01LTE3LTE3LTUgMTctNXoiIGZp"
        "bGw9IiMwMGNhZmYiLz48L3N2Zz4="
    ),
    mime_type="image/svg+xml",
    sizes=["any"],
)

INSTRUCTIONS = """\
Nova connects one older adult with their care circle (family and paid caregivers).
Who is speaking is decided by the access token, never by what the user says.

Voice style: every tool returns `speech`, one or two sentences ready to be spoken.
Prefer saying `speech` as-is (you may shorten it). Do not read lists aloud; screens show the detail.
Safety: Nova does not diagnose or change medication plans. For emergencies (a fall with injury,
chest pain, trouble breathing, stroke signs) call get_help and tell the person to call 911.
Privacy: the older adult controls what the circle sees (set_sharing). Respect `not_shared` results.
"""

# ---------------------------------------------------------------------------
# Identity
# ---------------------------------------------------------------------------
_STDIO_USER: str | None = None


class CircleTokenVerifier:
    """Maps bearer tokens to circle members.

    Demo tokens live in seed.py. In production this is where an Alexa+
    account-linking token (OAuth 2.1, e.g. Login with Amazon or Amazon Cognito)
    is introspected and mapped to a circle member.
    """

    async def verify_token(self, token: str) -> AccessToken | None:
        person_id = DEMO_TOKENS.get(token)
        if not person_id or not store.person(person_id):
            return None
        return AccessToken(
            token=token, client_id="alexa-plus", scopes=["nova.care"], subject=person_id,
            resource=f"{PUBLIC_URL}/mcp",
        )


def caller() -> dict[str, Any]:
    tok = get_access_token()
    pid = tok.subject if tok else _STDIO_USER
    person = store.person(pid) if pid else None
    if not person:
        raise PermissionError("Unknown caller. Link your Alexa account to Nova first.")
    return person


def care_recipient(me: dict[str, Any], who: str = "") -> dict[str, Any]:
    """The elder this request is about. Elders are always about themselves."""
    if me["role"] == "elder":
        return me
    if who:
        p = store.find_person(who)
        if p and p["role"] == "elder":
            return p
    elders = store.elders()
    if not elders:
        raise ValueError("This circle has no care recipient yet.")
    return elders[0]


def shared(me: dict[str, Any], elder: dict[str, Any], category: str) -> bool:
    return me["id"] == elder["id"] or store.sharing(elder["id"]).get(category, True)


def not_shared(elder: dict[str, Any], category: str) -> dict[str, Any]:
    return {
        "speech": f"{elder['short_name']} has chosen not to share {category} with the circle right now.",
        "not_shared": category,
    }


def person_ref(p: dict[str, Any]) -> dict[str, str]:
    return {"id": p["id"], "name": p["name"], "short_name": p["short_name"]}


def speak_list(items: list[str]) -> str:
    items = [i for i in items if i]
    if len(items) <= 1:
        return "".join(items)
    return ", ".join(items[:-1]) + " and " + items[-1]


async def in_thread(fn, *args):
    return await anyio.to_thread.run_sync(lambda: fn(*args))


# ---------------------------------------------------------------------------
# MCP Apps views (ui:// resources rendered on Echo Show screens)
# ---------------------------------------------------------------------------
class LiveHtml(Resource):
    """A ui:// resource read from disk on every request, so views can be edited live."""

    path: Path

    async def read(self) -> str:
        if self.path.exists():
            return self.path.read_text(encoding="utf-8")
        return "<!doctype html><meta charset=utf-8><body style='font:16px system-ui;color:#fff;background:#0b1220'>View missing</body>"


apps = Apps()
for view, title in (("today", "Today"), ("briefing", "Care briefing"), ("visit", "Visit brief"),
                    ("pillcheck", "Pill check"), ("reconcile", "Medication changes")):
    apps.add_resource(LiveHtml(
        uri=f"ui://nova/{view}.html", name=f"nova-{view}", title=title,
        description=f"Nova {title} view for Echo Show style screens",
        path=ROOT / "views" / f"{view}.html",
    ))

mcp = MCPServer(
    name="nova",
    title="Nova Care Circle",
    description="A care circle for Alexa+: medications, check-ins, family messages and doctor-visit prep.",
    instructions=INSTRUCTIONS,
    website_url="https://github.com/Dakshhhhh-ops/nova",
    icons=[NOVA_ICON],
    version="0.1.0",
    token_verifier=CircleTokenVerifier(),
    auth=AuthSettings(
        issuer_url=os.getenv("NOVA_AUTH_ISSUER", PUBLIC_URL),
        resource_server_url=f"{PUBLIC_URL}/mcp",
        required_scopes=["nova.care"],
        validate_token_resource=True,
    ),
    extensions=[apps],
)

def ui_tool(resource_uri: str, visibility: tuple[str, ...] = ("model", "app"), **kwargs: Any):
    """Register a tool bound to an MCP Apps view (`_meta.ui.resourceUri`)."""
    return mcp.tool(meta={"ui": {"resourceUri": resource_uri, "visibility": list(visibility)}}, **kwargs)


READ = ToolAnnotations(read_only_hint=True, destructive_hint=False, idempotent_hint=True, open_world_hint=False)
WRITE = ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=False, open_world_hint=False)
NOTIFY = ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=False, open_world_hint=True)


# ---------------------------------------------------------------------------
# Today
# ---------------------------------------------------------------------------
def build_today(me: dict[str, Any], elder: dict[str, Any]) -> dict[str, Any]:
    t = now()
    self_view = me["id"] == elder["id"]
    out: dict[str, Any] = {
        "person": person_ref(elder),
        "viewer": person_ref(me),
        "date_label": f"{t.strftime('%A, %B')} {t.day}",
        "doses": [],
        "appointments": [],
        "unread_messages": len(store.inbox(me["id"])),
        "next_dose": None,
        "supply": supply_status(elder["id"]) if shared(me, elder, "medications") else [],
        "refills": [{"name": r["name"], "status": r["status"], "pharmacy": r["pharmacy"]} for r in store.refills(elder["id"])],
    }
    if shared(me, elder, "medications"):
        out["doses"] = ins.doses_for_day(store, elder["id"], t, t)
        nxt = next((d for d in out["doses"] if d["status"] in ("due", "upcoming")), None)
        if nxt:
            out["next_dose"] = {"name": nxt["name"], "time_label": nxt["time_label"], "status": nxt["status"]}
    if shared(me, elder, "appointments"):
        out["appointments"] = [
            {"title": a["title"], "provider": a["provider"], "when_label": ins.when_label(parse(a["at"]), t),
             "at": a["at"], "location": a["location"]}
            for a in store.appointments(elder["id"], t - timedelta(hours=2), t + timedelta(days=3))
        ]

    taken = [d for d in out["doses"] if d["status"] == "taken"]
    due = [d for d in out["doses"] if d["status"] == "due"]
    missed = [d for d in out["doses"] if d["status"] == "missed"]
    upcoming = [d for d in out["doses"] if d["status"] == "upcoming"]
    subject = "You" if self_view else elder["short_name"]
    parts = []
    if due:
        parts.append(f"It's time for {speak_list([d['name'] for d in due])}.")
    if missed:
        listed = speak_list([d["name"] + " from " + d["time_label"] for d in missed])
        parts.append(f"{subject} {'haven' if self_view else 'hasn'}'t logged {listed} yet.")
    if not due and not missed and taken:
        parts.append("You're all caught up on medications." if self_view else f"{subject} is caught up on medications.")
    if upcoming and not due:
        parts.append(f"Next is {upcoming[0]['name']} at {upcoming[0]['time_label']}.")
    if out["appointments"]:
        a = out["appointments"][0]
        first = (a["provider"] or "").split()[0] if a["provider"] else ""
        with_whom = f" with {a['provider']}" if a["provider"] and first not in a["title"] else ""
        parts.append(f"{a['when_label']}: {a['title']}{with_whom}.")
    if out["unread_messages"]:
        n = out["unread_messages"]
        parts.append(f"You have {n} new message{'s' if n > 1 else ''}.")
    out["speech"] = " ".join(parts) or "Nothing is scheduled right now."
    return out


@ui_tool(
    "ui://nova/today.html",
    name="get_today",
    title="Today's plan",
    description=(
        "Today's medication schedule (taken, due, missed, upcoming), the next few appointments and unread messages. "
        "Use for 'what's my day look like', 'what pills do I take now', or a caregiver asking about today's plan."
    ),
    annotations=READ,
    icons=[NOVA_ICON],
)
def get_today() -> dict[str, Any]:
    me = caller()
    return build_today(me, care_recipient(me))


# ---------------------------------------------------------------------------
# Medications
# ---------------------------------------------------------------------------
def match_doses(elder: dict[str, Any], medication: str, time_of_day: str, t) -> list[dict[str, Any]]:
    """Resolve 'my morning pills', 'the pink one', 'blood pressure pill', '8 AM' to today's doses."""
    doses = ins.doses_for_day(store, elder["id"], t, t)
    meds = {m["id"]: m for m in store.medications(elder["id"])}
    filler = {"my", "her", "his", "their", "your", "the", "our", "a", "an", "pill", "pills", "tablet", "tablets",
              "medicine", "medicines", "meds", "medication", "medications", "dose", "doses", "one", "all", "everything",
              "morning", "evening", "night", "bedtime", "dinner", "breakfast", "tonight", "today",
              "it", "them", "those", "these", "yes", "i"}
    q = " ".join(w for w in (medication or "").lower().replace("?", "").split() if w not in filler).strip()
    tod = (time_of_day or "").lower().strip()
    if not tod:
        tod = next((w for w in ("morning", "evening", "bedtime", "night", "dinner", "breakfast", "tonight")
                    if w in (medication or "").lower()), "")

    def med_matches(d: dict[str, Any]) -> bool:
        if not q:
            return True
        m = meds[d["med_id"]]
        hay = " ".join([m["id"], m["name"], m["purpose"] or "", m["appearance"] or ""]).lower()
        words = [w for w in q.replace("pill", "").replace("the ", "").replace("my ", "").split() if len(w) > 2 and w not in ("one", "tablet")]
        return q in hay or (bool(words) and all(w in hay for w in words)) or (bool(words) and any(w in m["name"].lower() for w in words))

    def time_matches(d: dict[str, Any]) -> bool:
        if not tod:
            return True
        at = parse(d["scheduled_for"])
        if "morn" in tod or "breakfast" in tod:
            return at.hour < 12
        if any(w in tod for w in ("even", "dinner", "night", "bed", "supper", "tonight")):
            return at.hour >= 17
        if "after" in tod or "lunch" in tod or "noon" in tod:
            return 12 <= at.hour < 17
        if re.search(r"\d", tod):
            return tod.replace(" ", "") in d["time_label"].lower().replace(" ", "")
        return True  # "today", "now", etc.

    cands = [d for d in doses if med_matches(d) and time_matches(d)]
    if not tod and cands:
        # No time given: pick the dose closest to now for each medication.
        best: dict[str, dict[str, Any]] = {}
        for d in cands:
            cur = best.get(d["med_id"])
            dist = abs((parse(d["scheduled_for"]) - t).total_seconds())
            if not cur or dist < abs((parse(cur["scheduled_for"]) - t).total_seconds()):
                best[d["med_id"]] = d
        cands = list(best.values())
        if not q:
            # "I took my pills": only the doses in the slot closest to now.
            closest = min(cands, key=lambda d: abs((parse(d["scheduled_for"]) - t).total_seconds()))
            slot = ins.slot_of(parse(closest["scheduled_for"]))
            cands = [d for d in cands if ins.slot_of(parse(d["scheduled_for"])) == slot]
    return sorted(cands, key=lambda d: d["scheduled_for"])


@mcp.tool(
    name="log_medication",
    title="Log a dose",
    description=(
        "Record that a medication dose was taken (or skipped). Understands names, purposes and how pills look "
        "('my blood pressure pill', 'the pink one', 'my morning pills'). Guards against double doses: if the dose "
        "was already logged it says so instead of logging again. Caregivers can log on the elder's behalf."
    ),
    annotations=WRITE,
)
async def log_medication(
    medication: Annotated[str, Field(description="Medication name, purpose, or description; empty means all doses due now")] = "",
    time_of_day: Annotated[str, Field(description="morning, evening, bedtime, or a time like '8 AM'; empty means now")] = "",
    status: Annotated[Literal["taken", "skipped"], Field(description="taken or skipped")] = "taken",
) -> dict[str, Any]:
    me = caller()
    elder = care_recipient(me)
    t = now()
    doses = match_doses(elder, medication, time_of_day, t)
    if not doses:
        names = speak_list([m["name"] for m in store.medications(elder["id"])])
        return {"speech": f"I couldn't match that to a dose today. The medications on file are {names}.",
                "logged": [], "already_taken": [], "warning": None}
    already = [d for d in doses if d["status"] == "taken"]
    to_log = [d for d in doses if d["status"] != "taken" and parse(d["scheduled_for"]) <= t + timedelta(hours=3)]
    future = [d for d in doses if d["status"] != "taken" and parse(d["scheduled_for"]) > t + timedelta(hours=3)]
    low_supply = []
    for d in to_log:
        store.log_dose(d["med_id"], parse(d["scheduled_for"]), status, me["id"])
        if status == "taken":
            left = store.use_supply(d["med_id"])
            if left is not None and left <= 8:
                low_supply.append((d["name"], left))
    warning = None
    parts = []
    if to_log:
        verb = "taken" if status == "taken" else "skipped"
        who = "" if me["id"] == elder["id"] else f" for {elder['short_name']}"
        parts.append(f"Got it, I've logged {speak_list([d['name'] for d in to_log])} as {verb}{who}.")
    if already:
        when = speak_list([f"{d['name']} at {ins.time_label(parse(d['logged_at']))}" for d in already])
        warning = "double_dose_risk" if not to_log else None
        if not to_log:
            parts.append(f"You already took {when}, so please don't take another one." if me["id"] == elder["id"]
                         else f"{elder['short_name']} already logged {when}.")
        else:
            parts.append(f"{speak_list([d['name'] for d in already])} {'was' if len(already) == 1 else 'were'} already logged earlier.")
    if future and not to_log and not already:
        parts.append(f"{speak_list([d['name'] for d in future])} isn't due until {future[0]['time_label']}.")
    food = [d for d in to_log if d.get("with_food")]
    if food and status == "taken" and me["id"] == elder["id"]:
        parts.append(f"Remember, {food[0]['name']} goes down best with food.")
    nxt = next((d for d in ins.doses_for_day(store, elder["id"], t, t) if d["status"] in ("upcoming",)), None)
    if nxt and to_log:
        parts.append(f"Next up is {nxt['name']} at {nxt['time_label']}.")
    if low_supply and not any(r["name"] == low_supply[0][0] for r in store.refills(elder["id"])):
        name, left = low_supply[0]
        parts.append(f"You have {left} {name} left. Say 'order a refill' and I'll send it to the pharmacy."
                     if me["id"] == elder["id"] else f"{elder['short_name']} has {left} {name} left.")
    return {
        "speech": " ".join(parts),
        "low_supply": [{"name": n, "left": left} for n, left in low_supply],
        "logged": [{**d, "status": status} for d in to_log],
        "already_taken": already,
        "warning": warning,
    }


@mcp.tool(
    name="check_medication",
    title="Check medications",
    description=(
        "Answer 'did I take my evening pills?', 'what is the pink pill for?', 'when do I take metformin?'. "
        "Returns today's matching doses with status, plus what each medication is for and how to take it."
    ),
    annotations=READ,
)
def check_medication(
    medication: Annotated[str, Field(description="Medication name, purpose or description; empty for all")] = "",
    time_of_day: Annotated[str, Field(description="morning, evening, bedtime or a time; empty for any")] = "",
) -> dict[str, Any]:
    me = caller()
    elder = care_recipient(me)
    if not shared(me, elder, "medications"):
        return not_shared(elder, "medications")
    t = now()
    doses = match_doses(elder, medication, time_of_day, t) if (medication or time_of_day) else ins.doses_for_day(store, elder["id"], t, t)
    meds = {m["id"]: m for m in store.medications(elder["id"])}
    info = [
        {"name": m["name"], "dose": m["dose"], "purpose": m["purpose"], "appearance": m["appearance"],
         "times": [ins.time_label(parse(f"2000-01-01T{x}:00")) for x in m["times"]], "instructions": m["instructions"],
         "recent_change": m["change_note"]}
        for m in meds.values() if any(d["med_id"] == m["id"] for d in doses)
    ]
    self_view = me["id"] == elder["id"]
    subj = "You" if self_view else elder["short_name"]
    taken = [d for d in doses if d["status"] == "taken"]
    open_ = [d for d in doses if d["status"] in ("missed", "due")]
    parts = []
    asking_info = any(w in (medication or "").lower() for w in ("pink", "white", "yellow", "for", "what"))
    if len(info) == 1 and (asking_info or not time_of_day):
        m = info[0]
        parts.append(f"That's {m['name']} {m['dose']}, for {m['purpose']}, taken at {speak_list(m['times'])}.")
    if taken:
        parts.append(f"{subj} took {speak_list([d['name'] + ' at ' + ins.time_label(parse(d['logged_at'])) for d in taken])}.")
    if open_:
        parts.append(f"{speak_list([d['name'] + ' (' + d['time_label'] + ')' for d in open_])} "
                     f"{'is' if len(open_) == 1 else 'are'} not logged yet.")
    if not taken and not open_ and doses:
        parts.append(f"Nothing is due yet. {doses[0]['name']} is at {doses[0]['time_label']}.")
    return {"speech": " ".join(parts) or "I couldn't find that medication.", "doses": doses, "info": info}


# ---------------------------------------------------------------------------
# Check-ins
# ---------------------------------------------------------------------------
class NotifyConsent(BaseModel):
    notify: bool = Field(description="Let your care circle know?")


CONCERNING = ("dizziness", "swelling", "confusion", "shortness of breath")


def primary_caregiver() -> dict[str, Any] | None:
    caregivers = store.caregivers()
    return next((p for p in caregivers if p["relation"] == "daughter"), caregivers[0] if caregivers else None)


def ask_before_sharing(how_are_you_feeling: str):
    """Resolver: ask the elder before the circle hears about a concerning symptom.

    Runs before the tool body. Returning `Elicit` makes the SDK ask the user: an
    `InputRequiredResult` round trip on 2026-07-28 connections, or a standard
    `elicitation/create` request on 2025-11-25 connections (Alexa+). It must be
    deterministic, because it re-runs on every round.
    """
    me = caller()
    if me["role"] != "elder" or ins.red_flags(how_are_you_feeling):
        return None  # caregivers don't need consent; emergencies don't wait for it
    fams = [f for f in (ins.symptom_family(how_are_you_feeling),) if f in CONCERNING]
    if not fams or not store.sharing(me["id"]).get("wellbeing", True):
        return None
    names = [p["short_name"] for p in store.caregivers()][:2]
    return Elicit(
        f"Would you like me to let {speak_list(names) or 'your family'} know you're feeling {ins.feeling(fams[0])}?",
        NotifyConsent,
    )


@mcp.tool(
    name="daily_checkin",
    title="Daily check-in",
    description=(
        "Record how the person feels in their own words ('I slept badly and I'm a bit dizzy'). Nova extracts mood, "
        "pain, sleep, symptoms and activities, checks for red flags, and asks before telling the family about "
        "anything concerning. Call this whenever the elder describes how they feel."
    ),
    annotations=WRITE,
)
async def daily_checkin(
    how_are_you_feeling: Annotated[str, Field(description="What the person said about how they feel, verbatim")],
    consent: Annotated[ElicitationResult[NotifyConsent], Resolve(ask_before_sharing)],
) -> dict[str, Any]:
    me = caller()
    elder = care_recipient(me)
    if me["id"] != elder["id"]:
        store.add_message(me["id"], "circle", f"Observation about {elder['short_name']}: {how_are_you_feeling}")
        return {"speech": "Thanks, I've shared that observation with the circle.", "checkin": None,
                "red_flags": [], "shared_with": [], "alert_id": None}
    data = await in_thread(ins.extract_checkin, how_are_you_feeling, elder["short_name"])
    data["utterance"] = how_are_you_feeling
    store.add_checkin(elder["id"], data)
    flags = ins.red_flags(how_are_you_feeling)
    names = [p["short_name"] for p in store.caregivers()]
    alert_id = None
    shared_with: list[str] = []
    if flags:
        alert_id = store.add_alert(elder["id"], "urgent", "red-flag",
                                   f"{elder['short_name']} reported: “{how_are_you_feeling}” ({', '.join(flags)})")
        store.add_message(elder["id"], "circle", f"URGENT from Nova: {elder['short_name']} said “{how_are_you_feeling}”.", urgent=True)
        speech = (f"That sounds serious, {elder['short_name']}. I've alerted {speak_list(names[:2])} right away. "
                  "If you're hurt or it's getting worse, please call 911.")
        return {"speech": speech, "checkin": data, "red_flags": flags, "shared_with": names, "alert_id": alert_id}

    reply = _sentence(data.get("reply") or "Thank you, I've noted that.")
    speech = reply
    symptom = ins.symptom_family(how_are_you_feeling)
    nothing_asked = isinstance(consent, AcceptedElicitation) and consent.data is None
    if not nothing_asked:
        yes = isinstance(consent, AcceptedElicitation) and bool(getattr(consent.data, "notify", False))
        if yes:
            store.add_message(elder["id"], "circle",
                              f"Hi, it's Nova for {elder['short_name']}: she's feeling {ins.feeling(symptom)} today and asked me to let you know.")
            alert_id = store.add_alert(elder["id"], "watch", "checkin-symptom",
                                       f"{elder['short_name']} reported {symptom} and asked Nova to tell the circle.")
            shared_with = names
            speech = f"{reply} I've let {speak_list(names[:2])} know."
        else:
            speech = f"{reply} I'll keep it between us for now."
    if symptom == "dizziness":
        speech += " Please stand up slowly."
    if symptom in CONCERNING:
        note = next((n for n in store.care_notes(elder["id"]) if symptom[:5] in n["text"].lower() and "call" in n["text"].lower()), None)
        if note:
            doctor = note["source"].split("·")[-1].strip().replace("Dr. Anika ", "Dr. ")
            speech += f" {doctor} asked to hear about {symptom}, so it's worth a call to the office."
    return {"speech": speech, "checkin": data, "red_flags": [], "shared_with": shared_with, "alert_id": alert_id}


def _sentence(text: str) -> str:
    text = text.strip()
    return text[:1].upper() + text[1:] if text else text


# ---------------------------------------------------------------------------
# Messages
# ---------------------------------------------------------------------------
@mcp.tool(
    name="send_message",
    title="Message the circle",
    description="Send a short message to one person in the care circle or to everyone ('circle').",
    annotations=NOTIFY,
)
def send_message(
    to: Annotated[str, Field(description="A name, relation ('my daughter', 'Mom') or 'circle' for everyone")],
    message: Annotated[str, Field(description="The message, in the sender's words")],
    urgent: Annotated[bool, Field(description="True only if the sender says it's urgent")] = False,
) -> dict[str, Any]:
    me = caller()
    target = (to or "").lower().strip()
    if target in ("circle", "everyone", "everybody", "family", "the family", "all", "the circle"):
        recipients = [p for p in store.people() if p["id"] != me["id"]]
        store.add_message(me["id"], "circle", message, urgent)
    else:
        p = store.find_person(target)
        if p is None and target in ("mom", "mum", "mother", "grandma", "my mom"):
            p = store.elders()[0] if store.elders() else None
        if p is None:
            names = speak_list([x["short_name"] for x in store.people() if x["id"] != me["id"]])
            return {"speech": f"I couldn't find {to} in the circle. I can message {names}, or everyone.", "delivered_to": []}
        recipients = [p]
        store.add_message(me["id"], p["id"], message, urgent)
    for r in recipients:
        store.announce(r["id"], "message", f"Message from {me['short_name']}",
                       f"Message from {me['short_name']}: {message}", severity="urgent" if urgent else "info",
                       related={"from": me["id"]})
    names = [r["short_name"] for r in recipients]
    return {"speech": f"Sent to {speak_list(names) if len(names) < 4 else 'everyone in the circle'}.", "delivered_to": names}


@mcp.tool(
    name="read_messages",
    title="Read messages",
    description="Read the caller's unread messages from the care circle, oldest first, and mark them read.",
    annotations=WRITE,
)
def read_messages() -> dict[str, Any]:
    me = caller()
    msgs = store.inbox(me["id"])
    if not msgs:
        return {"speech": "No new messages.", "messages": []}
    store.mark_read([m["id"] for m in msgs], me["id"])
    t = now()
    out = [{"from": m["from_short"], "text": m["body"], "when_label": ins.when_label(parse(m["at"]), t), "urgent": bool(m["urgent"])} for m in msgs]
    spoken = " ".join(f"From {m['from']}: {m['text']}" for m in out[:3])
    more = f" And {len(out) - 3} more on screen." if len(out) > 3 else ""
    return {"speech": f"You have {len(out)} new message{'s' if len(out) > 1 else ''}. {spoken}{more}", "messages": out}


# ---------------------------------------------------------------------------
# Care notes, help, alerts
# ---------------------------------------------------------------------------
@mcp.tool(
    name="ask_care_notes",
    title="Ask the care notes",
    description=(
        "Answer questions from what the doctors and care team actually wrote (visit summaries, discharge "
        "instructions, dietitian notes, emergency info). 'What did the doctor say about salt?', 'Can I take ibuprofen?'"
    ),
    annotations=READ,
)
async def ask_care_notes(question: Annotated[str, Field(description="The question, in the user's words")]) -> dict[str, Any]:
    me = caller()
    elder = care_recipient(me)
    result = await in_thread(ins.answer_from_notes, question, store.care_notes(elder["id"]), elder["short_name"])
    return {"speech": result["answer"], **result}


@mcp.tool(
    name="get_help",
    title="Get help now",
    description=(
        "Immediately alert everyone in the care circle that the elder needs help. Use for falls, feeling very "
        "unwell, or any request for help. Does not call emergency services."
    ),
    annotations=NOTIFY,
)
def get_help(reason: Annotated[str, Field(description="What's happening, in the person's words")] = "") -> dict[str, Any]:
    me = caller()
    elder = care_recipient(me)
    msg = f"{elder['short_name']} asked for help" + (f": “{reason}”" if reason else ".")
    alert_id = store.add_alert(elder["id"], "urgent", "help-request", msg)
    store.add_message(me["id"], "circle", f"URGENT from Nova: {msg}", urgent=True)
    names = [p["short_name"] for p in store.caregivers()]
    return {
        "speech": f"I've alerted {speak_list(names)}. If this is an emergency, please call 911.",
        "alerted": names, "alert_id": alert_id,
    }


@mcp.tool(
    name="list_alerts",
    title="Open alerts",
    description="Open alerts for the care recipient, most severe first (caregivers).",
    annotations=READ,
)
def list_alerts() -> dict[str, Any]:
    me = caller()
    elder = care_recipient(me)
    found = ins.detect_insights(store, elder["id"])
    ins.sync_alerts(store, elder["id"], found)
    alerts = store.alerts(elder["id"])
    if not alerts:
        return {"speech": "There are no open alerts.", "alerts": []}
    top = alerts[0]
    return {
        "speech": f"There {'is' if len(alerts) == 1 else 'are'} {len(alerts)} open alert{'s' if len(alerts) > 1 else ''}. The top one: {top['message']}",
        "alerts": alerts,
    }


@mcp.tool(
    name="resolve_alert",
    title="Mark alert handled",
    description="Mark an alert as handled, with an optional note the circle will see.",
    annotations=ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=True, open_world_hint=False),
)
def resolve_alert(
    alert_id: Annotated[int, Field(description="The alert id")],
    note: Annotated[str, Field(description="What was done, e.g. 'Called Dr. Patel's office'")] = "",
) -> dict[str, Any]:
    me = caller()
    a = store.handle_alert(alert_id, me["id"])
    if not a:
        return {"speech": "I couldn't find that alert.", "alert": None}
    if note:
        store.add_message(me["id"], "circle", f"Handled: {a['message'][:80]}… {note}")
    return {"speech": "Marked as handled. I've let the circle know." if note else "Marked as handled.", "alert": a}


@mcp.tool(
    name="set_sharing",
    title="Privacy: what the circle sees",
    description=(
        "The care recipient decides what their circle can see: medications, wellbeing (mood, pain, symptoms), "
        "appointments, messages. Only the care recipient can change this."
    ),
    annotations=ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=True, open_world_hint=False),
)
def set_sharing(
    category: Annotated[Literal["medications", "wellbeing", "appointments", "messages"], Field(description="What to share or hide")],
    shared_with_circle: Annotated[bool, Field(description="True to share, False to keep private")],
) -> dict[str, Any]:
    me = caller()
    if me["role"] != "elder":
        return {"speech": "Only the person being cared for can change what's shared.", "sharing": None}
    store.set_sharing(me["id"], category, shared_with_circle)
    return {
        "speech": f"Okay. Your {category} {'will be shared with' if shared_with_circle else 'are now private from'} the circle.",
        "sharing": store.sharing(me["id"]),
    }


# ---------------------------------------------------------------------------
# Caregiver briefing and doctor-visit prep (UI-bound)
# ---------------------------------------------------------------------------
def briefing_facts(me: dict[str, Any], elder: dict[str, Any], period: str) -> dict[str, Any]:
    t = now()
    days = 1 if period == "today" else 7
    found = ins.detect_insights(store, elder["id"], t)
    ins.sync_alerts(store, elder["id"], found)
    sharing = store.sharing(elder["id"])
    if not sharing.get("wellbeing", True):
        found = [i for i in found if i["id"] in ("evening-doses", "missed-today")]
    if not sharing.get("medications", True):
        found = [i for i in found if i["id"] not in ("evening-doses", "missed-today")]
    adh = ins.adherence(store, elder["id"], max(days, 7), t) if sharing.get("medications", True) else None
    wb_days = []
    if sharing.get("wellbeing", True):
        for c in store.checkins(elder["id"], t - timedelta(days=10)):
            wb_days.append({"date": ins.short_date(parse(c["at"])), "mood": c["mood"], "pain": c["pain"],
                            "sleep": c["sleep_hours"], "symptoms": c["symptoms"], "said": c["utterance"]})
    trend = "steady"
    if len(wb_days) >= 4:
        moods = [d["mood"] for d in wb_days if d["mood"] is not None]
        if moods and sum(moods[-3:]) / 3 < sum(moods[:-3]) / max(1, len(moods[:-3])) - 0.7:
            trend = "declining"
        elif moods and sum(moods[-3:]) / 3 > sum(moods[:-3]) / max(1, len(moods[:-3])) + 0.7:
            trend = "improving"
    alerts = store.alerts(elder["id"])
    msgs = [
        {"from": m["from_short"], "text": m["body"], "when_label": ins.when_label(parse(m["at"]), t)}
        for m in store.recent_messages(t - timedelta(days=4)) if sharing.get("messages", True) or m["from_id"] == me["id"]
    ][-4:]
    upcoming = [
        {"title": a["title"], "when_label": ins.when_label(parse(a["at"]), t), "provider": a["provider"], "location": a["location"]}
        for a in store.appointments(elder["id"], t, t + timedelta(days=7))
    ] if sharing.get("appointments", True) else []
    bp_days = [{"date": ins.short_date(parse(b["at"])), "systolic": b["systolic"], "diastolic": b["diastolic"]}
               for b in store.bp(elder["id"], t - timedelta(days=14))] if sharing.get("wellbeing", True) else []
    return {
        "insights": found, "adherence": adh, "wellbeing": {"days": wb_days, "trend": trend, "bp": bp_days},
        "alerts": [{"id": a["id"], "severity": a["severity"], "kind": a["kind"], "message": a["message"], "at": a["at"]} for a in alerts],
        "messages": msgs, "upcoming": upcoming,
    }


@ui_tool(
    "ui://nova/briefing.html",
    name="care_briefing",
    title="Care briefing",
    description=(
        "How is the care recipient doing? A caregiver briefing: overall status, medication adherence, mood/pain/sleep "
        "trends, insights that connect the dots (e.g. a new symptom after a dose change, with evidence), open alerts, "
        "upcoming appointments and recent circle messages. Use for 'how's Mom doing?', 'anything I should know?'."
    ),
    annotations=READ,
    icons=[NOVA_ICON],
)
async def care_briefing(
    period: Annotated[Literal["today", "week"], Field(description="today or week")] = "week",
    person: Annotated[str, Field(description="Who the briefing is about, if the circle has more than one elder")] = "",
) -> dict[str, Any]:
    me = caller()
    elder = care_recipient(me, person)
    facts = briefing_facts(me, elder, period)
    status = ins.overall_status(facts["insights"], facts["alerts"])
    rel = (me.get("relation") or "family").split("/")[0]
    narrative = await in_thread(ins.narrate_briefing, {
        "viewer": me["short_name"], "relation": rel, "name": elder["short_name"], "period": period,
        "facts": {k: facts[k] for k in ("insights", "adherence", "upcoming", "alerts", "messages")},
    })
    return {
        "speech": narrative["speech"],
        "headline": narrative["headline"],
        "status": status,
        "person": person_ref(elder),
        "period": period,
        "generated_by": ins.generated_by(),
        **facts,
    }


@ui_tool(
    "ui://nova/visit.html",
    name="prepare_visit",
    title="Doctor visit brief",
    description=(
        "Prepare a one-page brief for the next doctor's appointment: what changed since the last visit, medication "
        "adherence, symptoms with first-seen dates, and specific questions to ask. Works for the elder and caregivers."
    ),
    annotations=READ,
    icons=[NOVA_ICON],
)
async def prepare_visit(
    appointment: Annotated[str, Field(description="Which appointment (e.g. 'cardiology', 'Dr. Patel'); empty for the next medical one")] = "",
) -> dict[str, Any]:
    me = caller()
    elder = care_recipient(me)
    t = now()
    appts = [a for a in store.appointments(elder["id"], t, t + timedelta(days=60)) if "visit" not in a["title"].lower() or "doctor" in a["title"].lower()]
    q = appointment.lower().strip()
    appt = next((a for a in appts if q and (q in a["title"].lower() or q in (a["provider"] or "").lower())), None) or (appts[0] if appts else None)
    if not appt:
        return {"speech": "I don't see an upcoming doctor's appointment.", "appointment": None}
    adh = ins.adherence(store, elder["id"], 14, t)
    meds = []
    for m in store.medications(elder["id"]):
        by = next((b for b in adh["by_med"] if b["name"] == m["name"]), None)
        changed = ins.short_date(parse(m["changed_on"])) if m.get("changed_on") else None
        meds.append({"name": m["name"], "dose": m["dose"], "adherence_pct": by["pct"] if by else None,
                     "note": f"Changed {changed}: {m['change_note']}" if m.get("change_note") else "",
                     "changed_label": changed, "change_note": m.get("change_note")})
    sym_count: dict[str, dict[str, Any]] = {}
    for c in store.checkins(elder["id"], t - timedelta(days=21)):
        for s in c["symptoms"]:
            fam = ins.symptom_family(s) or s
            e = sym_count.setdefault(fam, {"name": fam, "count": 0, "first": c["at"], "quotes": []})
            e["count"] += 1
            e["quotes"].append(c["utterance"])
    symptoms = sorted(sym_count.values(), key=lambda s: -s["count"])
    symptoms = [{"name": s["name"], "count": s["count"], "first_label": ins.short_date(parse(s["first"])),
                 "note": f"“{s['quotes'][-1]}”" if s["quotes"] else ""} for s in symptoms]
    found = ins.detect_insights(store, elder["id"], t)
    when = ins.when_label(parse(appt["at"]), t)
    facts = {"appointment": appt, "medications": meds, "adherence": adh, "symptoms": symptoms,
             "insights": [{k: i[k] for k in ("title", "detail")} for i in found],
             "circle_observations": [m["body"] for m in store.recent_messages(t - timedelta(days=14)) if m["from_id"] == "grace"]}
    draft = await in_thread(ins.draft_visit_brief, {"name": elder["short_name"], "appointment": f"{appt['title']} with {appt['provider']}, {when}", "facts": facts})
    return {
        "speech": (f"Your brief for {appt['title']} with {appt['provider']} {ins.mid_sentence(when)} is ready. "
                   f"I've included {len(draft['questions'])} questions to ask."
                   if me["id"] == elder["id"] else
                   f"The brief for {elder['short_name']}'s {appt['title'].lower()} {ins.mid_sentence(when)} is ready, with {len(draft['questions'])} questions to ask {appt['provider']}."),
        "appointment": {"title": appt["title"], "provider": appt["provider"], "when_label": when, "location": appt["location"]},
        "summary": draft["summary"],
        "medications": meds,
        "symptoms": symptoms,
        "questions": draft["questions"],
        "bring": draft["bring"],
        "generated_by": ins.generated_by(),
    }


# ---------------------------------------------------------------------------
# Resources and prompts
# ---------------------------------------------------------------------------
@mcp.resource("nova://circle", name="circle", title="Care circle", mime_type="application/json",
              description="People in the care circle, their roles and devices.")
def circle_resource() -> dict[str, Any]:
    return {"people": store.people(), "sharing": {e["id"]: store.sharing(e["id"]) for e in store.elders()}}


@mcp.resource("nova://timeline", name="timeline", title="Circle timeline", mime_type="application/json",
              description="Recent activity in the circle: doses, check-ins, messages, alerts.")
def timeline_resource() -> dict[str, Any]:
    return {"items": timeline(48)}


def timeline(hours: int = 48) -> list[dict[str, Any]]:
    t = now()
    since = t - timedelta(hours=hours)
    names = {p["id"]: p["short_name"] for p in store.people()}
    items: list[dict[str, Any]] = []
    for e in store.q("SELECT e.*, m.name FROM dose_events e JOIN medications m ON m.id = e.med_id WHERE e.logged_at >= ?", (iso(since),)):
        items.append({"at": e["logged_at"], "kind": "dose", "who": names.get(e["logged_by"], ""),
                      "text": f"{e['name']} {e['status']} ({ins.time_label(parse(e['scheduled_for']))} dose)"})
    for elder in store.elders():
        for c in store.checkins(elder["id"], since):
            items.append({"at": c["at"], "kind": "checkin", "who": names.get(c["person_id"], ""), "text": c["utterance"] or c["summary"] or ""})
    for m in store.recent_messages(since):
        to = "everyone" if m["to_id"] == "circle" else names.get(m["to_id"], m["to_id"])
        items.append({"at": m["at"], "kind": "message", "who": m["from_short"], "text": f"→ {to}: {m['body']}",
                      "severity": "urgent" if m["urgent"] else None})
    for a in store.q("SELECT * FROM alerts WHERE at >= ? OR status = 'open'", (iso(since),)):
        items.append({"at": a["at"], "kind": "alert", "who": names.get(a["person_id"], ""), "text": a["message"],
                      "severity": a["severity"], "status": a["status"]})
    for elder in store.elders():
        for sig in store.signals(elder["id"], since):
            items.append({"at": sig["at"], "kind": "ring", "who": "Ring · Front door", "text": sig["text"]})
    for a in store.q("SELECT * FROM announcements WHERE due_at >= ? AND due_at <= ? AND kind IN "
                     "('caregiver_escalation', 'care_plan_change', 'dose_reminder', 'dose_followup', 'wellness_check')",
                     (iso(since), iso(t))):
        items.append({"at": a["due_at"], "kind": "nova", "who": "Nova → " + names.get(a["to_id"], a["to_id"]),
                      "text": a["speech"], "severity": a["severity"] if a["severity"] != "info" else None})
    items.sort(key=lambda i: i["at"], reverse=True)
    return items[:80]


@mcp.prompt(name="morning_checkin", title="Morning check-in",
            description="A gentle morning routine for the care recipient: how they slept, how they feel, today's pills.")
def morning_checkin_prompt() -> list[UserMessage]:
    return [UserMessage(
        "Run a short, warm morning check-in. Ask how I slept and how I'm feeling (one question at a time), "
        "record my answer with daily_checkin, then use get_today to remind me which pills are due now. Keep each turn "
        "to one or two sentences."
    )]


@mcp.prompt(name="caregiver_briefing", title="Caregiver briefing",
            description="What a caregiver needs to know right now, and what to do about it.")
def caregiver_briefing_prompt(period: str = "week") -> list[UserMessage]:
    return [UserMessage(
        f"Use care_briefing for the {period}. Tell me the overall picture in one sentence, then the single most "
        "important thing and the suggested next step. Offer to prepare a visit brief if an appointment is coming up."
    )]


# ---------------------------------------------------------------------------
# Refills
# ---------------------------------------------------------------------------
PHARMACY = "Elm Street Pharmacy"


def supply_status(elder_id: str) -> list[dict[str, Any]]:
    out = []
    for m in store.medications(elder_id):
        if m.get("supply") is None:
            continue
        per_day = max(1, len(m["times"]))
        out.append({"med_id": m["id"], "name": m["name"], "left": m["supply"], "days_left": m["supply"] // per_day})
    return out


@mcp.tool(
    name="request_refill",
    title="Order a refill",
    description=("'Order a refill of my metformin' / 'We're running low'. Sends the refill request to the pharmacy on file "
                 "and tells the circle who can pick it up. Empty medication means whatever is running lowest."),
    annotations=NOTIFY,
)
def request_refill(medication: Annotated[str, Field(description="Which medication; empty for the one running lowest")] = "") -> dict[str, Any]:
    me = caller()
    elder = care_recipient(me)
    supplies = supply_status(elder["id"])
    if medication:
        q = medication.lower()
        pick = next((s for s in supplies if s["name"].lower() in q or q in s["name"].lower()), None)
    else:
        pick = min(supplies, key=lambda s: s["days_left"]) if supplies else None
    if not pick:
        return {"speech": "I couldn't tell which medication to refill.", "refill": None}
    existing = next((r for r in store.refills(elder["id"]) if r["med_id"] == pick["med_id"]), None)
    if existing:
        state = "is ready for pickup" if existing["status"] == "ready" else "was already sent"
        return {"speech": f"The {pick['name']} refill {state} at {PHARMACY}.", "refill": existing}
    t = now()
    rid = store.x("INSERT INTO refills (med_id, person_id, requested_at, requested_by, pharmacy, ready_at) VALUES (?, ?, ?, ?, ?, ?)",
                  (pick["med_id"], elder["id"], iso(t), me["id"], PHARMACY, iso(t + timedelta(hours=2))))
    aide = next((p for p in store.caregivers() if (p.get("relation") or "").startswith("home aide")), None)
    nxt = next((a for a in store.appointments(elder["id"], t, t + timedelta(days=4)) if aide and aide["short_name"] in a["title"]), None)
    pickup = f" {aide['short_name']} can pick it up {ins.mid_sentence(ins.when_label(parse(nxt['at']), t))}." if nxt else ""
    for p in store.caregivers():
        if p["id"] != me["id"]:
            store.announce(p["id"], "info", "Refill ordered",
                           f"{me['short_name']} ordered a {pick['name']} refill for {elder['short_name']} at {PHARMACY}.{pickup}",
                           dedupe=f"refill:{rid}:{p['id']}")
    return {"speech": f"Done. I sent a refill request for {pick['name']} to {PHARMACY}. They usually have it ready in "
                      f"about two hours.{pickup}",
            "refill": {"id": rid, "name": pick["name"], "pharmacy": PHARMACY, "status": "requested"}, "supply": pick}


# ---------------------------------------------------------------------------
# Vitals
# ---------------------------------------------------------------------------
@mcp.tool(
    name="log_vitals",
    title="Log blood pressure",
    description=("Record a blood pressure reading: 'my blood pressure is 118 over 72, pulse 70'. Nova compares it with "
                 "the limits the doctor wrote in the care notes and tells the family if it's out of range."),
    annotations=WRITE,
)
def log_vitals(
    systolic: Annotated[int, Field(description="Top number", ge=50, le=260)],
    diastolic: Annotated[int, Field(description="Bottom number", ge=30, le=160)],
    pulse: Annotated[int | None, Field(description="Pulse, if said")] = None,
    position: Annotated[Literal["sitting", "standing"] | None, Field(description="If said")] = None,
) -> dict[str, Any]:
    me = caller()
    elder = care_recipient(me)
    store.add_bp(elder["id"], systolic, diastolic, pulse, position, me["id"])
    (hi_s, hi_d), (lo_s, lo_d), note = ins.bp_limits(store, elder["id"])
    recent = store.bp(elder["id"], now() - timedelta(days=7))
    prev = recent[-2] if len(recent) >= 2 else None
    reading = f"{systolic} over {diastolic}"
    who = "your" if me["id"] == elder["id"] else f"{elder['short_name']}'s"
    out_of_range = systolic > hi_s or diastolic > hi_d or systolic < lo_s or diastolic < lo_d
    trend = f" Last reading was {prev['systolic']} over {prev['diastolic']}." if prev else ""
    alert_id = None
    if out_of_range:
        direction = "high" if systolic > hi_s or diastolic > hi_d else "low"
        alert_id = store.add_alert(elder["id"], "watch", f"bp-{direction}",
                                   f"{elder['short_name']}'s blood pressure was {systolic}/{diastolic} ({direction}).")
        for p in store.caregivers():
            if p["id"] != me["id"] and not (p.get("relation") or "").startswith("home aide"):
                store.announce(p["id"], "caregiver_escalation", f"Mom's blood pressure is {direction}",
                               f"Mom's blood pressure just read {systolic} over {diastolic}, which is {direction}er than "
                               f"Dr. Patel's limit. Her notes say to call the office.",
                               severity="watch", expects_reply=True, replies=["Call Mom", "Ask Grace to stop by"])
        speech = (f"I've logged {who} blood pressure, {reading}. That's {direction}er than the limit in Dr. Patel's notes, "
                  f"so I've let the family know. If you feel faint, sit down, and call the office." if me["id"] == elder["id"]
                  else f"Logged {reading}. That's out of range, so I've opened an alert.")
    else:
        speech = f"Got it, {reading}.{trend} That's within the range Dr. Patel set."
    return {"speech": speech, "reading": {"systolic": systolic, "diastolic": diastolic, "pulse": pulse},
            "limits": {"high": f"{hi_s}/{hi_d}", "low": f"{lo_s}/{lo_d}", "source": note["source"] if note else None},
            "out_of_range": out_of_range, "alert_id": alert_id,
            "recent": [{"at": b["at"], "bp": f"{b['systolic']}/{b['diastolic']}"} for b in recent[-7:]]}


# ---------------------------------------------------------------------------
# Proactive layer: announcements, snooze, activity
# ---------------------------------------------------------------------------
def public_announcement(a: dict[str, Any]) -> dict[str, Any]:
    return {"id": a["id"], "at": a["due_at"], "to": a["to_id"], "kind": a["kind"], "severity": a["severity"],
            "title": a["title"], "speech": a["speech"], "expects_reply": a["expects_reply"], "replies": a["replies"],
            "status": a["status"], "related": a["related"]}


@mcp.resource("nova://announcements", name="announcements", title="Announcements for this device",
              mime_type="application/json",
              description=("Delivery queue of things Nova wants to say to the caller (reminders, follow-ups, escalations, "
                           "messages). Reading it delivers them: each item is returned once with status 'new'. "
                           "On Alexa+ these map to proactive notifications."))
def announcements_resource() -> dict[str, Any]:
    me = caller()
    due = store.announcements(me["id"], due_by=now(), statuses=("new",))
    for a in due:
        store.set_announcement_status(a["id"], "delivered", me["id"])
    return {"now": iso(now()), "items": [public_announcement(a) for a in reversed(due) if a["speech"]]}


@mcp.tool(
    name="read_notifications",
    title="Read notifications",
    description="'What are my notifications?' Recent things Nova told the caller: reminders, escalations, messages, visitors.",
    annotations=READ,
)
def read_notifications() -> dict[str, Any]:
    me = caller()
    items = [a for a in store.announcements(me["id"], due_by=now(), limit=10)
             if a["status"] != "dismissed" and a["speech"]]
    if not items:
        return {"speech": "You have no notifications.", "items": []}
    spoken = " ".join(a["speech"] for a in items[:3])
    return {"speech": f"You have {len(items)} notification{'s' if len(items) > 1 else ''}. {spoken}",
            "items": [public_announcement(a) for a in items]}


@mcp.tool(
    name="acknowledge_notification",
    title="Acknowledge a notification",
    description="Mark a notification as acknowledged or dismissed (used by device screens).",
    annotations=ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=True, open_world_hint=False),
    meta={"ui": {"visibility": ["app"]}},
)
def acknowledge_notification(
    notification_id: Annotated[int, Field(description="The notification id")],
    action: Annotated[Literal["acknowledged", "dismissed"], Field(description="acknowledged or dismissed")] = "acknowledged",
) -> dict[str, Any]:
    me = caller()
    store.set_announcement_status(notification_id, action, me["id"])
    return {"speech": "Okay.", "id": notification_id, "status": action}


@mcp.tool(
    name="snooze_reminder",
    title="Snooze a reminder",
    description="'Remind me in 10 minutes.' Re-schedules the latest medication reminder for the caller.",
    annotations=WRITE,
)
def snooze_reminder(minutes: Annotated[int, Field(description="Minutes from now", ge=1, le=240)] = 10) -> dict[str, Any]:
    me = caller()
    recent = [a for a in store.announcements(me["id"], due_by=now(), limit=10)
              if a["kind"] in ("dose_reminder", "dose_followup", "caregiver_escalation") and a["speech"]]
    at = now() + timedelta(minutes=minutes)
    if not recent:
        store.announce(me["id"], "info", "Reminder", "Here's the reminder you asked for.", due_at=at)
        return {"speech": f"Okay, I'll remind you in {minutes} minutes.", "at": iso(at)}
    last = recent[0]
    slot = (last["related"] or {}).get("scheduled_for")
    if slot:
        st = parse(slot)
        # Marker so the engine skips the 30-minute follow-up for this dose (the snooze replaces it).
        marker = store.announce(me["id"], "info", "", "", dedupe=f"snoozed:{st.date()}:{st.strftime('%H%M')}")
        if marker:
            store.set_announcement_status(marker, "dismissed", me["id"])
    store.announce(me["id"], "dose_reminder" if last["kind"] == "dose_followup" else last["kind"], last["title"],
                   last["speech"].replace("Just checking", "Here's your reminder"), due_at=at,
                   expects_reply=last["expects_reply"], replies=last["replies"], related=last["related"],
                   dedupe=f"snooze:{last['id']}:{iso(at)}")
    return {"speech": f"Okay, I'll remind you again in {minutes} minutes.", "at": iso(at)}


@mcp.tool(
    name="recent_activity",
    title="Recent activity at home",
    description=("Caregivers: 'When did Mom last open the door?', 'Has Grace been by?'. Front-door events (Ring), "
                 "doses she logged and check-ins over the last hours."),
    annotations=READ,
)
def recent_activity(hours: Annotated[int, Field(description="How far back", ge=1, le=168)] = 24) -> dict[str, Any]:
    me = caller()
    elder = care_recipient(me)
    t = now()
    items = [i for i in timeline(hours) if i["kind"] in ("ring", "dose", "checkin")]
    if not items:
        return {"speech": f"I haven't seen any activity at {elder['short_name']}'s in the last {hours} hours.", "items": []}
    parts = []
    ring = [i for i in items if i["kind"] == "ring"]
    if ring:
        r = ring[0]
        parts.append(f"Last front-door activity: {r['text']}, "
                     f"{ins.mid_sentence(ins.when_label(parse(r['at']), t))}.")
    doses = [i for i in items if i["kind"] == "dose"]
    if doses:
        parts.append(f"Last dose logged: {doses[0]['text']}, {ins.mid_sentence(ins.when_label(parse(doses[0]['at']), t))}.")
    return {"speech": " ".join(parts) or f"{len(items)} events in the last {hours} hours.", "items": items[:20]}


# ---------------------------------------------------------------------------
# Vision (Amazon Nova multimodal): pill check and medication reconciliation
# ---------------------------------------------------------------------------
@ui_tool(
    "ui://nova/pillcheck.html",
    visibility=("app",),
    name="check_pill_photo",
    title="Is this the right pill?",
    description=("Rose shows a pill bottle to the Echo Show camera. Nova reads the label (Amazon Nova multimodal) and "
                 "checks it against her plan: on the list? due now? already taken? does the strength still match?"),
    annotations=READ,
    icons=[NOVA_ICON],
)
async def check_pill_photo(
    image_base64: Annotated[str, Field(description="The photo as base64 or a data URL")],
    mime_type: Annotated[str, Field(description="Image MIME type")] = "image/png",
) -> dict[str, Any]:
    me = caller()
    elder = care_recipient(me)
    data, mime = vision.decode_image(image_base64)
    return await in_thread(vision.check_pill, store, elder, data, mime if image_base64.startswith("data:") else mime_type)


@ui_tool(
    "ui://nova/reconcile.html",
    visibility=("app",),
    name="read_care_document",
    title="Read discharge or visit papers",
    description=("A photo of an after-visit summary or discharge papers. Nova extracts the medication list (Amazon Nova "
                 "multimodal) and reconciles it with the current plan as change / start / stop / continue. Nothing "
                 "changes until someone approves it with apply_care_changes."),
    annotations=READ,
    icons=[NOVA_ICON],
)
async def read_care_document(
    image_base64: Annotated[str, Field(description="The photo as base64 or a data URL")],
    mime_type: Annotated[str, Field(description="Image MIME type")] = "image/png",
) -> dict[str, Any]:
    me = caller()
    elder = care_recipient(me)
    data, mime = vision.decode_image(image_base64)
    return await in_thread(vision.read_document, store, elder, me, data,
                           mime if image_base64.startswith("data:") else mime_type)


@mcp.tool(
    name="apply_care_changes",
    title="Approve medication changes",
    description=("Approve (or discard) a reconciled set of medication changes from read_care_document. Approving "
                 "updates the plan, saves the instructions as a care note and tells Rose in plain words."),
    annotations=ToolAnnotations(read_only_hint=False, destructive_hint=True, idempotent_hint=True, open_world_hint=False),
)
def apply_care_changes(
    change_set_id: Annotated[str, Field(description="The change_set_id from read_care_document")],
    approve: Annotated[bool, Field(description="True to apply, False to discard")] = True,
) -> dict[str, Any]:
    me = caller()
    return vision.apply_change_set(store, change_set_id, me, approve)


# ---------------------------------------------------------------------------
# Plain HTTP routes for operators (not part of MCP)
# ---------------------------------------------------------------------------
@mcp.custom_route("/healthz", methods=["GET"])
async def healthz(_: Request) -> JSONResponse:
    return JSONResponse({"ok": True, "server": "nova", "people": len(store.people())})


@mcp.custom_route("/demo/reset", methods=["POST"])
async def demo_reset(request: Request) -> JSONResponse:
    body = await _json(request)
    if body.get("time"):
        set_clock(body["time"])
    seed(store)
    engine.reset()
    return JSONResponse({"ok": True, "seeded_at": iso(now()), "now": iso(now()), "speed": clock_speed()})


@mcp.custom_route("/demo/clock", methods=["GET", "POST"])
async def demo_clock(request: Request) -> JSONResponse:
    """The household clock. Jumping back in time re-seeds the demo so the history stays consistent."""
    if request.method == "POST":
        body = await _json(request)
        before = now()
        if body.get("time"):
            set_clock(body["time"], body.get("speed"))
            if now() < before:
                seed(store)
            engine.reset()
        elif body.get("speed") is not None:
            set_clock(speed=body["speed"])
    return JSONResponse({"now": iso(now()), "speed": clock_speed()})


@mcp.custom_route("/integrations/ring/events", methods=["POST"])
async def ring_events(request: Request) -> JSONResponse:
    """Webhook for front-door events (Ring). Shared-secret protected; the demo simulates the events."""
    if request.headers.get("x-nova-ring-secret") != RING_SECRET:
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    body = await _json(request)
    kind = str(body.get("kind") or "motion")
    if kind not in ("ding", "motion", "door_open"):
        return JSONResponse({"error": f"unknown kind {kind}"}, status_code=400)
    return JSONResponse(engine.on_ring_event(kind, body.get("who")))


async def _json(request: Request) -> dict[str, Any]:
    try:
        data = await request.json()
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def set_stdio_user(person_id: str) -> None:
    global _STDIO_USER
    _STDIO_USER = person_id


__all__ = ["mcp", "store", "engine", "timeline", "set_stdio_user", "SHARING_CATEGORIES", "DB_PATH"]
