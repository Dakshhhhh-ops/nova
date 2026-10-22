"""Demo household for Nova.

Rose Alvarez (81) lives alone in Columbus, Ohio. Her daughter Maya lives in
Seattle, her son Leo in Austin, and a home aide, Grace, visits twice a week.

The story the data tells: nine days ago Rose's cardiologist doubled her blood
pressure medicine. Two days later she started mentioning dizziness when she
stands up, she has stopped her daily walks, and her evening doses are slipping.
No single data point is alarming. Together they are worth a call to the doctor
before Friday's appointment. That is the pattern Nova is built to catch.

All dates are relative to "now", so the demo always looks current.
"""

from __future__ import annotations

import json
import random
from datetime import datetime, timedelta

from .store import Store, iso, now

# Demo bearer tokens. In production these come from Alexa+ account linking
# (OAuth 2.1); each token maps to exactly one person in the circle.
DEMO_TOKENS = {
    "nova-demo-rose": "rose",
    "nova-demo-maya": "maya",
    "nova-demo-leo": "leo",
    "nova-demo-grace": "grace",
}

PEOPLE = [
    dict(id="rose", name="Rose Alvarez", short_name="Rose", role="elder", relation="mom/grandma",
         location="Columbus, Ohio", device="Echo Show 8 · Kitchen", pronoun="she"),
    dict(id="maya", name="Maya Alvarez-Chen", short_name="Maya", role="caregiver", relation="daughter",
         location="Seattle, Washington", device="Echo Show 15 · Home office", pronoun="she"),
    dict(id="leo", name="Leo Alvarez", short_name="Leo", role="caregiver", relation="son",
         location="Austin, Texas", device="Echo Pop · Bedroom", pronoun="he"),
    dict(id="grace", name="Grace Okafor", short_name="Grace", role="caregiver", relation="home aide/aide",
         location="Columbus, Ohio", device="Alexa app", pronoun="she"),
]


# Evening doses have started slipping over the last five days (mornings hold).
EVENING_MISSES = {("metformin", 1), ("metformin", 3), ("metformin", 4), ("atorvastatin", 2), ("atorvastatin", 4)}


def seed(store: Store, *, rng_seed: int = 7) -> None:
    rng = random.Random(rng_seed)
    store.wipe()
    t = now()
    today = t.replace(hour=0, minute=0, second=0)

    for p in PEOPLE:
        store.x(
            "INSERT INTO people (id, name, short_name, role, relation, location, device, pronoun) "
            "VALUES (:id, :name, :short_name, :role, :relation, :location, :device, :pronoun)",
            p,
        )

    dose_change = today - timedelta(days=9)
    meds = [
        dict(id="lisinopril", name="Lisinopril", dose="20 mg", purpose="blood pressure",
             appearance="small pink oval pill", times=["08:00"], with_food=0,
             instructions="Stand up slowly. Report dizziness or fainting.",
             started=iso(today - timedelta(days=400)), changed_on=iso(dose_change),
             change_note="Dr. Patel raised it from 10 mg to 20 mg"),
        dict(id="metformin", name="Metformin", dose="500 mg", purpose="blood sugar",
             appearance="large white oblong pill", times=["08:00", "18:00"], with_food=1,
             instructions="Take with breakfast and with dinner, never on an empty stomach.",
             started=iso(today - timedelta(days=900)), changed_on=None, change_note=None),
        dict(id="atorvastatin", name="Atorvastatin", dose="40 mg", purpose="cholesterol",
             appearance="small white round pill", times=["21:00"], with_food=0,
             instructions="Avoid large amounts of grapefruit juice.",
             started=iso(today - timedelta(days=700)), changed_on=None, change_note=None),
        dict(id="vitamin_d", name="Vitamin D3", dose="2,000 IU", purpose="bone health",
             appearance="yellow softgel", times=["08:00"], with_food=1,
             instructions="Take with breakfast.",
             started=iso(today - timedelta(days=300)), changed_on=None, change_note=None),
    ]
    for m in meds:
        store.x(
            "INSERT INTO medications (id, person_id, name, dose, purpose, appearance, times, with_food, "
            "instructions, started, changed_on, change_note) VALUES (:id, 'rose', :name, :dose, :purpose, "
            ":appearance, :times, :with_food, :instructions, :started, :changed_on, :change_note)",
            {**m, "times": json.dumps(m["times"])},
        )

    # Fourteen days of dose history. Mornings are reliable; evenings have
    # started slipping over the last five days.
    for day_offset in range(14, -1, -1):
        day = today - timedelta(days=day_offset)
        for m in meds:
            for hhmm in m["times"]:
                hh, mm = (int(v) for v in hhmm.split(":"))
                at = day.replace(hour=hh, minute=mm)
                if day_offset == 0 and at > t - timedelta(minutes=45):
                    continue  # still upcoming today
                if day_offset == 0 and m["id"] == "metformin" and hh >= 17:
                    continue  # tonight's dinner dose not logged yet: shows as missed later in the day
                if hh >= 17 and (m["id"], day_offset) in EVENING_MISSES:
                    continue  # no log at all: a missed dose
                taken_at = at + timedelta(minutes=rng.randint(2, 40))
                who = "rose" if rng.random() > 0.15 else "grace"
                store.log_dose(m["id"], at, "taken", who, at=taken_at)

    # Home blood pressure: high before the dose change, dropping (and low on standing) after it.
    for days_ago, sys_, dia, pulse, pos, who in (
        (13, 154, 92, 74, "sitting", "grace"), (11, 150, 90, 72, "sitting", "grace"),
        (6, 118, 72, 70, "sitting", "grace"), (4, 112, 68, 68, "sitting", "rose"),
        (3, 104, 62, 76, "sitting", "grace"), (1, 106, 64, 78, "sitting", "rose"),
    ):
        store.add_bp("rose", sys_, dia, pulse, pos, who, at=(today - timedelta(days=days_ago)).replace(hour=10, minute=15))

    # Ten days of voice check-ins.
    checkins = [
        (10, 4, 2, 7.5, [], ["walk with neighbor Ruth"], "Slept fine. Walked to the corner store with Ruth."),
        (9, 4, 2, 7.0, [], ["garden club"], "Good day, garden club this afternoon."),
        (8, 4, 3, 7.0, [], ["walk"], "Knee is a little stiff but I did my walk."),
        (7, 3, 3, 6.5, ["dizzy when standing"], [], "Felt a bit woozy when I got out of bed."),
        (6, 4, 3, 6.5, [], ["called Leo"], "Talked to Leo, feeling alright."),
        (5, 3, 4, 6.0, ["dizzy when standing", "tired"], [], "Dizzy again getting up from the couch. Skipped my walk."),
        (4, 3, 4, 6.0, ["tired"], [], "Just tired today."),
        (3, 2, 5, 5.5, ["dizzy when standing", "knee pain"], [], "Had to hold the counter when I stood up. Knee aches."),
        (2, 3, 5, 5.5, ["knee pain"], [], "Didn't sleep great. Stayed in."),
        (1, 2, 5, 5.0, ["dizzy when standing", "tired"], [], "Dizzy in the morning again. Didn't go to garden club."),
    ]
    for days_ago, mood, pain, sleep, symptoms, activities, said in checkins:
        at = (today - timedelta(days=days_ago)).replace(hour=9, minute=rng.randint(5, 50))
        store.add_checkin("rose", {
            "mood": mood, "pain": pain, "sleep_hours": sleep, "symptoms": symptoms,
            "activities": activities, "utterance": said, "summary": said,
        }, at=at)

    # Messages in the circle.
    store.add_message("grace", "circle",
                      "Rose was a little unsteady getting up from the couch today. Sitting BP 104/62. "
                      "She says it passes after a minute.", at=today - timedelta(days=3) + timedelta(hours=15))
    store.add_message("leo", "circle", "I can drive Mom to her cardiology appointment.",
                      at=today - timedelta(days=2) + timedelta(hours=19, minutes=12))
    store.add_message("maya", "rose",
                      "Hi Mom! Lily's piano recital video is in the family album. Call you Sunday. Love you!",
                      at=today - timedelta(days=1) + timedelta(hours=20, minutes=40))
    store.mark_read([1, 2], "maya")

    # Appointments.
    appt_day = today + timedelta(days=2)
    store.add_appointment(dict(id="cardio-followup", person_id="rose", title="Cardiology follow-up",
                               provider="Dr. Anika Patel", at=iso(appt_day.replace(hour=10, minute=30)),
                               location="Ohio Heart Center, 3rd floor",
                               notes="Two-week recheck after lisinopril increase."))
    store.add_appointment(dict(id="grace-visit", person_id="rose", title="Grace's home visit",
                               provider="Grace Okafor", at=iso((today + timedelta(days=1)).replace(hour=10)),
                               location="Home", notes="Groceries, pill organizer refill."))
    store.add_appointment(dict(id="eye-exam", person_id="rose", title="Eye exam",
                               provider="Dr. Wen, Ophthalmology", at=iso((today + timedelta(days=19)).replace(hour=14)),
                               location="Eye Care Associates", notes="Annual diabetic eye exam."))

    # Care notes: what the doctors actually said.
    store.add_care_note("rose", "Cardiology visit summary · Dr. Anika Patel",
                        "Blood pressure averaging 152/90. Increase lisinopril from 10 mg to 20 mg once daily. "
                        "Recheck in two weeks. Keep salt under 2,000 mg a day. Stand up slowly. "
                        "Call the office if you have dizziness, fainting, or swelling in the ankles. "
                        "Office phone 614-555-0190.", at=dose_change + timedelta(hours=11))
    store.add_care_note("rose", "Knee discharge instructions · Riverside Orthopedics",
                        "Gentle walking 20 minutes a day. Ice the right knee for 15 minutes after activity. "
                        "For pain, acetaminophen up to 3,000 mg a day. Avoid ibuprofen and naproxen because of "
                        "blood pressure and kidney function.", at=today - timedelta(days=120))
    store.add_care_note("rose", "Dietitian notes",
                        "Diabetes-friendly meals. Take metformin with breakfast and with dinner. "
                        "Good breakfasts: oatmeal with berries, eggs, whole-grain toast. "
                        "Limit grapefruit juice while on atorvastatin.", at=today - timedelta(days=60))
    store.add_care_note("rose", "Emergency info",
                        "Allergies: penicillin (rash). Primary care: Dr. James Moore, 614-555-0101. "
                        "Pharmacy: CVS on High Street, 614-555-0142. Spare key with neighbor Ruth at 41 Elm.",
                        at=today - timedelta(days=200))

    for cat in ("medications", "wellbeing", "appointments", "messages"):
        store.set_sharing("rose", cat, True)


def ensure_seeded(store: Store) -> None:
    if store.is_empty():
        seed(store)


if __name__ == "__main__":  # python -m nova_server.seed
    from .server import DB_PATH

    s = Store(DB_PATH)
    seed(s)
    print(f"Seeded demo household into {DB_PATH} at {datetime.now():%Y-%m-%d %H:%M}")
