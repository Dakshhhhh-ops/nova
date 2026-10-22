"""Ring Partner API Webhook v1.1: signature check, dedupe, event mapping, visitor inference."""

from __future__ import annotations

import os
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

os.environ.setdefault("NOVA_LLM", "rules")
os.environ.setdefault("NOVA_DB", str(Path(tempfile.mkdtemp()) / "nova-test.db"))

import pytest  # noqa: E402
from starlette.testclient import TestClient  # noqa: E402

from nova_server import ring, server  # noqa: E402
from nova_server import store as store_mod  # noqa: E402
from nova_server.seed import seed  # noqa: E402

TOMORROW_10 = datetime.now().replace(hour=10, minute=0, second=0, microsecond=0) + timedelta(days=1)


@pytest.fixture()
def client():
    store_mod.freeze(TOMORROW_10.replace(hour=8) - timedelta(days=1))  # seed today: Grace visits tomorrow 10:00
    seed(server.store)
    ring._SEEN.clear()
    app = server.mcp.streamable_http_app(host="127.0.0.1")
    return TestClient(app, base_url="http://127.0.0.1")


def post(client, payload, *, signature=None, extra=None):
    raw = ring.to_json_bytes(payload)
    headers = {"content-type": "application/json", "x-signature": signature or ring.sign(raw)}
    headers.update(extra or {})
    return client.post("/integrations/ring/webhook", content=raw, headers=headers)


def test_signature_matches_ring_format():
    raw = b'{"meta":{"version":"1.1"}}'
    sig = ring.sign(raw, b"secret")
    assert sig.startswith("sha256=") and len(sig) == len("sha256=") + 64
    assert ring.verify(raw, sig, b"secret")
    assert ring.verify(raw, sig.removeprefix("sha256="), b"secret")  # bare hex is accepted too
    assert not ring.verify(raw + b" ", sig, b"secret")
    assert not ring.verify(raw, None, b"secret")


def test_payload_shape_is_webhook_v1_1():
    ev = ring.make_event("motion", device_id="dev1", at=TOMORROW_10)
    assert ev["meta"]["version"] == "1.1" and ev["meta"]["request_id"]
    assert ev["data"]["type"] == "motion_detected"
    attrs = ev["data"]["attributes"]
    assert attrs["source"] == "dev1" and attrs["source_type"] == "devices"
    assert attrs["sub_type"] == "human" and isinstance(attrs["timestamp"], int)
    assert ev["data"]["relationships"]["devices"]["links"]["self"] == "/v1/devices/dev1"
    assert ring.make_event("ding")["data"]["type"] == "button_press"


def test_bad_signature_is_rejected_with_4xx(client):
    r = post(client, ring.make_event("ding"), signature="sha256=" + "0" * 64)
    assert r.status_code == 401  # 4xx: Ring will not retry a forged event


def test_button_press_near_grace_visit_is_grace(client):
    # Grace's visit is tomorrow at 10:00; a doorbell press at 9:55 is probably her.
    store_mod.freeze(TOMORROW_10.replace(hour=9, minute=55))
    ev = ring.make_event("ding", at=TOMORROW_10.replace(hour=9, minute=55))
    r = post(client, ev)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["ring_type"] == "button_press" and out["device"] == "ring-front-door-1"
    assert out["signal"]["who"] == "grace"
    assert out["checklist"], "Grace gets her visit checklist"


def test_button_press_with_no_visit_is_someone(client):
    ev = ring.make_event("ding", at=TOMORROW_10.replace(hour=15))
    out = post(client, ev).json()
    assert out["signal"]["who"] == "unknown"
    assert "Someone" in out["signal"]["text"]


def test_motion_and_duplicates(client):
    ev = ring.make_event("motion")
    first = post(client, ev).json()
    assert first["ring_type"] == "motion_detected" and first["signal"]["kind"] == "motion"
    again = post(client, ev)
    assert again.status_code == 200 and again.json() == {"ok": True, "duplicate": True}


def test_unknown_types_are_acknowledged_not_failed(client):
    ev = ring.make_event("ding")
    ev["data"]["type"] = "app_integration_enabled"
    r = post(client, ev)
    assert r.status_code == 200 and r.json()["ignored"] == "app_integration_enabled"


def test_device_offline_lands_on_the_timeline(client):
    ev = ring.make_event("ding")
    ev["data"]["type"] = "device_offline"
    assert post(client, ev).json()["signal"]["kind"] == "device_offline"
    sigs = server.store.q("SELECT * FROM signals WHERE kind = 'device_offline'")
    assert sigs and "offline" in sigs[-1]["text"]
