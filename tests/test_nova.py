"""Nova tests: tools in-process, plus one real Streamable HTTP round trip with auth and consent."""

from __future__ import annotations

import os
import socket
import tempfile
import threading
import time
from datetime import datetime
from pathlib import Path

import pytest

os.environ.setdefault("NOVA_LLM", "rules")
os.environ.setdefault("NOVA_DB", str(Path(tempfile.mkdtemp()) / "nova-test.db"))

from mcp import Client  # noqa: E402

from nova_server import insights as ins  # noqa: E402
from nova_server import server  # noqa: E402
from nova_server.seed import seed  # noqa: E402
from nova_server import store as store_mod  # noqa: E402


@pytest.fixture(autouse=True)
def fresh_household():
    # Freeze the household clock at 9:30 PM so results don't depend on when tests run.
    store_mod.freeze(datetime.now().replace(hour=21, minute=30, second=0, microsecond=0))
    seed(server.store)
    server.set_stdio_user("rose")
    yield


async def call(name: str, args: dict | None = None, as_person: str = "rose") -> dict:
    server.set_stdio_user(as_person)
    async with Client(server.mcp) as c:
        r = await c.call_tool(name, args or {})
        assert not r.is_error, r.content
        return r.structured_content


async def test_lists_all_tools_with_ui_metadata():
    async with Client(server.mcp) as c:
        tools = {t.name: t for t in (await c.list_tools()).tools}
    assert {"get_today", "log_medication", "daily_checkin", "care_briefing", "prepare_visit"} <= set(tools)
    assert tools["care_briefing"].meta["ui"]["resourceUri"] == "ui://nova/briefing.html"
    assert tools["get_today"].annotations.read_only_hint is True
    # the consent parameter is resolved server-side, never exposed to the model
    assert list(tools["daily_checkin"].input_schema["properties"]) == ["how_are_you_feeling"]


async def test_double_dose_guard():
    out = await call("log_medication", {"medication": "the pink one"})
    assert out["warning"] == "double_dose_risk"
    assert "don't take another" in out["speech"]


async def test_logs_by_purpose_and_reports_status():
    await call("log_medication", {"medication": "cholesterol", "time_of_day": "bedtime"})
    out = await call("check_medication", {"medication": "atorvastatin"})
    assert any(d["med_id"] == "atorvastatin" and d["status"] == "taken" for d in out["doses"])


async def test_briefing_connects_dizziness_to_dose_change():
    out = await call("care_briefing", {"period": "week"}, as_person="maya")
    assert out["status"] == "watch"
    top = out["insights"][0]
    assert top["related"]["medication"] == "Lisinopril"
    assert top["related"]["symptom"] == "dizziness"
    assert any("Grace" in e for e in top["evidence"])  # corroborated by the home aide
    assert "614-555-0190" in top["suggestion"]  # cites the doctor's own instruction
    assert any(a["kind"] == "after-change-lisinopril-dizziness" for a in out["alerts"])


async def test_evening_doses_pattern():
    found = ins.detect_insights(server.store, "rose")
    assert any(i["id"] == "evening-doses" for i in found)


async def test_privacy_elder_controls_sharing():
    await call("set_sharing", {"category": "medications", "shared_with_circle": False})
    out = await call("check_medication", {}, as_person="maya")
    assert out.get("not_shared") == "medications"
    denied = await call("set_sharing", {"category": "medications", "shared_with_circle": True}, as_person="maya")
    assert denied["sharing"] is None  # only Rose can change it


async def test_care_notes_answer_is_grounded():
    out = await call("ask_care_notes", {"question": "Can I take ibuprofen for my knee?"})
    assert "ibuprofen" in out["answer"].lower()
    assert out["sources"]


async def test_red_flag_alerts_circle_without_asking():
    out = await call("daily_checkin", {"how_are_you_feeling": "I fell in the bathroom"})
    assert "fall" in out["red_flags"]
    assert out["alert_id"]
    assert "911" in out["speech"]


async def test_messages_round_trip():
    await call("send_message", {"to": "Mom", "message": "Calling you Sunday"}, as_person="maya")
    out = await call("read_messages", {})
    assert any(m["from"] == "Maya" and "Sunday" in m["text"] for m in out["messages"])


async def test_visit_brief_has_questions():
    out = await call("prepare_visit", {"appointment": "cardiology"})
    assert out["appointment"]["provider"] == "Dr. Anika Patel"
    assert len(out["questions"]) >= 3
    assert any(s["name"] == "dizziness" for s in out["symptoms"])


# ---------------------------------------------------------------------------
# Real Streamable HTTP: bearer auth + elicitation (consent) round trip
# ---------------------------------------------------------------------------
def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def http_server():
    import uvicorn

    port = _free_port()
    app = server.mcp.streamable_http_app(host="127.0.0.1")
    cfg = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")
    srv = uvicorn.Server(cfg)
    th = threading.Thread(target=srv.run, daemon=True)
    th.start()
    for _ in range(100):
        if srv.started:
            break
        time.sleep(0.05)
    yield f"http://127.0.0.1:{port}/mcp"
    srv.should_exit = True
    th.join(timeout=5)


async def test_http_requires_token(http_server):
    import httpx

    r = httpx.post(http_server, json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
                   headers={"accept": "application/json, text/event-stream"})
    assert r.status_code == 401


async def test_http_consent_flow(http_server):
    import httpx2
    from mcp.client.streamable_http import streamable_http_client
    from mcp_types import ElicitResult

    asked: list[str] = []

    async def on_elicit(_ctx, params):
        asked.append(params.message)
        return ElicitResult(action="accept", content={"notify": True})

    async with httpx2.AsyncClient(headers={"Authorization": "Bearer nova-demo-rose"}) as http:
        async with Client(streamable_http_client(http_server, http_client=http), elicitation_callback=on_elicit) as c:
            r = await c.call_tool("daily_checkin", {"how_are_you_feeling": "I'm a bit dizzy this morning"})
    out = r.structured_content
    assert asked and "Maya" in asked[0]
    assert out["shared_with"]
    assert "let Maya" in out["speech"]


async def test_checkin_without_elicitation_support_still_works():
    # A client that can't ask questions (no elicitation capability) must not get an error;
    # the symptom is recorded and stays private by default.
    out = await call("daily_checkin", {"how_are_you_feeling": "I'm a bit dizzy this morning"})
    assert out["checkin"] and out["shared_with"] == []
