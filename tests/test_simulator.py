"""The Alexa+ simulator's HTTP API against a real Nova MCP server (Streamable HTTP)."""

from __future__ import annotations

import base64
import os
import socket
import tempfile
import threading
import time
from pathlib import Path

import pytest

os.environ.setdefault("NOVA_LLM", "rules")
os.environ.setdefault("NOVA_DB", str(Path(tempfile.mkdtemp()) / "nova-test.db"))

from nova_server import server  # noqa: E402
from nova_server.seed import seed  # noqa: E402

SAMPLES = Path(__file__).resolve().parent.parent / "samples"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def sim():
    import uvicorn
    from fastapi.testclient import TestClient

    seed(server.store)
    port = _free_port()
    srv = uvicorn.Server(uvicorn.Config(server.mcp.streamable_http_app(host="127.0.0.1"), host="127.0.0.1",
                                       port=port, log_level="warning"))
    th = threading.Thread(target=srv.run, daemon=True)
    th.start()
    for _ in range(100):
        if srv.started:
            break
        time.sleep(0.05)
    os.environ["NOVA_MCP_URL"] = f"http://127.0.0.1:{port}/mcp"
    import importlib

    import simulator.app as app_mod

    app_mod = importlib.reload(app_mod)
    with TestClient(app_mod.app) as client:
        yield client
    srv.should_exit = True
    th.join(timeout=5)


def test_status_and_pages(sim):
    st = sim.get("/api/status").json()
    assert st["mcp"]["connected"] and len(st["mcp"]["tools"]) >= 20
    assert {d["id"] for d in st["devices"]} == {"kitchen", "maya"}
    assert sim.get("/live").status_code == 200 and sim.get("/").status_code == 200


def test_chat_returns_reply_and_card(sim):
    out = sim.post("/api/chat", json={"device": "maya", "text": "How's Mom doing?"}).json()
    assert "lisinopril" in out["reply"].lower()
    assert out["cards"] and out["cards"][0]["resource_uri"] == "ui://nova/briefing.html"
    assert out["cards"][0]["html"].lower().startswith("<!doctype html")
    kinds = [t["kind"] for t in out["trace"]]
    assert kinds[0] == "user" and "tool_call" in kinds and kinds[-1] == "reply"


def test_vision_ring_clock_and_notifications(sim):
    img = "data:image/png;base64," + base64.b64encode((SAMPLES / "pill-ibuprofen.png").read_bytes()).decode()
    out = sim.post("/api/vision", json={"device": "kitchen", "kind": "pill", "image": img}).json()
    assert "don't take ibuprofen" in out["reply"].lower()
    assert out["cards"][0]["resource_uri"] == "ui://nova/pillcheck.html"

    ring = sim.post("/api/ring/event", json={"kind": "ding", "who": "grace"}).json()
    assert ring["ok"] and ring["announced"]

    clock = sim.post("/api/clock", json={"speed": 1}).json()
    assert "now" in clock and clock["speed"] == 1

    notes = sim.get("/api/announcements", params={"device": "maya"}).json()["items"]
    assert not any("Grace arrived" in n["speech"] for n in notes)
    from mcp import Client
    import asyncio

    async def confirm():
        server.set_stdio_user("rose")
        async with Client(server.mcp) as c:
            result = await c.call_tool("confirm_visit", {"signal_id": ring["signal"]["id"], "confirmed": True})
            assert not result.is_error and result.structured_content["status"] == "confirmed"

    asyncio.run(confirm())
    notes = sim.get("/api/announcements", params={"device": "maya"}).json()["items"]
    assert any("Grace arrived" in n["speech"] for n in notes)
    ann_id = notes[0]["id"]
    assert sim.post(f"/api/announcements/{ann_id}/ack", json={"device": "maya", "action": "dismissed"}).json()["ok"]

    samples = sim.get("/api/samples").json()["samples"]
    assert {"pill-ibuprofen", "after-visit-summary"} <= {s["id"] for s in samples}
    assert sim.get("/samples/pill-ibuprofen.png").status_code == 200


def test_reset(sim):
    assert sim.post("/api/reset").json()["ok"]
    assert sim.get("/api/timeline").json()["items"]


def test_say_that_again(sim):
    first = sim.post("/api/chat", json={"device": "kitchen", "text": "What did the doctor say about salt?"}).json()["reply"]
    again = sim.post("/api/chat", json={"device": "kitchen", "text": "Can you say that again?"}).json()
    assert again["reply"] == first and again["brain"] == "repeat"


def test_short_reply_then_tell_me_more(sim):
    sim.post("/api/reset")
    brief = sim.post("/api/chat", json={"device": "maya", "text": "How's Mom doing?"}).json()["reply"]
    assert brief.endswith("Want the details?") and len(brief.split()) <= 40
    more = sim.post("/api/chat", json={"device": "maya", "text": "Yes"}).json()
    assert more["brain"] == "more" and "blood pressure" in more["reply"]
    visit = sim.post("/api/chat", json={"device": "maya", "text": "Yes please"}).json()
    assert any(c["resource_uri"] == "ui://nova/visit.html" for c in visit["cards"])


def test_model_turn_speaks_tool_speech_without_a_second_call(sim, monkeypatch):
    """Speech-first: when the tool returns a line written for the ear, the model is called once, not twice."""
    from nova_server import llm

    calls = []

    class FakeNova(llm.Backend):
        name, label = "bedrock", "Amazon Nova 2 Lite · Amazon Bedrock"

        def step(self, system, history, tools):
            calls.append(len(history))
            if len(calls) > 1:
                raise AssertionError("second model call should be skipped")
            return llm.Step(tool_calls=[{"id": "t1", "name": "care_briefing", "args": {}}])

    monkeypatch.setattr(llm, "_BACKEND", FakeNova())
    out = sim.post("/api/chat", json={"device": "maya", "text": "How's Mom doing?"}).json()
    assert len(calls) == 1
    assert out["reply"].endswith("Want the details?") and "lisinopril" in out["reply"].lower()
    assert out["brain"] == "Amazon Nova 2 Lite · Amazon Bedrock"
    more = sim.post("/api/chat", json={"device": "maya", "text": "Tell me more"}).json()
    assert more["brain"] == "more" and "110 over 66" in more["reply"]


def test_ring_sync_without_a_token_explains_how_to_link(sim, monkeypatch):
    monkeypatch.delenv("RING_ACCESS_TOKEN", raising=False)
    monkeypatch.delenv("RING_REFRESH_TOKEN", raising=False)
    assert sim.get("/api/status").json()["ring"]["linked"] is False
    out = sim.post("/api/ring/sync").json()
    assert out["linked"] is False and "RING_ACCESS_TOKEN" in out["error"]
