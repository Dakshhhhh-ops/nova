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


def route(text: str, role: str) -> dict[str, Any] | None:
    t = text.lower().strip()
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
        return _call("list_alerts")
    if re.search(r"alert", t):
        return _call("list_alerts")
    if role != "elder" and re.search(r"how('s| is| are)|doing|briefing|update|anything i should know|week", t):
        return _call("care_briefing", period="today" if "today" in t else "week")
    if re.search(r"did (i|she|he|mom|rose) take|have (i|you) taken|has (she|mom|rose) taken|what('s| is) the .*(pill|for)|when do i take|what is .* for", t):
        return _call("check_medication", medication=_med_phrase(t.replace("did i take", "took").replace("did mom take", "took")), time_of_day=_tod(t))
    if re.search(r"\b(took|taken|just had|had my|skipped)\b", t):
        return _call("log_medication", medication=_med_phrase(t), time_of_day=_tod(t),
                     status="skipped" if "skip" in t else "taken")
    if re.search(r"doctor (say|said)|can i (take|have|eat)|should i|allowed|instructions|what did .* say|how much salt|pharmacy|allerg", t):
        return _call("ask_care_notes", question=text)
    if role == "elder" and re.search(r"\bfeel|feeling|slept|sleep|tired|dizzy|woozy|pain|hurts|ache|mood|lonely|sad|great day|good day|bad day", t):
        return _call("daily_checkin", how_are_you_feeling=text)
    if re.search(r"today|schedule|what('s| is) next|my day|pills (now|today)|what do i take", t):
        return _call("get_today")
    return None


class RulesBrain(Backend):
    name = "rules"
    label = "Nova offline router (no model)"

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
        call = route(user, self.role)
        if call:
            return Step(tool_calls=[call])
        if re.search(r"^(hi|hello|hey|good (morning|evening|afternoon))", user.lower()):
            return Step(text="Hi! I can help with your medications, how you're feeling, messages from the family and upcoming appointments.")
        return Step(text="I can help with medications, check-ins, messages to the care circle, doctor's notes and appointments.")
