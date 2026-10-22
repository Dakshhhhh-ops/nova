"""Seeing for Nova: pill bottles and care documents.

Amazon Nova (multimodal, on Bedrock) reads the image; everything after that is
deterministic and checked against the care plan:

* `check_pill`: "Is this my morning pill?" -> is it on the list, is it due now,
  was it already taken, does the bottle's strength still match the plan?
* `read_document`: a photo of an after-visit summary or discharge papers ->
  a medication reconciliation (change / start / stop / continue) that a person
  approves before anything in the plan changes.

The bundled sample photos also have fixtures, so the demo works offline.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import uuid
from datetime import timedelta
from pathlib import Path
from typing import Any

from . import insights as ins
from .llm import vision_json
from .store import Store, iso, now, parse

SAMPLES = Path(__file__).resolve().parent.parent / "samples"

PILL_SYSTEM = "You read medication labels and pills from photos for a medication-safety assistant. Be literal; never guess."
PILL_PROMPT = (
    "Read this photo of a medication (pill bottle label, blister pack or pill). Return JSON: "
    '{"name": generic drug name or null, "strength": e.g. "40 mg" or null, "directions": text or null, '
    '"patient": name on label or null, "pharmacy": text or null, "prescriber": text or null, '
    '"label_text": the main label text you can read, "confidence": 0..1}. If you cannot read a drug name, use null.'
)
DOC_SYSTEM = "You extract medication information from clinical documents (after-visit summaries, discharge papers). Be literal."
DOC_PROMPT = (
    "Extract the medication plan from this document. Return JSON: "
    '{"title": str, "provider": str or null, "facility": str or null, "date": str or null, '
    '"medications": [{"name": generic name, "dose": e.g. "10 mg", "frequency": e.g. "once daily in the morning", '
    '"action": "start" | "stop" | "change" | "continue", "previous_dose": str or null, "reason": str or null}], '
    '"instructions": [short patient instructions]}. Only include what is written.'
)


def decode_image(data: str) -> tuple[bytes, str]:
    """Accept a data URL or bare base64."""
    mime = "image/png"
    m = re.match(r"data:([\w/+.-]+);base64,(.*)$", data.strip(), flags=re.S)
    if m:
        mime, data = m.group(1), m.group(2)
    return base64.b64decode(data), mime


def _fixture(image: bytes, kind: str) -> dict[str, Any] | None:
    path = SAMPLES / "fixtures.json"
    if not path.exists():
        return None
    fixtures = json.loads(path.read_text(encoding="utf-8"))
    hit = fixtures.get(hashlib.sha256(image).hexdigest())
    return hit["data"] if hit and hit["kind"] == kind else None


def read_image(kind: str, image: bytes, mime: str) -> tuple[dict[str, Any] | None, str]:
    """Amazon Nova on Bedrock first; the bundled sample photos fall back to fixtures; other photos to a local model."""
    system, prompt = (PILL_SYSTEM, PILL_PROMPT) if kind == "pill" else (DOC_SYSTEM, DOC_PROMPT)
    fixture = _fixture(image, kind)
    if fixture is not None and not _bedrock_ready():
        return fixture, "Sample photo fixture (offline)"
    data, by = vision_json(system, prompt, image, mime)
    useful = bool(data and (data.get("name") or data.get("medications")))
    if not useful and fixture is not None:
        return fixture, "Sample photo fixture (offline)"
    return data, by


def _bedrock_ready() -> bool:
    from .llm import Bedrock, get_backend

    b = get_backend()
    return isinstance(b, Bedrock)


def _norm(s: str | None) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def _strength(s: str | None) -> str:
    m = re.search(r"([\d,.]+)\s*(mg|mcg|iu|g)\b", (s or "").lower())
    return f"{m.group(1).replace(',', '')} {m.group(2)}" if m else ""


# words a label may add to the plan's drug name without making it a different product
_SALT_WORDS = {"hcl", "hydrochloride", "sodium", "potassium", "calcium", "magnesium", "tablet", "tablets", "tab", "tabs",
               "oral", "usp", "generic"}
# words that do make it a different product: combinations and modified-release forms
_PRODUCT_WORDS = {"er", "xr", "xl", "sr", "cr", "dr", "la", "odt", "hctz", "hydrochlorothiazide", "and", "plus", "with"}
SAFE_CONFIDENCE = 0.8   # below this, Nova never says "take it"
READ_CONFIDENCE = 0.5   # below this, Nova says it can't read the label


def exact_product(label_name: str | None, plan_name: str) -> bool:
    """True when the label names the same product as the plan (allowing salt words), not a combination or ER form."""
    words = [w for w in re.split(r"[^a-z0-9]+", (label_name or "").lower()) if w]
    plan = [w for w in re.split(r"[^a-z0-9]+", plan_name.lower()) if w]
    if not words or not plan or words[:len(plan)] != plan:
        return False
    extra = [w for w in words[len(plan):] if not re.fullmatch(r"\d+(mg|mcg|g|iu|ml)?|mg|mcg|g|iu|ml", w)]
    return all(w in _SALT_WORDS for w in extra) and not any(w in _PRODUCT_WORDS for w in extra)


def _confidence(data: dict[str, Any], by: str) -> float:
    c = data.get("confidence")
    try:
        c = float(c)
    except (TypeError, ValueError):
        return 1.0 if "fixture" in by.lower() else 0.6  # a model that doesn't say how sure it is: treat as unsure
    return c / 100 if c > 1 else c


def match_medication(store: Store, person_id: str, name: str | None) -> dict[str, Any] | None:
    n = _norm(name)
    if not n:
        return None
    for m in store.medications(person_id):
        mn = _norm(m["name"])
        if mn and (mn in n or n in mn or mn[:6] == n[:6]):
            return m
    return None


# ---------------------------------------------------------------------------
# Pill check
# ---------------------------------------------------------------------------
def check_pill(store: Store, elder: dict[str, Any], image: bytes, mime: str) -> dict[str, Any]:
    data, by = read_image("pill", image, mime)
    t = now()
    name = elder["short_name"]
    today = ins.doses_for_day(store, elder["id"], t, t)
    due_now = [d for d in today if d["status"] in ("due", "missed")]
    due_view = [{"name": d["name"], "appearance": d["appearance"], "time_label": d["time_label"], "status": d["status"]} for d in due_now]
    base = {"identified": data or {}, "matched_med": None, "due_now": due_view, "generated_by": by}
    confidence = _confidence(data or {}, by)
    base["confidence"] = round(confidence, 2)
    if not data or not data.get("name") or confidence < READ_CONFIDENCE:
        return {**base, "verdict": "unclear", "advice": "Don't take anything from this bottle until the label is checked. "
                                                         "Hold it closer to the camera, in good light, or ask the pharmacist.",
                "speech": f"I can't read that label clearly, {name}, so please don't take it yet. "
                          "Hold it a little closer to the camera, or ask Maya or the pharmacist."}
    med = match_medication(store, elder["id"], data.get("name"))
    avoid = avoid_note(store, elder["id"], data.get("name") or "")
    if avoid and not med:
        note, sentence, alternative = avoid
        src = note["source"].split("·")[0].strip().lower()
        return {**base, "verdict": "avoid", "source": note["source"],
                "advice": f"Don't take it. {sentence}" + (f" {alternative}" if alternative else ""),
                "speech": f"Please don't take {data['name'].lower()}, {name}: your {src} say to avoid it."
                          + (f" For pain, they allow acetaminophen instead." if alternative and "acetaminophen" in alternative.lower() else ""),
                "more": (f"The reason given is {_because(sentence).replace('because of ', '')}. " if _because(sentence) else "")
                        + (f"The same notes say: {alternative[0].lower() + alternative[1:]}" if alternative else "")}
    if not med:
        return {**base, "verdict": "not_on_list",
                "advice": "Don't take it. Ask Maya or the pharmacist before taking anything new.",
                "speech": f"That looks like {data['name']}{' ' + data['strength'] if data.get('strength') else ''}, "
                          f"and it's not on your medication list, {name}. Please don't take it until you check with "
                          "Maya or the pharmacist."}
    times = [ins.time_label(parse(f"2000-01-01T{x}:00")) for x in med["times"]]
    matched = {"id": med["id"], "name": med["name"], "dose": med["dose"], "purpose": med["purpose"],
               "appearance": med["appearance"], "times": times}
    base["matched_med"] = matched
    label_strength, plan_strength = _strength(data.get("strength")), _strength(med["dose"])
    if label_strength and plan_strength and label_strength != plan_strength:
        changed = f" {med['change_note']}." if med.get("change_note") else ""
        return {**base, "verdict": "dose_mismatch",
                "advice": f"Set this bottle aside. Your plan says {med['dose']}.",
                "speech": f"Careful, {name}: this is the old {data['strength']} {med['name'].lower()}. "
                          f"Your plan is now {med['dose']}, so please set this bottle aside.",
                "more": changed.strip() or None}
    mine = [d for d in today if d["med_id"] == med["id"]]
    open_now = [d for d in mine if d["status"] in ("due", "missed")]
    taken = [d for d in mine if d["status"] == "taken"]
    if open_now:
        d = open_now[0]
        food = " with something to eat" if med.get("with_food") else ""
        # "take it" only when Nova is sure: the exact product, the strength read and matching, a confident read
        reasons = []
        if not exact_product(data.get("name"), med["name"]):
            reasons.append(f"the label says {data['name']}, not just {med['name']}")
        if not label_strength:
            reasons.append("I can't read the strength")
        if confidence < SAFE_CONFIDENCE:
            reasons.append("the photo isn't clear enough to be sure")
        if reasons:
            return {**base, "verdict": "check_first", "reasons": reasons,
                    "advice": f"Check this bottle with the pharmacist or Maya before taking it: {'; '.join(reasons)}.",
                    "speech": f"That looks like your {med['name'].lower()}, {name}, but I can't be sure from this photo. "
                              "Please check it with Maya or the pharmacist before you take it.",
                    "more": f"Why: {'; '.join(reasons)}."}
        return {**base, "verdict": "ok_now", "advice": f"Take one now{food}, then say 'I took it'.",
                "speech": f"Yes, that's your {med['name']} {med['dose']} for {med['purpose']}, and it's due now. "
                          f"Take one{food}, then tell me when you're done."}
    nearest_taken = taken[-1] if taken else None
    if nearest_taken and all(d["status"] != "upcoming" or parse(d["scheduled_for"]) > t + timedelta(hours=3) for d in mine):
        return {**base, "verdict": "already_taken", "advice": "Put it back. You've already had today's dose.",
                "speech": f"That's your {med['name']}, and you already took it at "
                          f"{ins.time_label(parse(nearest_taken['logged_at']))}. Please don't take another one."}
    others = speak = ""
    if due_now:
        speak = ", ".join(f"{d['name']} ({d['appearance']})" for d in due_now)
        others = f" Right now it's time for {speak}."
    due_names = speak_names([d["name"] for d in due_now])
    return {**base, "verdict": "wrong_time",
            "advice": f"Put this one back until {speak_times(times)}." + (f" Take {speak} now." if speak else ""),
            "speech": f"That's {med['name'].lower()}, your {speak_times(times)} pill, so put it back."
                      + (f" Right now it's time for your {due_names}." if due_names else ""),
            "more": f"Right now:{others.replace(' Right now it' + chr(39) + 's time for', '')}" if others else None}


def avoid_note(store: Store, person_id: str, drug: str) -> tuple[dict[str, Any], str, str | None] | None:
    """Find a care-note sentence telling this person to avoid the drug, plus the suggested alternative."""
    d = (drug or "").lower().split()[0] if drug else ""
    if not d:
        return None
    for n in store.care_notes(person_id):
        sentences = re.split(r"(?<=[.!?])\s+", n["text"])
        for s in sentences:
            low = s.lower()
            if d in low and re.search(r"\bavoid|do not take|don't take", low):
                alt = next((x for x in sentences if x is not s and re.search(r"for pain|instead|is okay|is ok", x.lower())), None)
                return n, s.strip(), alt.strip() if alt else None
    return None


def _because(sentence: str) -> str:
    m = re.search(r"\b(because of [^.]+)", sentence, flags=re.I)
    return m.group(1) if m else ""


def speak_names(names: list[str]) -> str:
    names = [n.lower() if n.lower() != n.upper() and not n.startswith("Vitamin") else n for n in names]
    return names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1] if names else ""


def speak_times(times: list[str]) -> str:
    return " and ".join(times) if len(times) <= 2 else ", ".join(times)


# ---------------------------------------------------------------------------
# Document reconciliation
# ---------------------------------------------------------------------------
def _times_for(frequency: str | None, current: list[str] | None = None) -> list[str]:
    f = (frequency or "").lower()
    if "twice" in f or "two times" in f or "2 times" in f:
        return ["08:00", "18:00"]
    if "three" in f:
        return ["08:00", "13:00", "18:00"]
    if "bedtime" in f or "night" in f:
        return ["21:00"]
    if "evening" in f or "dinner" in f:
        return ["18:00"]
    if "morning" in f or "breakfast" in f:
        return ["08:00"]
    return current or ["08:00"]


def _freq_label(times: list[str]) -> str:
    labels = [ins.time_label(parse(f"2000-01-01T{x}:00")) for x in times]
    return {1: "once daily", 2: "twice daily", 3: "three times daily"}.get(len(times), "daily") + " (" + ", ".join(labels) + ")"


def read_document(store: Store, elder: dict[str, Any], by: dict[str, Any], image: bytes, mime: str) -> dict[str, Any]:
    data, who = read_image("document", image, mime)
    if not data or not data.get("medications"):
        return {"speech": "I couldn't find a medication list in that photo. Try a closer, flatter shot of the page.",
                "change_set_id": None, "status": "unreadable", "source": {}, "changes": [], "instructions": [],
                "generated_by": who}
    current = {m["id"]: m for m in store.medications(elder["id"])}
    changes = []
    mentioned: set[str] = set()
    for item in data["medications"]:
        med = match_medication(store, elder["id"], item.get("name"))
        action = (item.get("action") or "").lower()
        new_dose = item.get("dose") or ""
        if med:
            mentioned.add(med["id"])
            same = _strength(new_dose) == _strength(med["dose"]) or not new_dose
            if action == "stop":
                op = "stop"
            elif action == "change" or not same:
                op = "change"
            else:
                op = "continue"
            new_times = _times_for(item.get("frequency"), med["times"])
            changes.append({
                "op": op, "med_id": med["id"], "name": med["name"],
                "from": f"{med['dose']} {_freq_label(med['times'])}",
                "to": "stop taking" if op == "stop" else f"{new_dose or med['dose']} {_freq_label(new_times)}",
                "new_dose": new_dose or med["dose"], "new_times": new_times,
                "reason": item.get("reason"),
            })
        elif action != "stop":
            new_times = _times_for(item.get("frequency"))
            changes.append({"op": "start", "med_id": None, "name": item.get("name") or "New medication",
                            "from": "", "to": f"{new_dose} {_freq_label(new_times)}", "new_dose": new_dose,
                            "new_times": new_times, "reason": item.get("reason")})
    source = {k: data.get(k) for k in ("title", "provider", "facility", "date")}
    instructions = [str(i) for i in data.get("instructions") or []]
    cs_id = f"cs_{uuid.uuid4().hex[:8]}"
    store.add_change_set(cs_id, elder["id"], by["id"], source, changes, instructions)
    real = [c for c in changes if c["op"] != "continue"]
    if real:
        c = real[0]
        what = (f"{c['name']} goes from {c['from'].split(' (')[0]} to {c['to'].split(' (')[0]}" if c["op"] == "change"
                else f"{c['op']} {c['name']}")
        doc = (source.get("title") or "document").lower()
        speech = (f"I read {source['provider'] + chr(39) + 's' if source.get('provider') else 'the'} {doc}. "
                  f"There {'is' if len(real) == 1 else 'are'} {len(real)} change{'s' if len(real) > 1 else ''}: {what}"
                  f"{' because of ' + c['reason'] if c.get('reason') else ''}. Want me to update {elder['short_name']}'s plan?")
    else:
        speech = "I read the document. The medications match the current plan, so nothing needs to change."
    return {"speech": speech, "change_set_id": cs_id, "status": "pending", "source": source,
            "changes": changes, "instructions": instructions, "generated_by": who}


def apply_change_set(store: Store, cs_id: str, approver: dict[str, Any], approve: bool) -> dict[str, Any]:
    cs = store.change_set(cs_id)
    if not cs:
        return {"speech": "I couldn't find that set of changes.", "status": "missing", "applied": [], "plan": []}
    if cs["status"] != "pending":
        return {"speech": f"Those changes were already {cs['status']}.", "status": cs["status"], "applied": [], "plan": plan(store, cs["person_id"])}
    elder = store.person(cs["person_id"]) or {"short_name": "them", "id": cs["person_id"]}
    if not approve:
        store.x("UPDATE change_sets SET status = 'discarded' WHERE id = ?", (cs_id,))
        return {"speech": "Okay, I discarded those changes. The plan is unchanged.", "status": "discarded",
                "applied": [], "plan": plan(store, elder["id"])}
    t = now()
    provider = (cs["source"].get("provider") or "The doctor").replace("Dr. Anika ", "Dr. ")
    applied = []
    for c in cs["changes"]:
        if c["op"] == "change" and c.get("med_id"):
            old = store.one("SELECT dose FROM medications WHERE id = ?", (c["med_id"],))
            note = f"{provider} changed it from {old['dose'] if old else '?'} to {c['new_dose']}"
            store.x("UPDATE medications SET dose = ?, times = ?, changed_on = ?, change_note = ?, appearance = ? WHERE id = ?",
                    (c["new_dose"], json.dumps(c["new_times"]), iso(t), note,
                     f"new {c['new_dose']} tablet", c["med_id"]))
            applied.append(c)
        elif c["op"] == "stop" and c.get("med_id"):
            store.x("DELETE FROM medications WHERE id = ?", (c["med_id"],))
            applied.append(c)
        elif c["op"] == "start":
            mid = _norm(c["name"])[:20] or f"med_{uuid.uuid4().hex[:6]}"
            store.x("INSERT OR REPLACE INTO medications (id, person_id, name, dose, purpose, appearance, times, with_food, "
                    "instructions, started, changed_on, change_note) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)",
                    (mid, elder["id"], c["name"], c["new_dose"], c.get("reason") or "", "new prescription",
                     json.dumps(c["new_times"]), "", iso(t), iso(t), f"Started by {provider}"))
            applied.append(c)
    if cs["instructions"]:
        src = " · ".join(x for x in (cs["source"].get("title"), cs["source"].get("provider")) if x)
        store.add_care_note(elder["id"], src or "Care document", " ".join(cs["instructions"]))
    store.x("UPDATE change_sets SET status = 'applied' WHERE id = ?", (cs_id,))

    if applied:
        c = applied[0]
        first = (f"{provider} changed your {c['name'].lower()} from {c['from'].split(' (')[0]} to {c['new_dose']}"
                 if c["op"] == "change" else f"{provider} asked you to {c['op']} {c['name'].lower()}")
        store.announce(elder["id"], "care_plan_change", "Your medicines changed",
                       f"{elder['short_name']}, {first}. From now on, take the new {c['new_dose']} tablet instead of "
                       f"the old one. {approver['short_name']} updated your plan.",
                       severity="info", dedupe=f"plan-change:{cs_id}")
        for p in store.caregivers():
            if p["id"] != approver["id"]:
                store.announce(p["id"], "info", "Mom's plan updated",
                               f"{approver['short_name']} updated Mom's plan after the visit: {first.replace('your', 'her')}.",
                               dedupe=f"plan-change:{cs_id}:{p['id']}")
    speech = (f"Done. I updated {elder['short_name']}'s plan: " +
              "; ".join(f"{c['name']} {c['to'].split(' (')[0] if c['op'] != 'stop' else 'stopped'}" for c in applied) +
              f". I'll let {elder['short_name']} know." if applied else "Nothing needed to change.")
    return {"speech": speech, "status": "applied", "applied": applied, "plan": plan(store, elder["id"])}


def plan(store: Store, person_id: str) -> list[dict[str, Any]]:
    return [{"name": m["name"], "dose": m["dose"], "appearance": m["appearance"], "purpose": m["purpose"],
             "times": [ins.time_label(parse(f"2000-01-01T{x}:00")) for x in m["times"]],
             "recent_change": m.get("change_note")} for m in store.medications(person_id)]
