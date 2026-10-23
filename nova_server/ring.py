"""Ring Partner API webhooks (v1.1) → Nova care signals.

Ring posts device events to the webhook URL registered in the Ring Developer
Portal. Nova verifies the `X-Signature` HMAC-SHA256 over the raw body, drops
duplicates by `meta.request_id`, and turns the events into front-door signals:

    motion_detected  → motion          (attributes.sub_type, e.g. "human")
    button_press     → ding            (the doorbell button)
    device_online / device_offline → a note on the timeline

Ring payloads don't say who is at the door, so Nova infers an expected visitor
from the care calendar (a doorbell press near Grace's scheduled visit is
probably Grace). Ring treats 4xx as permanent and retries 5xx, so a bad
signature gets 401 and everything else returns 200 quickly.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
import uuid
from collections import OrderedDict
from datetime import datetime, timedelta
from typing import Any

from .store import Store, now

SIGNING_KEY = os.getenv("NOVA_RING_SIGNING_KEY", "nova-demo-ring-signing-key").encode()
_SEEN: "OrderedDict[str, float]" = OrderedDict()


def sign(raw_body: bytes, key: bytes = SIGNING_KEY) -> str:
    """The `X-Signature` header value Ring sends: sha256=<hex HMAC of the raw body>."""
    return "sha256=" + hmac.new(key, raw_body, hashlib.sha256).hexdigest()


def verify(raw_body: bytes, header: str | None, key: bytes = SIGNING_KEY) -> bool:
    if not header:
        return False
    received = header[len("sha256="):] if header.startswith("sha256=") else header
    expected = hmac.new(key, raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, received)


def seen_before(request_id: str | None) -> bool:
    """Ring may deliver an event more than once; remember recent request ids."""
    if not request_id:
        return False
    if request_id in _SEEN:
        return True
    _SEEN[request_id] = time.time()
    while len(_SEEN) > 2000:
        _SEEN.popitem(last=False)
    return False


def expected_visitor(store: Store, elder_id: str, at: datetime, window_min: int = 45) -> str | None:
    """A circle member whose visit is scheduled close to this moment (Ring doesn't identify people)."""
    for a in store.appointments(elder_id, at - timedelta(minutes=window_min), at + timedelta(minutes=window_min)):
        first = (a.get("provider") or "").split()[0] if a.get("provider") else ""
        if first and first in a["title"]:  # a personal visit, like "Grace's home visit"
            person = store.find_person(first)
            if person:
                return person["id"]
    return None


def make_event(kind: str, device_id: str = "ring-front-door-1", account_id: str = "nova-demo-account",
               sub_type: str = "human", at: datetime | None = None) -> dict[str, Any]:
    """A Webhook v1.1 payload shaped exactly like Ring's (used by the simulator and tests)."""
    t = at or now()
    ts = int(t.timestamp() * 1000)
    rtype = {"ding": "button_press", "motion": "motion_detected"}.get(kind, kind)
    attributes: dict[str, Any] = {"source": device_id, "source_type": "devices", "timestamp": ts}
    if rtype == "motion_detected":
        attributes |= {"timestamp_readable": t.strftime("%Y-%m-%d %H:%M:%S"), "sub_type": sub_type}
    return {
        "meta": {"version": "1.1", "time": t.isoformat(), "request_id": f"req_{uuid.uuid4().hex[:20]}", "account_id": account_id},
        "data": {
            "id": f"{device_id}_{rtype}_{ts}",
            "type": rtype,
            "attributes": attributes,
            "relationships": {"devices": {"links": {"self": f"/v1/devices/{device_id}"}}},
        },
    }


def handle(store: Store, engine: Any, payload: dict[str, Any], hint_who: str | None = None) -> dict[str, Any]:
    """Map one verified Ring event to Nova. Returns what happened (for the response and the inspector)."""
    meta = payload.get("meta") or {}
    data = payload.get("data") or {}
    rtype = data.get("type")
    if seen_before(meta.get("request_id")):
        return {"ok": True, "duplicate": True}
    elders = store.elders()
    if not elders:
        return {"ok": True, "ignored": "no household"}
    elder = elders[0]
    attrs = data.get("attributes") or {}
    ts = attrs.get("timestamp")
    at = datetime.fromtimestamp(ts / 1000) if isinstance(ts, (int, float)) else now()
    if rtype == "button_press":
        who = hint_who or expected_visitor(store, elder["id"], at) or "unknown"
        out = engine.on_ring_event("ding", who, at=at, identity_confirmed=False)
    elif rtype == "motion_detected":
        out = engine.on_ring_event("motion", "unknown", at=at, identity_confirmed=False)
    elif rtype in ("device_online", "device_offline"):
        state = "back online" if rtype == "device_online" else "offline"
        store.add_signal(elder["id"], "ring", rtype, None, f"Front door camera is {state}")
        out = {"ok": True, "signal": {"kind": rtype}}
    else:
        return {"ok": True, "ignored": rtype}
    return {**out, "ring_type": rtype, "device": attrs.get("source"), "request_id": meta.get("request_id")}


def to_json_bytes(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, separators=(",", ":")).encode()

