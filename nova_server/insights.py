"""Nova's insight engine.

Two layers, on purpose:

1. Deterministic signals (this file, `detect_insights`). Pattern rules over
   doses, check-ins, care notes and circle messages. They are explainable,
   testable and never hallucinate; every insight carries its evidence.
2. Language (Amazon Nova on Bedrock, via `llm.py`). Turns those facts into a
   warm spoken briefing, extracts structure from free-form check-ins, answers
   questions from the care notes and drafts doctor-visit briefs. Every model
   call has a template fallback, so Nova keeps working without a model.

Nova never diagnoses. It notices, connects dots, cites what the care team
wrote, and suggests who to call.
"""

from __future__ import annotations

import json
import logging
import re
from collections import Counter
from datetime import datetime, timedelta
from typing import Any

from .llm import Backend, get_backend, parse_json
from .store import Store, iso, now, parse

log = logging.getLogger("nova.insights")

# ---------------------------------------------------------------------------
# Labels for speech and screens
# ---------------------------------------------------------------------------


def time_label(dt: datetime) -> str:
    h = dt.hour % 12 or 12
    ampm = "AM" if dt.hour < 12 else "PM"
    return f"{h} {ampm}" if dt.minute == 0 else f"{h}:{dt.minute:02d} {ampm}"


def day_label(dt: datetime, ref: datetime | None = None) -> str:
    ref = ref or now()
    delta = (dt.date() - ref.date()).days
    if delta == 0:
        return "today"
    if delta == 1:
        return "tomorrow"
    if delta == -1:
        return "yesterday"
    if -6 <= delta <= 6:
        return dt.strftime("%A") if delta > 0 else f"last {dt.strftime('%A')}"
    return f"{dt.strftime('%b')} {dt.day}"


def when_label(dt: datetime, ref: datetime | None = None) -> str:
    d = day_label(dt, ref)
    return f"{d[:1].upper() + d[1:]} at {time_label(dt)}"


def mid_sentence(label: str) -> str:
    """'Tomorrow at 10 AM' -> 'tomorrow at 10 AM'; weekday names keep their capital."""
    for w in ("Today", "Tomorrow", "Yesterday", "Last"):
        if label.startswith(w):
            return w.lower() + label[len(w):]
    return label


def short_date(dt: datetime) -> str:
    return f"{dt.strftime('%b')} {dt.day}"


def slot_of(dt: datetime) -> str:
    if dt.hour < 12:
        return "morning"
    if dt.hour < 17:
        return "afternoon"
    return "evening"


# ---------------------------------------------------------------------------
# Doses
# ---------------------------------------------------------------------------
DUE_WINDOW_BEFORE = timedelta(minutes=60)
MISSED_AFTER = timedelta(hours=2)


def dose_status(dose: dict[str, Any], t: datetime) -> str:
    if dose["status"] in ("taken", "skipped"):
        return dose["status"]
    at = parse(dose["scheduled_for"])
    if at > t + DUE_WINDOW_BEFORE:
        return "upcoming"
    if at < t - MISSED_AFTER:
        return "missed"
    return "due"


def doses_for_day(store: Store, person_id: str, day: datetime, t: datetime | None = None) -> list[dict[str, Any]]:
    t = t or now()
    start = day.replace(hour=0, minute=0, second=0)
    meds = {m["id"]: m for m in store.medications(person_id)}
    out = []
    for d in store.scheduled_doses(person_id, start, start + timedelta(days=1)):
        at = parse(d["scheduled_for"])
        m = meds.get(d["med_id"], {})
        out.append({
            **d,
            "status": dose_status(d, t),
            "time_label": time_label(at),
            "purpose": m.get("purpose"),
            "with_food": m.get("with_food"),
        })
    return out


def adherence(store: Store, person_id: str, days: int, t: datetime | None = None) -> dict[str, Any]:
    t = t or now()
    start = (t - timedelta(days=days - 1)).replace(hour=0, minute=0, second=0)
    doses = [d for d in store.scheduled_doses(person_id, start, t + timedelta(minutes=1))]
    counted = []
    for d in doses:
        st = dose_status(d, t)
        if st in ("taken", "skipped", "missed"):
            counted.append((d, st))
    taken = sum(1 for _, st in counted if st == "taken")
    total = len(counted)

    def pct(items: list[tuple[dict[str, Any], str]]) -> int | None:
        if not items:
            return None
        return round(100 * sum(1 for _, st in items if st == "taken") / len(items))

    by_slot: dict[str, list] = {"morning": [], "afternoon": [], "evening": []}
    by_med: dict[str, list] = {}
    for d, st in counted:
        by_slot[slot_of(parse(d["scheduled_for"]))].append((d, st))
        by_med.setdefault(d["name"], []).append((d, st))
    return {
        "pct": pct(counted) if counted else 100,
        "taken": taken,
        "scheduled": total,
        "morning_pct": pct(by_slot["morning"]),
        "evening_pct": pct(by_slot["evening"]),
        "evening_missed": sum(1 for _, st in by_slot["evening"] if st != "taken"),
        "evening_total": len(by_slot["evening"]),
        "by_med": [
            {"name": name, "pct": pct(items), "missed": sum(1 for _, st in items if st != "taken")}
            for name, items in sorted(by_med.items())
        ],
        "missed_list": [
            {"name": d["name"], "at": d["scheduled_for"], "label": f"{short_date(parse(d['scheduled_for']))} {time_label(parse(d['scheduled_for']))}"}
            for d, st in counted if st == "missed"
        ],
    }


# ---------------------------------------------------------------------------
# Symptoms
# ---------------------------------------------------------------------------
SYMPTOM_FAMILIES = {
    "dizziness": r"dizz|woozy|light.?headed|unsteady|room spinning|faint",
    "knee pain": r"knee",
    "fatigue": r"\btired|exhausted|no energy|fatigue",
    "swelling": r"swell|swollen|puffy ankle",
    "shortness of breath": r"short of breath|can't breathe|cannot breathe|breathless",
    "chest pain": r"chest (pain|tight|pressure)",
    "confusion": r"confus|forgetful|lost track",
    "headache": r"headache|migraine",
    "nausea": r"nause|sick to my stomach|throwing up|vomit",
    "low mood": r"lonely|sad|down in the dumps|depress|blue today",
}

SYMPTOM_FEELING = {
    "dizziness": "dizzy", "swelling": "some swelling", "confusion": "confused",
    "shortness of breath": "short of breath", "fatigue": "tired", "low mood": "low",
}


def feeling(family: str) -> str:
    """'dizziness' -> 'dizzy', for 'you're feeling ...' sentences."""
    return SYMPTOM_FEELING.get(family, family)


RED_FLAGS = {
    "fall": r"\b(i|i've|have) (fell|fallen)|\bfell (down|over)|took a (fall|tumble)|on the floor",
    "chest pain": r"chest (pain|tight|pressure|hurts)",
    "breathing": r"can't breathe|cannot breathe|struggling to breathe|short of breath",
    "stroke signs": r"face (droop|numb)|slurred|can't (lift|move) my (arm|leg)|sudden (weakness|numbness)",
    "fainting": r"\bfainted|passed out|blacked out",
}


def symptom_family(text: str) -> str | None:
    t = text.lower()
    for fam, pat in SYMPTOM_FAMILIES.items():
        if re.search(pat, t):
            return fam
    return None


def red_flags(text: str) -> list[str]:
    t = text.lower()
    return [name for name, pat in RED_FLAGS.items() if re.search(pat, t)]


# ---------------------------------------------------------------------------
# Insight detection
# ---------------------------------------------------------------------------
SEVERITY_RANK = {"urgent": 0, "watch": 1, "info": 2}


def _note_mentioning(store: Store, person_id: str, pattern: str) -> dict[str, Any] | None:
    for n in store.care_notes(person_id):
        if re.search(pattern, n["text"], flags=re.I):
            return n
    return None


def _phone_in(text: str) -> str | None:
    m = re.search(r"\b\d{3}-\d{3}-\d{4}\b", text)
    return m.group(0) if m else None


def detect_insights(store: Store, person_id: str, t: datetime | None = None) -> list[dict[str, Any]]:
    t = t or now()
    person = store.person(person_id) or {"short_name": "They", "pronoun": "they"}
    name = person["short_name"]
    she = {"she": "she", "he": "he"}.get(person.get("pronoun") or "", "they")
    her = {"she": "her", "he": "his"}.get(person.get("pronoun") or "", "their")
    insights: list[dict[str, Any]] = []
    checkins = store.checkins(person_id, t - timedelta(days=30))
    messages = [m for m in store.recent_messages(t - timedelta(days=14)) if m["from_id"] != person_id]

    # 1. A symptom that started after a medication change.
    for med in store.medications(person_id):
        if not med.get("changed_on"):
            continue
        changed = parse(med["changed_on"])
        if t - changed > timedelta(days=30):
            continue
        before: Counter = Counter()
        after: dict[str, list[dict[str, Any]]] = {}
        for c in checkins:
            fams = {symptom_family(s) for s in c["symptoms"]} | {symptom_family(c["utterance"] or "")}
            fams.discard(None)
            for fam in fams:
                if parse(c["at"]) < changed:
                    before[fam] += 1
                else:
                    after.setdefault(fam, []).append(c)
        for fam, hits in after.items():
            if len(hits) < 2 or before[fam] > 0 or fam in ("knee pain", "fatigue"):
                continue
            first = parse(hits[0]["at"])
            lag = (first.date() - changed.date()).days
            evidence = [f"{short_date(parse(h['at']))} · “{h['utterance']}”" for h in hits[-4:]]
            corroboration = [
                m for m in messages
                if re.search(SYMPTOM_FAMILIES.get(fam, fam) + r"|BP|blood pressure", m["body"], flags=re.I)
            ]
            for m in corroboration[:2]:
                evidence.append(f"{short_date(parse(m['at']))} · {m['from_short']}: “{m['body']}”")
            note = _note_mentioning(store, person_id, fam[:5])
            phone = _phone_in(note["text"]) if note else None
            suggestion = (
                f"{note['source'].split('·')[-1].strip()}'s notes say to call about {fam}"
                + (f" ({phone})" if phone else "")
                + ". Worth calling before the next appointment rather than waiting."
                if note else "Worth mentioning to the prescribing doctor soon."
            )
            insights.append({
                "id": f"after-change-{med['id']}-{fam.replace(' ', '-')}",
                "severity": "watch",
                "title": f"{fam.capitalize()} began after {her} {med['name'].lower()} change",
                "detail": (
                    f"{name} has mentioned {fam} {len(hits)} times since {short_date(first)}, "
                    f"{lag} day{'s' if lag != 1 else ''} after {her} {med['name'].lower()} dose change on {short_date(changed)}"
                    f"{' (' + med['change_note'] + ')' if med.get('change_note') else ''}. "
                    f"{she.capitalize()} hadn't mentioned it before."
                ),
                "evidence": evidence,
                "suggestion": suggestion,
                "related": {"medication": med["name"], "symptom": fam, "since": iso(first), "count": len(hits)},
            })

    # 2. Evening doses slipping while mornings hold.
    recent = adherence(store, person_id, 5, t)
    if recent["evening_total"] >= 3 and (recent["evening_pct"] or 0) < 75 and (recent["morning_pct"] or 100) - (recent["evening_pct"] or 0) >= 20:
        missed_meds = Counter(m["name"] for m in recent["missed_list"] if parse(m["at"]).hour >= 17)
        worst = ", ".join(n for n, _ in missed_meds.most_common(2))
        insights.append({
            "id": "evening-doses",
            "severity": "watch",
            "title": "Evening doses are slipping",
            "detail": (
                f"{recent['evening_missed']} of {recent['evening_total']} evening doses were missed in the last 5 days"
                f"{f' (mostly {worst})' if worst else ''}. Mornings are at {recent['morning_pct']}%."
            ),
            "evidence": [f"Missed {m['label']} · {m['name']}" for m in recent["missed_list"] if parse(m["at"]).hour >= 17][-5:],
            "suggestion": "Try a dinner-time reminder on the kitchen Echo, or keep the evening pills next to where dinner is served.",
            "related": {"evening_pct": recent["evening_pct"], "morning_pct": recent["morning_pct"]},
        })

    # 3. Mood, pain and sleep trends.
    last = [c for c in checkins if parse(c["at"]) >= t - timedelta(days=3)]
    prior = [c for c in checkins if t - timedelta(days=10) <= parse(c["at"]) < t - timedelta(days=3)]

    def avg(rows: list[dict[str, Any]], key: str) -> float | None:
        vals = [r[key] for r in rows if r.get(key) is not None]
        return sum(vals) / len(vals) if vals else None

    mood_now, mood_before = avg(last, "mood"), avg(prior, "mood")
    if mood_now is not None and mood_before is not None and mood_before - mood_now >= 1:
        insights.append({
            "id": "mood-trend",
            "severity": "info",
            "title": "Mood is lower than usual",
            "detail": f"Average mood {mood_now:.1f}/5 over the last 3 days, down from {mood_before:.1f}/5.",
            "evidence": [f"{short_date(parse(c['at']))} · mood {c['mood']}/5 · “{c['utterance']}”" for c in last][-3:],
            "suggestion": f"A video call or a visit could help. {name} tends to brighten after talking with family.",
            "related": {"now": round(mood_now, 1), "before": round(mood_before, 1)},
        })
    pain_now, pain_before = avg(last, "pain"), avg(prior, "pain")
    if pain_now is not None and pain_before is not None and pain_now - pain_before >= 1.5:
        note = _note_mentioning(store, person_id, r"acetaminophen|ibuprofen")
        insights.append({
            "id": "pain-trend",
            "severity": "info",
            "title": "Pain is trending up",
            "detail": f"Reported pain averages {pain_now:.0f}/10 over the last 3 days, up from {pain_before:.0f}/10.",
            "evidence": [f"{short_date(parse(c['at']))} · pain {c['pain']}/10" for c in last][-3:],
            "suggestion": (
                "Her knee instructions allow acetaminophen up to 3,000 mg a day and say to avoid ibuprofen."
                if note else "Mention the pain trend at the next appointment."
            ),
            "related": {"now": round(pain_now, 1), "before": round(pain_before, 1)},
        })
    sleep_now, sleep_before = avg(last, "sleep_hours"), avg(prior, "sleep_hours")
    if sleep_now is not None and sleep_before is not None and sleep_before - sleep_now >= 1:
        insights.append({
            "id": "sleep-trend",
            "severity": "info",
            "title": "Sleeping less",
            "detail": f"About {sleep_now:.1f} hours a night lately, down from {sleep_before:.1f}.",
            "evidence": [],
            "suggestion": "Worth asking about at the next visit.",
            "related": {"now": round(sleep_now, 1), "before": round(sleep_before, 1)},
        })

    # 4. Activity drop.
    active_days = sorted({parse(c["at"]).date() for c in checkins if c["activities"]})
    if active_days:
        last_active = active_days[-1]
        gap = (t.date() - last_active).days
        if gap >= 4 and len(active_days) >= 2:
            insights.append({
                "id": "activity-drop",
                "severity": "info",
                "title": f"{she.capitalize()}'s stopped {her} walks",
                "detail": f"No walks or outings logged for {gap} days. Before that {she} was out most days.",
                "evidence": [f"Last activity {short_date(datetime.combine(last_active, datetime.min.time()))}"],
                "suggestion": "Could be linked to the dizziness. A short walk with Grace or a neighbor is safer than going alone.",
                "related": {"days_since": gap},
            })

    # 5. Today's missed doses.
    today = doses_for_day(store, person_id, t, t)
    missed_today = [d for d in today if d["status"] == "missed"]
    if missed_today:
        insights.append({
            "id": "missed-today",
            "severity": "watch" if len(missed_today) > 1 else "info",
            "title": f"{len(missed_today)} dose{'s' if len(missed_today) > 1 else ''} not logged today",
            "detail": ", ".join(f"{d['name']} at {d['time_label']}" for d in missed_today) + ".",
            "evidence": [],
            "suggestion": f"A quick call to check, or ask Alexa to remind {name}.",
            "related": {"doses": [d["med_id"] for d in missed_today]},
        })

    insights.sort(key=lambda i: SEVERITY_RANK[i["severity"]])
    return insights


def sync_alerts(store: Store, person_id: str, insights: list[dict[str, Any]]) -> None:
    """Persist watch/urgent insights as open alerts (deduplicated by kind)."""
    for ins in insights:
        if ins["severity"] in ("watch", "urgent"):
            existing = store.one(
                "SELECT id FROM alerts WHERE person_id = ? AND kind = ? AND status = 'open'", (person_id, ins["id"])
            )
            if existing:
                store.x("UPDATE alerts SET message = ?, severity = ? WHERE id = ?",
                        (ins["title"] + ". " + ins["detail"], ins["severity"], existing["id"]))
            else:
                handled_recently = store.one(
                    "SELECT id FROM alerts WHERE person_id = ? AND kind = ? AND status = 'handled' AND handled_at >= ?",
                    (person_id, ins["id"], iso(now() - timedelta(hours=12))),
                )
                if not handled_recently:
                    store.add_alert(person_id, ins["severity"], ins["id"], ins["title"] + ". " + ins["detail"])


def overall_status(insights: list[dict[str, Any]], alerts: list[dict[str, Any]]) -> str:
    sevs = {i["severity"] for i in insights} | {a["severity"] for a in alerts}
    if "urgent" in sevs:
        return "urgent"
    if "watch" in sevs:
        return "watch"
    return "steady"


# ---------------------------------------------------------------------------
# Language layer (Amazon Nova with fallbacks)
# ---------------------------------------------------------------------------
VOICE_RULES = (
    "You write for a voice assistant. Plain spoken English, no markdown, no lists, no emojis. "
    "Warm, calm and specific. Never diagnose or give new medical advice; you may repeat what the care team wrote "
    "and suggest who to call."
)


def _llm() -> Backend | None:
    b = get_backend()
    return b if b.name != "none" else None


def generated_by() -> str:
    b = _llm()
    return b.label if b else "Nova rules engine"


def narrate_briefing(ctx: dict[str, Any]) -> dict[str, str]:
    """Headline + spoken briefing for a caregiver."""
    fallback = _template_briefing(ctx)
    b = _llm()
    if not b:
        return fallback
    prompt = (
        f"You are Nova, speaking through Alexa to {ctx['viewer']} ({ctx['relation']} of {ctx['name']}). "
        f"Write a briefing about {ctx['name']} for {ctx['period']}.\n\n"
        f"FACTS (JSON):\n{json.dumps(ctx['facts'], default=str)[:6000]}\n\n"
        "Return JSON with keys: headline (max 12 words, no name needed) and speech "
        "(2-3 short spoken sentences, max 60 words: start with the overall picture, then the single most important "
        "thing and what to do about it; end by offering one next step such as preparing a visit brief)."
    )
    try:
        data = parse_json(b.complete(VOICE_RULES, prompt, max_tokens=300, json_mode=True))
        if data and data.get("speech"):
            return {"headline": str(data.get("headline") or fallback["headline"]), "speech": str(data["speech"])}
    except Exception as exc:
        log.warning("briefing narration failed: %s", exc)
    return fallback


def _template_briefing(ctx: dict[str, Any]) -> dict[str, str]:
    name = ctx["name"]
    ins = ctx["facts"].get("insights") or []
    adh = ctx["facts"].get("adherence") or {}
    if not ins:
        return {
            "headline": "A steady day",
            "speech": f"{name} is doing well. Medications are at {adh.get('pct', 100)} percent and nothing needs your attention.",
        }
    top = ins[0]
    first = lambda text: re.split(r"(?<!Dr\.)(?<=[.!?])\s+", text.strip())[0]  # noqa: E731
    opener = (f"{name} is mostly okay, but one thing needs your attention." if top["severity"] != "info"
              else f"{name} is doing okay overall.")
    parts = [opener, f"{top['title']}. {first(top['detail'])}"]
    if top.get("suggestion"):
        parts.append(first(top["suggestion"]))
    if len(ins) > 1:
        parts.append(f"There {'is' if len(ins) == 2 else 'are'} {len(ins) - 1} more thing{'s' if len(ins) > 2 else ''} on screen.")
    return {"headline": top["title"], "speech": " ".join(parts)}


CHECKIN_SCHEMA_HINT = (
    '{"mood": 1-5 or null (1 very low, 3 okay, 5 great), "pain": 0-10 or null, "sleep_hours": number or null, '
    '"symptoms": [short lowercase phrases], "activities": [short phrases], '
    '"summary": "one sentence in third person", "reply": "one or two warm spoken sentences back to the person"}'
)


def extract_checkin(utterance: str, name: str) -> dict[str, Any]:
    base = _heuristic_checkin(utterance, name)
    b = _llm()
    if not b:
        return base
    prompt = (
        f"{name} (an older adult) just told their Alexa how they are feeling:\n\"{utterance}\"\n\n"
        f"Extract a check-in as JSON: {CHECKIN_SCHEMA_HINT}. Only include what was actually said."
    )
    try:
        data = parse_json(b.complete(VOICE_RULES, prompt, max_tokens=300, json_mode=True))
        if not data:
            return base
        out = dict(base)
        for k in ("mood", "pain", "sleep_hours"):
            v = data.get(k)
            if isinstance(v, (int, float)):
                out[k] = v
        for k in ("symptoms", "activities"):
            if isinstance(data.get(k), list):
                out[k] = sorted({*out[k], *[str(s).lower() for s in data[k] if s]})
        for k in ("summary", "reply"):
            if data.get(k):
                out[k] = str(data[k])
        return out
    except Exception as exc:
        log.warning("check-in extraction failed: %s", exc)
        return base


def _heuristic_checkin(utterance: str, name: str) -> dict[str, Any]:
    t = utterance.lower()
    mood = None
    for words, score in (
        (r"terrible|awful|miserable|very low", 1),
        (r"\bsad\b|lonely|down\b|not (so |too )?(good|great)|rough|bad day", 2),
        (r"\bokay\b|\bok\b|alright|so-so|not bad|fine", 3),
        (r"\bgood\b|pretty well|better", 4),
        (r"great|wonderful|fantastic|excellent", 5),
    ):
        if re.search(words, t):
            mood = score
    pain = None
    m = re.search(r"pain (?:is |about |around )?(?:a |an )?(\d{1,2})", t)
    if m:
        pain = min(10, int(m.group(1)))
    elif re.search(r"hurts? a lot|really (hurts|aches)|terrible pain", t):
        pain = 7
    elif re.search(r"ache|aches|sore|hurts|stiff", t):
        pain = 4
    sleep = None
    m = re.search(r"slept (?:about |around |only )?(\d+(?:\.\d)?) hours", t)
    if m:
        sleep = float(m.group(1))
    elif re.search(r"didn'?t sleep|couldn'?t sleep|poor sleep|slept badly", t):
        sleep = 4.5
    elif re.search(r"slept (well|great|fine)", t):
        sleep = 7.5
    symptoms = sorted({fam for fam, pat in SYMPTOM_FAMILIES.items() if re.search(pat, t)})
    activities = []
    for pat, label in ((r"\bwalk", "walk"), (r"garden", "gardening"), (r"church", "church"),
                       (r"visit|came over|lunch with", "visit"), (r"exercise|stretch", "exercise")):
        if re.search(pat, t) and not re.search(r"(skip|didn'?t|no) [a-z ]*" + pat.strip("\\b"), t):
            activities.append(label)
    reply = "Thank you for telling me."
    if symptoms:
        reply = f"I'm sorry you're dealing with {symptoms[0]}. I've noted it."
    elif mood and mood >= 4:
        reply = "That's lovely to hear. I've noted it."
    return {
        "mood": mood, "pain": pain, "sleep_hours": sleep, "symptoms": symptoms, "activities": activities,
        "summary": f"{name} said: {utterance.strip()}", "reply": reply, "utterance": utterance.strip(),
    }


def answer_from_notes(question: str, notes: list[dict[str, Any]], name: str) -> dict[str, Any]:
    ranked = _rank_notes(question, notes)
    fallback = _extractive_answer(question, ranked)
    b = _llm()
    if not b or not ranked:
        return fallback
    context = "\n\n".join(f"[{i + 1}] {n['source']} ({short_date(parse(n['at']))}):\n{n['text']}" for i, n in enumerate(ranked[:4]))
    prompt = (
        f"Care notes for {name}:\n{context}\n\nQuestion: {question}\n\n"
        "Answer in 1-2 spoken sentences using ONLY the notes. If the notes don't cover it, say so and suggest asking "
        "the doctor or pharmacist. Return JSON: {\"answer\": str, \"sources\": [note numbers used]}"
    )
    try:
        data = parse_json(b.complete(VOICE_RULES, prompt, max_tokens=250, json_mode=True))
        if data and data.get("answer"):
            idx = [int(i) - 1 for i in data.get("sources") or [] if str(i).isdigit()]
            sources = [ranked[i]["source"] for i in idx if 0 <= i < len(ranked)] or [ranked[0]["source"]]
            return {"answer": str(data["answer"]), "sources": sources}
    except Exception as exc:
        log.warning("notes answer failed: %s", exc)
    return fallback


_STOP = set("a an the is are was were do does did i my me can should what when how much many to of for and or with about it on in at be".split())


def _rank_notes(question: str, notes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    q = {w for w in re.findall(r"[a-z]+", question.lower()) if w not in _STOP}
    # light stemming so "salty" matches "salt", "dizzy" matches "dizziness"
    q |= {w[:5] for w in q if len(w) > 5}

    def score(n: dict[str, Any]) -> int:
        words = set(re.findall(r"[a-z]+", (n["source"] + " " + n["text"]).lower()))
        return sum(len(w) for w in words if w in q or w[:5] in q)

    ranked = sorted(notes, key=score, reverse=True)
    return [n for n in ranked if score(n) > 0] or []


def _extractive_answer(question: str, ranked: list[dict[str, Any]]) -> dict[str, Any]:
    if not ranked:
        return {"answer": "I couldn't find that in the care notes. It's a good question for the doctor or pharmacist.",
                "sources": []}
    q = {w for w in re.findall(r"[a-z]+", question.lower()) if w not in _STOP}
    q |= {w[:5] for w in q if len(w) > 5}
    sentences = re.split(r"(?<=[.!?])\s+", ranked[0]["text"])
    best = max(sentences, key=lambda s: sum(len(w) for w in set(re.findall(r"[a-z]+", s.lower())) if w in q or w[:5] in q))
    src = ranked[0]["source"].split("·")[-1].strip()
    return {"answer": f"According to {src}: {best}", "sources": [ranked[0]["source"]]}


def draft_visit_brief(ctx: dict[str, Any]) -> dict[str, Any]:
    fallback = _template_visit(ctx)
    b = _llm()
    if not b:
        return fallback
    prompt = (
        f"Prepare a doctor-visit brief for {ctx['name']}'s appointment: {ctx['appointment']}.\n"
        f"FACTS (JSON): {json.dumps(ctx['facts'], default=str)[:6000]}\n\n"
        "Return JSON: {\"summary\": 2-3 plain sentences a doctor can read in 15 seconds, "
        "\"questions\": 3-5 specific questions the family should ask, \"bring\": 2-4 items to bring}. "
        "Do not diagnose; describe observations and ask."
    )
    try:
        data = parse_json(b.complete("You write concise, factual clinical-visit prep notes for families. No diagnosis.",
                                     prompt, max_tokens=500, json_mode=True))
        if data and data.get("summary"):
            return {
                "summary": str(data["summary"]),
                "questions": [str(q) for q in (data.get("questions") or fallback["questions"])][:5],
                "bring": [str(x) for x in (data.get("bring") or fallback["bring"])][:4],
            }
    except Exception as exc:
        log.warning("visit brief failed: %s", exc)
    return fallback


def _template_visit(ctx: dict[str, Any]) -> dict[str, Any]:
    name = ctx["name"]
    facts = ctx["facts"]
    adh = facts.get("adherence", {})
    sym = facts.get("symptoms") or []
    changed = [m for m in facts.get("medications", []) if m.get("change_note")]
    summary = f"{name} has taken {adh.get('pct', '?')}% of scheduled doses over the last two weeks"
    if adh.get("evening_pct") is not None and adh.get("morning_pct") is not None:
        summary += f" (mornings {adh['morning_pct']}%, evenings {adh['evening_pct']}%)"
    summary += "."
    if sym:
        s = sym[0]
        summary += f" Since {s['first_label']} she has reported {s['name']} {s['count']} times"
        if changed:
            c = changed[0]
            summary += f", starting shortly after her {c['name'].lower()} dose was changed on {c.get('changed_label') or 'a recent date'}"
            if c.get("change_note"):
                summary += f" ({c['change_note']})"
        summary += "."
    questions = []
    if sym and changed:
        questions.append(f"Could the {changed[0]['name'].lower()} increase be causing the {sym[0]['name']}? Should the dose be adjusted?")
    if adh.get("evening_pct") is not None and adh["evening_pct"] < 80:
        questions.append("Evening doses are often missed. Can any evening medication move to the morning?")
    questions.append("What blood pressure readings should prompt a call to the office?")
    questions.append("Is it safe to keep walking alone while the dizziness continues?")
    bring = ["Pill bottles or the pill organizer", "Home blood pressure log", "This brief (Nova can send it to the circle)"]
    return {"summary": summary, "questions": questions[:5], "bring": bring}
