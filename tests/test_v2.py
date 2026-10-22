"""v2: proactive care engine, vision (pill check, reconciliation), Ring, announcements."""

from __future__ import annotations

import base64
import os
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

import pytest

os.environ.setdefault("NOVA_LLM", "rules")
os.environ.setdefault("NOVA_DB", str(Path(tempfile.mkdtemp()) / "nova-test.db"))

from mcp import Client  # noqa: E402

from nova_server import server  # noqa: E402
from nova_server import store as store_mod  # noqa: E402
from nova_server.engine import CareEngine  # noqa: E402
from nova_server.seed import seed  # noqa: E402

SAMPLES = Path(__file__).resolve().parent.parent / "samples"
TODAY = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)


def at(hh: int, mm: int = 0) -> datetime:
    return TODAY.replace(hour=hh, minute=mm)


def freeze_and_seed(t: datetime) -> CareEngine:
    store_mod.freeze(t)
    seed(server.store)
    eng = CareEngine(server.store)
    eng.tick(t)
    return eng


def b64(name: str) -> str:
    return "data:image/png;base64," + base64.b64encode((SAMPLES / name).read_bytes()).decode()


async def call(name: str, args: dict | None = None, as_person: str = "rose") -> dict:
    server.set_stdio_user(as_person)
    async with Client(server.mcp) as c:
        r = await c.call_tool(name, args or {})
        assert not r.is_error, r.content
        return r.structured_content


def run(eng: CareEngine, start: datetime, end: datetime, step_min: int = 5) -> list[str]:
    fired = []
    t = start
    while t <= end:
        store_mod.freeze(t)
        fired += eng.tick(t)
        t += timedelta(minutes=step_min)
    return fired


# -- engine ------------------------------------------------------------------
def test_escalation_ladder_for_missed_evening_dose():
    eng = freeze_and_seed(at(17, 50))
    fired = run(eng, at(17, 55), at(19, 40))
    keys = [k.split(":")[0] for k in fired]
    assert keys.count("dose_reminder") == 1 and "dose_followup" in keys and "escalate" in keys
    maya = server.store.announcements("maya")
    esc = next(a for a in maya if a["kind"] == "caregiver_escalation")
    assert "6 PM" in esc["speech"] and "Metformin" in esc["speech"]
    assert any(a["kind"].startswith("missed-") for a in server.store.alerts("rose"))


def test_taking_the_dose_stops_the_ladder():
    eng = freeze_and_seed(at(17, 50))
    run(eng, at(17, 55), at(18, 5))
    server.store.log_dose("metformin", at(18), "taken", "rose", at=at(18, 6))
    fired = run(eng, at(18, 10), at(19, 40))
    assert not [k for k in fired if k.startswith(("dose_followup:", "escalate:")) and "1800" in k]


def test_time_jump_does_not_replay_the_day():
    eng = freeze_and_seed(at(7, 0))
    store_mod.freeze(at(20, 0))
    assert eng.tick(at(20, 0)) == []


def test_morning_checkin_prompt_and_wellness_escalation():
    eng = freeze_and_seed(at(8, 50))
    server.store.x("DELETE FROM dose_events WHERE logged_at >= ?", (store_mod.iso(TODAY),))  # quiet morning
    fired = run(eng, at(8, 55), at(11, 40))
    assert any(k.startswith("checkin:") for k in fired)
    assert any(k.startswith("wellness:") for k in fired)
    assert any(k.startswith("wellness-escalate:") for k in fired)


def test_ring_visitor_and_night_door():
    eng = freeze_and_seed(at(10, 2))
    out = eng.on_ring_event("ding", "grace")
    assert out["ok"] and any("maya" in k for k in out["announced"])
    store_mod.freeze(at(23, 40))
    night = eng.on_ring_event("door_open", "rose")
    assert night["announced"] and any(a["severity"] == "urgent" for a in server.store.announcements("maya"))


async def test_announcement_resource_delivers_once():
    freeze_and_seed(at(12, 0))
    server.store.announce("rose", "info", "Hi", "Hello Rose")
    server.set_stdio_user("rose")
    async with Client(server.mcp) as c:
        first = await c.read_resource("nova://announcements")
        second = await c.read_resource("nova://announcements")
    import json
    assert len(json.loads(first.contents[0].text)["items"]) == 1
    assert json.loads(second.contents[0].text)["items"] == []


async def test_messages_become_live_announcements():
    freeze_and_seed(at(12, 0))
    await call("send_message", {"to": "Mom", "message": "Calling you Sunday"}, as_person="maya")
    assert any(a["kind"] == "message" and "Sunday" in a["speech"] for a in server.store.announcements("rose"))


async def test_snooze_replaces_follow_up():
    eng = freeze_and_seed(at(17, 55))
    run(eng, at(18, 0), at(18, 0))
    out = await call("snooze_reminder", {"minutes": 10})
    assert "10 minutes" in out["speech"]
    fired = run(eng, at(18, 5), at(18, 40))
    assert not any(k.startswith("dose_followup:") for k in fired)


# -- vision -----------------------------------------------------------------
async def test_pill_check_wrong_time_in_the_morning():
    freeze_and_seed(at(8, 10))
    out = await call("check_pill_photo", {"image_base64": b64("pill-atorvastatin.png")})
    assert out["verdict"] == "wrong_time"
    assert out["matched_med"]["name"] == "Atorvastatin"
    assert "put it back" in out["speech"].lower()


async def test_pill_check_already_taken():
    freeze_and_seed(at(20, 30))
    out = await call("check_pill_photo", {"image_base64": b64("pill-lisinopril.png")})
    assert out["verdict"] == "already_taken"


async def test_reconcile_after_visit_summary_then_catch_old_bottle():
    freeze_and_seed(at(12, 30))
    doc = await call("read_care_document", {"image_base64": b64("after-visit-summary.png")}, as_person="maya")
    change = next(c for c in doc["changes"] if c["op"] == "change")
    assert change["name"] == "Lisinopril" and change["new_dose"] == "10 mg"
    assert {c["op"] for c in doc["changes"]} == {"change", "continue"}
    applied = await call("apply_care_changes", {"change_set_id": doc["change_set_id"], "approve": True}, as_person="maya")
    assert applied["status"] == "applied"
    assert any(m["name"] == "Lisinopril" and m["dose"] == "10 mg" for m in applied["plan"])
    assert any(a["kind"] == "care_plan_change" for a in server.store.announcements("rose"))
    # Rose later shows the old 20 mg bottle: Nova catches the outdated strength.
    out = await call("check_pill_photo", {"image_base64": b64("pill-lisinopril.png")})
    assert out["verdict"] == "dose_mismatch"
    again = await call("apply_care_changes", {"change_set_id": doc["change_set_id"]}, as_person="maya")
    assert again["status"] == "applied" and not again["applied"]


async def test_recent_activity_reports_ring():
    eng = freeze_and_seed(at(10, 5))
    eng.on_ring_event("ding", "grace")
    out = await call("recent_activity", {}, as_person="maya")
    assert "grace" in out["speech"].lower()


@pytest.fixture(autouse=True)
def _unfreeze():
    yield
    store_mod.freeze(None)


# -- vitals -----------------------------------------------------------------
async def test_bp_evidence_and_limits_from_notes():
    freeze_and_seed(at(12, 0))
    out = await call("care_briefing", {}, as_person="maya")
    top = out["insights"][0]
    assert top["evidence"][0].startswith("Home BP averaged 152/91 before the change")
    assert out["wellbeing"]["bp"]
    low = await call("log_vitals", {"systolic": 96, "diastolic": 58})
    assert low["out_of_range"] and low["alert_id"]
    assert any(a["kind"] == "caregiver_escalation" and "96 over 58" in a["speech"] for a in server.store.announcements("maya"))
    ok = await call("log_vitals", {"systolic": 118, "diastolic": 72})
    assert not ok["out_of_range"] and "within the range" in ok["speech"]


def test_bp_prompt_only_after_doctor_asks():
    eng = freeze_and_seed(at(7, 40))
    assert not any(k.startswith("bp:") for k in run(eng, at(7, 45), at(7, 50)))
    server.store.add_care_note("rose", "After Visit Summary · Dr. Anika Patel", "Check blood pressure every morning before pills.")
    eng2 = CareEngine(server.store)
    store_mod.freeze(at(7, 40))
    eng2.tick(at(7, 40))
    assert any(k.startswith("bp:") for k in run(eng2, at(7, 45), at(7, 50)))


# -- weekly digest ----------------------------------------------------------
def test_sunday_digest_reaches_the_family():
    sunday = TODAY + timedelta(days=(6 - TODAY.weekday()) % 7)
    eng = freeze_and_seed(sunday.replace(hour=17, minute=50))
    fired = run(eng, sunday.replace(hour=17, minute=55), sunday.replace(hour=18, minute=5))
    assert {k.split(":")[-1] for k in fired if k.startswith("digest:")} == {"maya", "leo"}
    text = next(a for a in server.store.announcements("maya") if a["title"] == "Rose's week")["speech"]
    assert "percent of her doses" in text and "Blood pressure averaged" in text


# -- refills ----------------------------------------------------------------
async def test_low_supply_nudge_refill_and_pharmacy_ready():
    eng = freeze_and_seed(at(9, 50))
    fired = run(eng, at(9, 55), at(10, 5))
    assert any(k.startswith("low:metformin") for k in fired)
    out = await call("request_refill", {"medication": "metformin"})
    assert "Elm Street Pharmacy" in out["speech"] and out["refill"]["status"] == "requested"
    again = await call("request_refill", {"medication": "metformin"})
    assert "already" in again["speech"]
    assert any(a["title"] == "Refill ordered" for a in server.store.announcements("maya"))
    fired = run(eng, at(10, 10), at(12, 20), step_min=10)
    assert any(k.startswith("refill-ready:") for k in fired)
    today = await call("get_today", {})
    assert any(r["status"] == "ready" for r in today["refills"])


async def test_logging_doses_uses_supply():
    freeze_and_seed(at(18, 20))
    before = {m["id"]: m["supply"] for m in server.store.medications("rose")}
    out = await call("log_medication", {"medication": "metformin", "time_of_day": "evening"})
    after = {m["id"]: m["supply"] for m in server.store.medications("rose")}
    assert after["metformin"] == before["metformin"] - 1
    assert out["low_supply"] and "refill" in out["speech"]
