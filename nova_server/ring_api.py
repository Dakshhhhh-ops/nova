"""Ring Partner API client: Nova reads the front door from Ring itself.

Webhooks (`ring.py`) bring events in real time. This client covers the rest:

    GET /v1/users/me                          which Ring account is linked
    GET /v1/devices                           which devices Nova can see
    GET /v1/devices/{id}/status               is the doorbell online?
    GET /v1/history/devices/{id}/events       doorbell presses and people at the door,
                                              to backfill anything a webhook missed

Minimum necessary: Nova asks the history API only for `ding` and `motion.human`, never
for vehicles, animals, video or snapshots, and stores no Ring email or address.

Auth, as in Ring's own starter (github.com/AmazonAppDev/ring-api-helloworld):
  RING_ACCESS_TOKEN                     a ~30-minute token from the Ring Developer Playground, or
  RING_REFRESH_TOKEN + RING_CLIENT_ID   production: exchanged at oauth.ring.com for access tokens.
  + RING_CLIENT_SECRET
"""

from __future__ import annotations

import json
import logging
import os
import re
import socket
import threading
import time
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import httpx

from .ring import expected_visitor
from .store import Store, iso, now

log = logging.getLogger("nova.ring_api")

API_BASE = os.getenv("RING_API_BASE", "https://api.amazonvision.com")
OAUTH_URL = "https://oauth.ring.com/oauth/token"
USER_AGENT = "NovaCareCircle/0.1"
CARE_EVENTS = "ding,motion.human"  # the only event types a care circle needs
FRESH = timedelta(minutes=10)       # newer than this: announce it; older: timeline only
LOOKBACK = timedelta(days=7)        # don't import older history


class RingAPIError(Exception):
    """A JSON:API error from Ring (`{"errors": [{"status", "title", "detail"}]}`)."""

    def __init__(self, status: int, title: str, detail: str = "") -> None:
        super().__init__(f"Ring API {status}: {title}" + (f" ({detail})" if detail else ""))
        self.status, self.title, self.detail = status, title, detail


def auth_mode() -> str | None:
    if os.getenv("RING_ACCESS_TOKEN"):
        return "access_token"
    if os.getenv("RING_REFRESH_TOKEN") and os.getenv("RING_CLIENT_ID") and os.getenv("RING_CLIENT_SECRET"):
        return "refresh_token"
    return None


def _hardware_id() -> str:
    """Ring requires a stable Hardware_Id UUID per installation."""
    return os.getenv("RING_HARDWARE_ID") or str(uuid.uuid5(uuid.NAMESPACE_DNS, "nova-care-circle." + socket.gethostname()))


class RingAPI:
    def __init__(self, token: str | None = None, *, transport: httpx.BaseTransport | None = None,
                 base_url: str = API_BASE) -> None:
        self._token = token
        self._expires = 0.0
        self.calls: list[dict[str, Any]] = []  # what the inspector shows: method, path, status, ms
        self._http = httpx.Client(base_url=base_url, timeout=10, transport=transport, headers={
            "User-Agent": USER_AGENT, "Hardware_Id": _hardware_id(), "Accept": "application/json",
            "Content-Type": "application/json",
        })

    @classmethod
    def from_env(cls, **kw: Any) -> "RingAPI | None":
        mode = auth_mode()
        if mode is None:
            return None
        return cls(os.getenv("RING_ACCESS_TOKEN") if mode == "access_token" else None, **kw)

    # -- auth ------------------------------------------------------------------
    def token(self) -> str:
        if self._token and (self._expires == 0 or time.time() < self._expires):
            return self._token
        if auth_mode() != "refresh_token":
            raise RingAPIError(401, "Not linked", "Set RING_ACCESS_TOKEN (Ring Developer Playground) or a refresh token")
        r = httpx.post(OAUTH_URL, timeout=10, data={
            "grant_type": "refresh_token", "refresh_token": os.environ["RING_REFRESH_TOKEN"],
            "client_id": os.environ["RING_CLIENT_ID"], "client_secret": os.environ["RING_CLIENT_SECRET"],
        })
        if r.status_code >= 400:
            raise RingAPIError(r.status_code, "Token refresh failed", r.text[:200])
        data = r.json()
        self._token, self._expires = data["access_token"], time.time() + int(data.get("expires_in", 3600)) - 60
        return self._token

    # -- requests --------------------------------------------------------------
    def get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        headers = {"Authorization": f"Bearer {self.token()}"}
        for attempt in range(2):
            t0 = time.perf_counter()
            r = self._http.get(path, params=params, headers=headers)
            ms = int((time.perf_counter() - t0) * 1000)
            shown = path + (("?" + "&".join(f"{k}={v}" for k, v in params.items())) if params else "")
            self.calls.append({"method": "GET", "path": shown, "status": r.status_code, "ms": ms})
            if r.status_code == 429 and attempt == 0:  # Ring: back off, respecting Retry-After
                time.sleep(min(float(r.headers.get("Retry-After", "1") or 1), 3.0))
                continue
            break
        if r.status_code >= 400:
            try:
                err = (r.json().get("errors") or [{}])[0]
            except ValueError:
                err = {}
            raise RingAPIError(r.status_code, err.get("title") or r.reason_phrase, err.get("detail") or "")
        return r.json()

    def me(self) -> dict[str, Any]:
        return self.get("/v1/users/me").get("data") or {}

    def devices(self) -> list[dict[str, Any]]:
        return self.get("/v1/devices").get("data") or []

    def status(self, device_id: str) -> dict[str, Any]:
        return (self.get(f"/v1/devices/{device_id}/status").get("data") or {}).get("attributes") or {}

    def capabilities(self, device_id: str) -> dict[str, Any]:
        return (self.get(f"/v1/devices/{device_id}/capabilities").get("data") or {}).get("attributes") or {}

    def events(self, device_id: str, event_types: str = CARE_EVENTS, max_pages: int = 3) -> list[dict[str, Any]]:
        """Event history, newest first, following `links.next` (page[key] cursor) for a few pages."""
        out: list[dict[str, Any]] = []
        params: dict[str, Any] = {"event_types": event_types}
        for _ in range(max_pages):
            page = self.get(f"/v1/history/devices/{device_id}/events", params)
            out += page.get("data") or []
            nxt = (page.get("links") or {}).get("next")
            if not nxt:
                break
            key = parse_qs(urlparse(nxt).query).get("page[key]")
            if not key:
                break
            params = {"event_types": event_types, "page[key]": key[0]}
        return out

    def close(self) -> None:
        self._http.close()


# ---------------------------------------------------------------------------
# Sync: Ring → Nova's front-door signals
# ---------------------------------------------------------------------------
_LAST: dict[str, Any] = {"at": None, "result": None}
_LOCK = threading.Lock()


def _event_time(attrs: dict[str, Any]) -> datetime | None:
    v = attrs.get("start")
    if isinstance(v, (int, float)):
        return datetime.fromtimestamp(v / 1000)
    if isinstance(v, str):
        try:
            return datetime.fromtimestamp(int(v) / 1000) if v.isdigit() else \
                datetime.fromisoformat(v.replace("Z", "+00:00")).astimezone().replace(tzinfo=None)
        except ValueError:
            return None
    return None


def _kind(event_type: str) -> str | None:
    if event_type == "ding":
        return "ding"
    if event_type.startswith("motion.human"):
        return "motion"
    return None  # vehicles, animals, live view: not care signals


_CAPS: dict[str, list[str]] = {}  # capabilities rarely change: ask once per device per process


def model_name(image_url: str | None) -> str | None:
    """Ring's device image path names the model: .../square_device_images/DoorbellPro/rvdp_3x.png -> Doorbell Pro."""
    m = re.search(r"/square_device_images/([^/]+)/", image_url or "")
    return re.sub(r"(?<=[a-z])(?=[A-Z])", " ", m.group(1)) if m else None


def capability_summary(attrs: dict[str, Any]) -> list[str]:
    out = []
    video = attrs.get("video") or {}
    if video.get("max_resolution"):
        out.append(f"{video['max_resolution']}p video")
    motion = (attrs.get("motion_detection") or {}).get("configurations") or []
    if motion:
        out.append("motion zones" if "motion_zones" in motion else "motion detection")
    enh = (attrs.get("image_enhancements") or {}).get("configurations") or []
    if "color_night_vision" in enh:
        out.append("color night vision")
    if attrs.get("contact_detection"):
        out.append("door contact")
    return out


def snapshot_path(store: Store) -> Path:
    return Path(os.getenv("NOVA_RING_SNAPSHOT") or Path(store.path).parent / "ring-last-sync.json")


SEED_SNAPSHOT = Path(__file__).resolve().parent.parent / "samples" / "ring-recorded-sync.json"


def recorded(store: Store) -> dict[str, Any] | None:
    """The last successful live sync (no token, no email), for when the short-lived token has expired.
    A fresh deploy has none yet, so it falls back to a real sync recorded from the Ring Developer Playground."""
    for path in (snapshot_path(store), SEED_SNAPSHOT):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
    return None


def sync(store: Store, engine: Any, api: RingAPI, *, real_now: datetime | None = None) -> dict[str, Any]:
    """Pull the account, devices, status and recent care events from Ring; import new events as signals."""
    with _LOCK:
        api.calls.clear()
        elders = store.elders()
        if not elders:
            return {"ok": False, "error": "no household"}
        elder = elders[0]
        wall = real_now or datetime.now()
        result: dict[str, Any] = {"ok": True, "linked": True, "source": "live", "mode": auth_mode() or "token",
                                  "devices": [], "imported": [], "skipped": 0}
        try:
            me = api.me()
            attrs = me.get("attributes") or {}
            result["account"] = {"id": me.get("id"), "first_name": attrs.get("first_name")}  # no email stored
            for d in api.devices():
                did = d.get("id")
                if not did:
                    continue
                dattrs = d.get("attributes") or {}
                dev = {"id": did, "name": dattrs.get("name") or dattrs.get("description") or "Ring device",
                       "model": model_name(dattrs.get("image_url")), "image_url": dattrs.get("image_url")}
                try:
                    st = api.status(did)
                    dev["online"] = bool(st.get("online"))
                    dev["reported_at"] = st.get("reported_at")
                except RingAPIError as exc:
                    dev["online"] = False if exc.status == 503 else None  # 503 = device offline
                if did not in _CAPS:
                    try:
                        _CAPS[did] = capability_summary(api.capabilities(did))
                    except RingAPIError:
                        _CAPS[did] = []
                dev["capabilities"] = _CAPS[did]
                if dev["online"] is False:
                    key = f"offline:{did}:{wall.date()}"
                    if not store.ring_event_seen(key):
                        sid = store.add_signal(elder["id"], "ring", "device_offline", None,
                                               f"{dev['name']} is offline", at=now())
                        store.mark_ring_event(key, did, "device_offline", now(), sid)
                try:
                    events = api.events(did)
                except RingAPIError as exc:
                    dev["events_error"] = str(exc)
                    events = []
                dev["events"] = len(events)
                for ev in events:
                    eid = ev.get("id")
                    eattrs = ev.get("attributes") or {}
                    etype = eattrs.get("event_type") or ""
                    at = _event_time(eattrs)
                    if not eid or at is None or store.ring_event_seen(eid):
                        result["skipped"] += 1
                        continue
                    kind = _kind(etype)
                    if kind is None or wall - at > LOOKBACK:
                        store.mark_ring_event(eid, did, etype, at, None)
                        result["skipped"] += 1
                        continue
                    fresh = timedelta(0) <= wall - at <= FRESH
                    who = (expected_visitor(store, elder["id"], at) or "unknown") if kind == "ding" else "unknown"
                    out = engine.on_ring_event(kind, who, at=at, announce=fresh)
                    sid = (out.get("signal") or {}).get("id")
                    store.mark_ring_event(eid, did, etype, at, sid)
                    result["imported"].append({"id": eid, "device": dev["name"], "event_type": etype, "at": iso(at),
                                               "who": who, "announced": fresh, "text": (out.get("signal") or {}).get("text")})
                result["devices"].append(dev)
        except RingAPIError as exc:
            result.update(ok=False, error=str(exc), status=exc.status,
                          hint="The Playground token lasts about 30 minutes; generate a fresh one." if exc.status == 401 else None)
        except httpx.HTTPError as exc:
            result.update(ok=False, error=f"Couldn't reach Ring: {exc.__class__.__name__}")
        result["calls"] = list(api.calls)
        result["events_note"] = None if result.get("imported") or not result["ok"] else \
            "No new doorbell or motion events from Ring."
        _LAST.update(at=iso(wall), result=result)
        if result["ok"]:
            snap = {"at": iso(wall), "account": result.get("account"), "calls": result["calls"],
                    "devices": [{k: v for k, v in d.items() if k != "events_error"} for d in result["devices"]]}
            try:
                snapshot_path(store).write_text(json.dumps(snap, indent=1), encoding="utf-8")
            except OSError:
                pass
        else:
            rec = recorded(store)
            if rec:
                result["recorded"] = rec  # shown as "recorded <time>", never as live
        return result


def start_poller(store: Store, engine: Any, interval: float | None = None) -> threading.Thread | None:
    """Backfill from Ring every few minutes when an account is linked (webhooks stay the real-time path)."""
    if auth_mode() is None:
        return None
    every = interval or float(os.getenv("RING_POLL_SECONDS", "300"))

    def loop() -> None:
        while True:
            api = RingAPI.from_env()
            if api is not None:
                try:
                    res = sync(store, engine, api)
                    log.info("Ring sync: %s new, ok=%s", len(res.get("imported") or []), res.get("ok"))
                except Exception:  # never let the poller die
                    log.exception("Ring sync failed")
                finally:
                    api.close()
            time.sleep(every)

    th = threading.Thread(target=loop, name="ring-poller", daemon=True)
    th.start()
    return th


def last_sync() -> dict[str, Any]:
    return dict(_LAST)


def summary_line(result: dict[str, Any]) -> str:
    """One spoken line about what Ring reported."""
    if not result.get("ok"):
        return "I couldn't reach Ring just now."
    devs = result.get("devices") or []
    offline = [d["name"] for d in devs if d.get("online") is False]
    n = len(result.get("imported") or [])
    parts = []
    if offline:
        parts.append(f"{offline[0]} is offline.")
    if n:
        parts.append(f"Ring reported {n} new front-door {'event' if n == 1 else 'events'}.")
    return " ".join(parts)
