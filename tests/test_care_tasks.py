"""Care follow-through: ownership, audit history, persistence and MCP authorization."""
import os
import sqlite3
import tempfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

os.environ.setdefault("NOVA_LLM", "rules")
os.environ.setdefault("NOVA_DB", str(Path(tempfile.mkdtemp()) / "nova-test.db"))

import pytest
from mcp import Client
from nova_server import server
from nova_server.seed import seed
from nova_server.store import SCHEMA, Store, freeze


@pytest.fixture(autouse=True)
def household():
    freeze(datetime.now().replace(hour=10, minute=0, second=0, microsecond=0))
    seed(server.store)
    yield
    freeze(None)


async def call(name, args, person="maya"):
    server.set_stdio_user(person)
    async with Client(server.mcp) as client:
        out = await client.call_tool(name, args)
        assert not out.is_error, out.content
        return out.structured_content


async def test_claim_record_and_resolve_survive_a_new_store_connection():
    aid = server.store.add_alert("rose", "watch", "follow-up", "Check in with Rose")
    claimed = await call("update_care_task", {"alert_id": aid, "action": "claim"})
    assert claimed["alert"]["owner_name"] == "Maya"
    assert claimed["alert"]["workflow"] == "claimed"
    conflict = await call("update_care_task", {"alert_id": aid, "action": "claim"}, "leo")
    assert conflict["error"] and "Maya" in conflict["speech"]
    rejected = await call("resolve_alert", {"alert_id": aid}, "leo")
    assert rejected["error"]
    recorded = await call("update_care_task", {"alert_id": aid, "action": "record_action", "note": "Called Rose and checked in"})
    assert recorded["alert"]["workflow"] == "action_recorded"
    assert recorded["alert"]["status"] == "open"
    resolved = await call("resolve_alert", {"alert_id": aid, "note": "Follow-up complete"})
    assert resolved["alert"]["workflow"] == "resolved"
    history = await call("list_alerts", {"include_resolved": True})
    assert any(a["id"] == aid and a["workflow"] == "resolved" for a in history["alerts"])
    reopened = Store(server.store.path)
    try:
        alert = next(a for a in reopened.alerts("rose", None) if a["id"] == aid)
        assert [e["action"] for e in alert["activity"]] == ["claim", "record_action", "resolve"]
        assert alert["handled_by"] == "maya" and alert["handled_at"]
        assert alert["activity"][1]["note"] == "Called Rose and checked in"
    finally:
        reopened._db.close()


async def test_empty_actions_and_alerts_from_another_household_are_rejected():
    aid = server.store.add_alert("rose", "watch", "follow-up", "Check in")
    empty = await call("update_care_task", {"alert_id": aid, "action": "record_action", "note": " "})
    assert empty["error"]
    other = server.store.add_alert("another-household", "watch", "follow-up", "Private")
    assert (await call("update_care_task", {"alert_id": other, "action": "claim"}))["error"]
    assert (await call("resolve_alert", {"alert_id": other}))["error"]
    elder = await call("update_care_task", {"alert_id": aid, "action": "claim"}, "rose")
    assert elder["error"]


def test_simultaneous_claims_have_only_one_owner():
    aid = server.store.add_alert("rose", "watch", "follow-up", "Check in")

    def claim(who):
        try:
            server.store.update_alert(aid, "rose", who, "claim")
            return who
        except ValueError:
            return None

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(claim, ("maya", "leo")))
    assert len([r for r in results if r]) == 1
    alert = next(a for a in server.store.alerts("rose") if a["id"] == aid)
    assert alert["claimed_by"] in results
    assert len(alert["activity"]) == 1


def test_existing_database_migrates_without_losing_alerts():
    path = Path(tempfile.mkdtemp()) / "old.db"
    with sqlite3.connect(path) as db:
        db.executescript(SCHEMA)
        db.execute("INSERT INTO alerts (person_id, at, severity, kind, message) VALUES ('rose', '2026-10-23T10:00:00', 'watch', 'follow-up', 'Existing task')")
    migrated = Store(path)
    try:
        alert = migrated.alerts("rose")[0]
        assert alert["message"] == "Existing task" and alert["workflow"] == "open"
        assert alert["activity"] == []
        assert "expected_who" in {r[1] for r in migrated._db.execute("PRAGMA table_info(signals)")}
    finally:
        migrated._db.close()


async def test_voice_follow_up_records_action_without_resolving():
    from simulator.rules import route
    aid = server.store.add_alert("rose", "urgent", "follow-up", "Call Rose")
    claim = route("I'll handle this", "caregiver")
    out = await call(claim["name"], claim["args"])
    assert out["alert"]["id"] == aid and out["alert"]["claimed_by"] == "maya"
    record = route("I called Rose and checked in", "caregiver")
    out = await call(record["name"], record["args"])
    assert out["alert"]["status"] == "open"
    assert out["alert"]["activity"][-1]["by_name"] == "Maya"
