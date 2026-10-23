"""Offline brain for the simulator.

When neither Amazon Bedrock nor a local model is reachable, this keyword
router picks the Nova tool and speaks the tool's `speech` line. It keeps the
demo and the tests deterministic. It is deliberately simple: the real
conversation comes from Amazon Nova.
"""

from __future__ import annotations

import re
import uuid
from typing import Any

from nova_server.llm import Backend, Step

TOD = r"(morning|evening|night|bedtime|dinner|breakfast|\d{1,2}(?::\d{2})?\s*(?:am|pm))"


def _call(name: str, **args: Any) -> dict[str, Any]:
    return {"id": f"rule_{uuid.uuid4().hex[:8]}", "name": name, "args": args}


def _tod(text: str) -> str:
    m = re.search(TOD, text)
    return m.group(1) if m else ""


def _med_phrase(text: str) -> str:
    m = re.search(r"(?:took|taken|had|take|skipped|skip|about) (?:my |the |our )?(.+?)(?: pills?| tablets?| medicine| meds)?(?: this| just| now| already|$|\.|,| at | for )", text)
    phrase = m.group(1).strip() if m else ""
    phrase = re.sub(TOD, "", phrase).strip()
    if phrase in ("", "pill", "pills", "medicine", "meds", "medication", "medications", "evening", "morning"):
        return ""
    return phrase


def route(text: str, role: str, history: list[dict[str, Any]] | None = None) -> dict[str, Any] | None:
    t = text.lower().strip()
    for message in reversed(history or []):
        if message.get("name") == "confirm_visit":
            break
        if message.get("visit_signal_id"):
            expected = re.escape(message.get("expected_who") or "")
            if re.fullmatch(rf"(?:yes[, ]+)?it['’]?s {expected}[.!]?", t):
                return _call("confirm_visit", signal_id=message["visit_signal_id"], confirmed=True)
            if re.fullmatch(r"it['’]?s someone else[.!]?", t):
                return _call("confirm_visit", signal_id=message["visit_signal_id"], confirmed=False)
            break
    if re.search(r"what (should|do|can) i take (now|today|tonight)|which pills|what pills (now|today)|what('s| is) due", t):
        return _call("get_today")
    if re.search(r"appointment|doctor'?s? visit|see (the )?doctor|who'?s coming|anyone coming|coming (today|tomorrow|this week)", t) \
            and not re.search(r"brief|prepare|get ready", t):
        return _call("list_appointments", days=14)
    if re.search(r"blood pressure|\bbp\b", t) and not re.search(r"\d{2,3}\s*(over|/)\s*\d{2,3}", t):
        return _call("get_vitals", days=7)
    if role != "elder" and re.search(r"i['’]?ll handle (this|it)|i will handle (this|it)|claim (this|the) (alert|task)", t):
        return _call("update_care_task", alert_id=0, action="claim")
    if role != "elder" and re.search(r"^record (?:an? )?action[: ]|^i called (the )?(doctor|office|rose|mom)", t):
        return _call("update_care_task", alert_id=0, action="record_action", note=text)
    if role != "elder" and re.search(r"(mark|resolve|clear).*(alert|handled)|i'?ve? handled it", t):
        return _call("resolve_alert", alert_id=0, note=text if re.search(r"called", t) else "")
    m = re.search(r"(\d{2,3})\s*(?:over|/)\s*(\d{2,3})", t)
    if m:
        p = re.search(r"pulse (?:is |of )?(\d{2,3})", t)
        args = {"systolic": int(m.group(1)), "diastolic": int(m.group(2))}
        if p:
            args["pulse"] = int(p.group(1))
        return _call("log_vitals", **args)
    m = re.search(r"remind me (?:again )?in (\d+)", t)
    if m or re.search(r"remind me later|snooze", t):
        return _call("snooze_reminder", minutes=int(m.group(1)) if m else 10)
    if re.search(r"approve|apply (the )?changes|update (mom'?s |her |the )?plan|yes,? update", t):
        cs = _latest_change_set(history or [])
        if cs:
            return _call("apply_care_changes", change_set_id=cs, approve=True)
    if re.search(r"discard|don'?t update|keep the old plan", t):
        cs = _latest_change_set(history or [])
        if cs:
            return _call("apply_care_changes", change_set_id=cs, approve=False)
    if re.search(r"refill|running (low|out)|order more|more (pills|medicine)", t) and not re.search(r"not now", t):
        m = re.search(r"(lisinopril|metformin|atorvastatin|vitamin d)", t)
        return _call("request_refill", medication=m.group(1) if m else "")
    if re.search(r"visit checklist|what should i (do|check)|anything to do (at|for) (mom|rose)|before my visit", t):
        return _call("visit_checklist")
    if re.search(r"notifications?\b", t):
        return _call("read_notifications")
    if role != "elder" and re.search(r"remind (mom|her) again", t):
        return _call("send_message", to="Mom", message="Maya asked me to remind you to take your medicines. Love you!")
    m = re.search(r"\bask (grace|leo|maya) to (.+)", text, flags=re.I)
    if m:
        return _call("send_message", to=m.group(1), message=f"Could you {m.group(2).rstrip('.')}?")
    if role != "elder" and re.search(r"last (open|opened)|front door|been by|come by|came by|activity|has grace|"
                                     r"did grace|visited|leave the house|left the house|went out|go out|been out", t):
        return _call("recent_activity", hours=24)
    if re.search(r"\bhelp me\b|call for help|i need help|emergency", t):
        return _call("get_help", reason=text)
    if re.search(r"i (fell|have fallen|fall)|chest pain|can't breathe|fainted|passed out", t):
        return _call("daily_checkin", how_are_you_feeling=text)
    if re.search(r"stop sharing|keep .* private|don't share|do not share", t):
        cat = next((c for c in ("medications", "wellbeing", "appointments", "messages") if c[:5] in t), "wellbeing")
        if re.search(r"mood|feel|symptom|health", t):
            cat = "wellbeing"
        return _call("set_sharing", category=cat, shared_with_circle=False)
    if re.search(r"start sharing|share my", t):
        cat = next((c for c in ("medications", "wellbeing", "appointments", "messages") if c[:5] in t), "wellbeing")
        return _call("set_sharing", category=cat, shared_with_circle=True)
    if re.search(r"(brief|prepare|get ready).*(visit|appointment|doctor|cardio)|visit brief", t):
        m = re.search(r"(cardio\w*|eye|dr\.? \w+)", t)
        return _call("prepare_visit", appointment=m.group(1) if m else "")
    if re.search(r"\b(tell|message|text|let) (\w+)|send (a )?message", t) and not re.search(r"messages\b", t):
        m = re.search(r"\b(?:tell|message|text) (my \w+|\w+)(?: that)?[,:]? (.+)", text, flags=re.I)
        if m:
            return _call("send_message", to=m.group(1), message=m.group(2).strip().rstrip("."))
        m = re.search(r"\blet (my \w+|\w+) know (?:that )?(.+)", text, flags=re.I)
        if m:
            return _call("send_message", to=m.group(1), message=m.group(2).strip().rstrip("."))
    if re.search(r"(any|new|read|my|check) messages|messages for me|anything from", t):
        return _call("read_messages")
    if re.search(r"alert", t) and re.search(r"handled|resolve|done|clear", t):
        return _call("list_alerts", include_resolved=True)
    if re.search(r"alert", t):
        return _call("list_alerts")
    if role != "elder" and re.search(r"how('s| is| are| was)|doing|briefing|update|anything i should know|week|"
                                     r"is (mom|she|rose) (ok|okay|alright|all right|fine)|going on with|what'?s up with", t):
        return _call("care_briefing", period="today" if "today" in t else "week")
    if re.search(r"did (i|she|he|mom|rose) take|have (i|you) taken|has (she|mom|rose) taken|what('s| is) the .*(pill|for)|when do i take|what is .* for", t):
        return _call("check_medication", medication=_med_phrase(t.replace("did i take", "took").replace("did mom take", "took")), time_of_day=_tod(t))
    if re.search(r"\b(took|taken|just had|had my|skipped|skip)\b", t) and not re.search(r"\bnot yet\b", t):
        return _call("log_medication", medication=_med_phrase(t), time_of_day=_tod(t),
                     status="skipped" if "skip" in t else "taken")
    if re.search(r"doctor (say|said)|can i (take|have|eat)|should i|allowed|instructions|what did .* say|how much salt|pharmacy|allerg", t):
        return _call("ask_care_notes", question=text)
    if role == "elder" and re.search(r"\bfeel|feeling|slept|sleep|tired|dizzy|woozy|pain|hurts|ache|mood|lonely|sad|great day|good day|bad day|i'?m fine|resting", t):
        return _call("daily_checkin", how_are_you_feeling=text)
    if re.search(r"today|schedule|what('s| is) next|my day|pills (now|today)|what do i take", t):
        return _call("get_today")
    return None


def _latest_change_set(history: list[dict[str, Any]]) -> str | None:
    for m in reversed(history):
        if m["role"] == "tool" and isinstance(m.get("result"), dict) and m["result"].get("change_set_id"):
            return m["result"]["change_set_id"]
    return None


class RulesBrain(Backend):
    name = "rules"

    @property
    def label(self) -> str:  # type: ignore[override]
        from nova_server.llm import bedrock_note

        note = bedrock_note()
        return f"Nova offline router ({note})" if note else "Nova offline router (no model)"

    def __init__(self, role: str) -> None:
        self.role = role

    def available(self) -> bool:
        return True

    def step(self, system: str, history: list[dict[str, Any]], tools: list[dict[str, Any]]) -> Step:
        # After tool results: speak their `speech` lines.
        speeches = []
        for m in reversed(history):
            if m["role"] == "user":
                break
            if m["role"] == "tool":
                r = m["result"]
                speeches.append(r.get("speech") if isinstance(r, dict) else str(r))
        if speeches:
            return Step(text=" ".join(s for s in reversed(speeches) if s))
        user = next((m["text"] for m in reversed(history) if m["role"] == "user"), "")
        call = route(user, self.role, history)
        if call:
            return Step(tool_calls=[call])
        low = user.lower().strip(" .!?")
        if re.fullmatch(r"(yes|yeah|sure|ok(ay)?|please|yes please|please do|do it)", low):
            last = next((m.get("text", "") for m in reversed(history[:-1]) if m["role"] == "assistant" and m.get("text")), "")
            if "prepare a brief" in last.lower() or "visit brief" in last.lower():
                return Step(tool_calls=[_call("prepare_visit", appointment="")])
            if "order a refill" in last.lower() or "refill" in last.lower():
                return Step(tool_calls=[_call("request_refill", medication="")])
        name = "Rose" if self.role == "elder" else ""
        if re.fullmatch(r"(thank you|thanks|thank you so much|thanks alexa|thank you alexa)( alexa)?", low):
            return Step(text=f"You're welcome{', ' + name if name else ''}.")
        if re.fullmatch(r"good night|goodnight|night night", low):
            return Step(text=f"Good night{', ' + name if name else ''}. Sleep well. I'm here if you need anything.")
        if re.fullmatch(r"good morning|morning", low):
            return Step(text=f"Good morning{', ' + name if name else ''}! How did you sleep?" if name
                        else "Good morning! Ask me how Mom is doing whenever you like.")
        if re.search(r"what time is it|what'?s the time", low):
            from .agent import HOUSEHOLD, household_now
            t = HOUSEHOLD["now"] or household_now()
            return Step(text=f"It's {t.strftime('%I:%M %p').lstrip('0')}.")
        if re.search(r"^call (mom|maya|leo|grace)", low):
            who = re.search(r"^call (\w+)", low).group(1).capitalize()
            return Step(text=f"Calling {who}'s Echo Show now.")
        if re.search(r"not yet|no thanks|i'?ll handle it|i'?m on it", low):
            return Step(text="Okay. I'll check back with you soon." if "not yet" in low else "Okay.")
        if re.search(r"^(hi|hello|hey|good (morning|evening|afternoon))", user.lower()):
            return Step(text="Hi! I can help with your medications, how you're feeling, messages from the family and upcoming appointments.")
        return Step(text="I can help with medications, check-ins, messages to the care circle, doctor's notes and appointments.")
