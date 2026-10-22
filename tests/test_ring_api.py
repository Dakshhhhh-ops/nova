"""Ring Partner API client and sync, against recorded-shape fixtures (no token needed in CI)."""

from __future__ import annotations

import json
import os
import re
import tempfile
from datetime import datetime
from pathlib import Path

os.environ.setdefault("NOVA_LLM", "rules")
os.environ.setdefault("NOVA_DB", str(Path(tempfile.mkdtemp()) / "nova-test.db"))

import httpx  # noqa: E402
import pytest  # noqa: E402

from nova_server import ring_api, server  # noqa: E402
from nova_server import store as store_mod  # noqa: E402
from nova_server.engine import CareEngine  # noqa: E402
from nova_server.seed import seed  # noqa: E402

FIX = Path(__file__).resolve().parent / "fixtures" / "ring"
NOW = datetime(2026, 10, 23, 10, 0)  # the household's wall clock during the sync
FRONT, BACK = "ava1.ring.device.FRONTDOOR01", "ava1.ring.device.BACKYARD02"


def fixture(name: str) -> dict:
    text = (FIX / name).read_text(encoding="utf-8")
    # "{{2026-10-23T09:58:20}}" (local time) -> epoch milliseconds, as Ring returns them
    text = re.sub(r'"\{\{([0-9T:-]+)\}\}"', lambda m: str(int(datetime.fromisoformat(m.group(1)).timestamp() * 1000)), text)
    return json.loads(text)


class FakeRing:
    """An httpx transport that answers like api.amazonvision.com and records what Nova sent."""

    def __init__(self, *, fail: dict[str, tuple[int, str]] | None = None, throttle_once: bool = False) -> None:
        self.requests: list[httpx.Request] = []
        self.fail = fail or {}
        self.throttle_once = throttle_once

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        if self.throttle_once:
            self.throttle_once = False
            return httpx.Response(429, headers={"Retry-After": "0"}, json={"errors": [{"status": "429", "title": "Too Many Requests"}]})
        if path in self.fail:
            code, name = self.fail[path]
            return httpx.Response(code, json=fixture(name))
        routes = {
            "/v1/users/me": "users_me.json",
            "/v1/devices": "devices.json",
            f"/v1/devices/{FRONT}/status": "status_frontdoor.json",
            f"/v1/history/devices/{BACK}/events": "events_empty.json",
        }
        if path == f"/v1/devices/{BACK}/status":
            return httpx.Response(503, json=fixture("status_backyard_offline.json"))
        if path == f"/v1/history/devices/{FRONT}/events":
            page = "events_frontdoor_page2.json" if request.url.params.get("page[key]") else "events_frontdoor_page1.json"
            return httpx.Response(200, json=fixture(page))
        if path in routes:
            return httpx.Response(200, json=fixture(routes[path]))
        return httpx.Response(404, json={"errors": [{"status": "404", "title": "Not Found"}]})


@pytest.fixture()
def household():
    store_mod.freeze(datetime(2026, 10, 22, 8, 0))  # seed the day before: Grace's visit is Oct 23 at 10:00
    seed(server.store)
    store_mod.freeze(NOW)
    return server.store, CareEngine(server.store)


def api_with(fake: FakeRing) -> ring_api.RingAPI:
    return ring_api.RingAPI("playground-token", transport=httpx.MockTransport(fake))


def test_sync_imports_care_events_and_device_health(household):
    store, engine = household
    fake = FakeRing()
    res = ring_api.sync(store, engine, api_with(fake), real_now=NOW)
    assert res["ok"] and res["account"] == {"id": "ava1.ring.account.ROSE7X2Q", "first_name": "Rose"}  # no email kept
    by_id = {e["id"]: e for e in res["imported"]}
    # A doorbell press two minutes before Grace's 10:00 visit is Grace; it's fresh, so it's announced.
    assert by_id["evt_8f2c1a_ding"]["who"] == "grace" and by_id["evt_8f2c1a_ding"]["announced"]
    assert by_id["evt_8f2b90_motion"]["event_type"] == "motion.human"
    # Page 2 (followed via links.next): yesterday's press goes on the timeline without an announcement.
    assert by_id["evt_7a0e12_ding"]["announced"] is False and by_id["evt_7a0e12_ding"]["who"] == "unknown"
    # Vehicles aren't care signals; two-week-old history is out of range.
    assert "evt_8f1d44_vehicle" not in by_id and "evt_5c3301_ding" not in by_id
    devices = {d["id"]: d for d in res["devices"]}
    assert devices[FRONT]["online"] is True and devices[BACK]["online"] is False  # 503 = device offline
    kinds = [s["kind"] for s in store.q("SELECT kind FROM signals ORDER BY id")]
    assert kinds.count("ding") == 2 and "motion" in kinds and "device_offline" in kinds
    grace_note = store.q("SELECT * FROM announcements WHERE to_id = 'grace'")
    assert grace_note and "visit" in grace_note[0]["speech"].lower()
    paths = [c["path"] for c in res["calls"]]
    assert paths[0] == "/v1/users/me" and "/v1/devices" in paths
    assert f"/v1/history/devices/{FRONT}/events?event_types=ding,motion.human" in paths
    assert any("page[key]=eyJrIjoiOGYxZDQ0In0" in p for p in paths)


def test_second_sync_imports_nothing_new(household):
    store, engine = household
    ring_api.sync(store, engine, api_with(FakeRing()), real_now=NOW)
    again = ring_api.sync(store, engine, api_with(FakeRing()), real_now=NOW)
    assert again["ok"] and again["imported"] == [] and again["skipped"] >= 5
    assert len(store.q("SELECT * FROM signals WHERE kind = 'device_offline'")) == 1  # once a day


def test_sends_the_headers_ring_requires(household):
    store, engine = household
    fake = FakeRing()
    ring_api.sync(store, engine, api_with(fake), real_now=NOW)
    r = fake.requests[0]
    assert r.headers["authorization"] == "Bearer playground-token"
    assert r.headers["user-agent"].startswith("NovaCareCircle/")
    assert re.fullmatch(r"[0-9a-f-]{36}", r.headers["hardware_id"])  # missing headers get a 406 from Ring
    assert all(req.url.host == "api.amazonvision.com" for req in fake.requests)
    assert all(req.url.params.get("event_types") == "ding,motion.human"
               for req in fake.requests if "/history/" in req.url.path)  # minimum necessary


def test_expired_token_is_reported_not_raised(household):
    store, engine = household
    fake = FakeRing(fail={"/v1/users/me": (401, "error_401.json")})
    res = ring_api.sync(store, engine, api_with(fake), real_now=NOW)
    assert res["ok"] is False and res["status"] == 401 and "Playground" in res["hint"]


def test_rate_limit_is_retried_once(household):
    store, engine = household
    fake = FakeRing(throttle_once=True)
    res = ring_api.sync(store, engine, api_with(fake), real_now=NOW)
    assert res["ok"] and res["calls"][0]["status"] == 429 and res["calls"][1]["status"] == 200


def test_sync_route_and_recent_activity_use_ring(household, monkeypatch):
    from mcp import Client
    from starlette.testclient import TestClient

    fake = FakeRing()
    monkeypatch.setenv("RING_ACCESS_TOKEN", "playground-token")
    monkeypatch.setattr(ring_api.RingAPI, "from_env", classmethod(lambda cls, **kw: api_with(fake)))
    monkeypatch.setattr(ring_api, "_LAST", {"at": None, "result": None})
    client = TestClient(server.mcp.streamable_http_app(host="127.0.0.1"), base_url="http://127.0.0.1")
    assert client.post("/integrations/ring/sync").status_code == 401  # needs the integration secret
    out = client.post("/integrations/ring/sync", headers={"x-nova-ring-secret": server.RING_SECRET}).json()
    assert out["ok"] and len(out["imported"]) == 3 and out["calls"]
    st = client.get("/integrations/ring/status").json()
    assert st["linked"] and st["mode"] == "access_token" and st["last_sync"]

    import asyncio

    async def ask() -> dict:
        server.set_stdio_user("maya")
        async with Client(server.mcp) as c:
            r = await c.call_tool("recent_activity", {"hours": 24})
            return r.structured_content

    res = asyncio.run(ask())
    assert res["ring"]["source"] == "Ring Partner API" and res["ring"]["ok"]
    assert "rang the doorbell" in res["speech"]


def test_not_linked_says_how_to_link(monkeypatch):
    from starlette.testclient import TestClient

    for k in ("RING_ACCESS_TOKEN", "RING_REFRESH_TOKEN"):
        monkeypatch.delenv(k, raising=False)
    client = TestClient(server.mcp.streamable_http_app(host="127.0.0.1"), base_url="http://127.0.0.1")
    out = client.post("/integrations/ring/sync", headers={"x-nova-ring-secret": server.RING_SECRET}).json()
    assert out["linked"] is False and "RING_ACCESS_TOKEN" in out["error"]
    assert client.get("/integrations/ring/status").json()["linked"] is False
