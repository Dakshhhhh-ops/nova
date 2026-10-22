"""Alexa+ simulator: two Echo devices talking to the Nova MCP server.

Run:  python -m simulator   (http://127.0.0.1:8080, expects the MCP server on :8765)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from mcp_types import ElicitRequestParams, ElicitResult
from pydantic import BaseModel

from nova_server.store import now as household_now

from .agent import HOUSEHOLD, Agent, Device, new_id, result_json, structured_of

log = logging.getLogger("nova.simulator")

STATIC = Path(__file__).resolve().parent / "static"
MCP_URL = os.getenv("NOVA_MCP_URL", "http://127.0.0.1:8765/mcp")
MCP_BASE = MCP_URL.rsplit("/mcp", 1)[0]
RING_SECRET = os.getenv("NOVA_RING_SECRET", "nova-demo-ring")
SAMPLES = Path(__file__).resolve().parent.parent / "samples"

DEVICES = {
    "kitchen": Device(
        "kitchen", "Rose's kitchen · Columbus, OH",
        {"id": "rose", "name": "Rose Alvarez", "short_name": "Rose", "role": "elder",
         "relation": "mom/grandma", "location": "Columbus, Ohio", "device": "Echo Show 8 · Kitchen"},
        "nova-demo-rose",
        [
            "What's my day look like?",
            "I just took my pink pill",
            "I'm feeling a bit dizzy this morning and my knee hurts",
            "Any messages for me?",
            "Can I take ibuprofen for my knee?",
            "Tell Maya I loved Lily's recital video",
            "My blood pressure is 118 over 72",
            "Order a refill of my metformin",
            "Remind me in 10 minutes",
        ],
    ),
    "maya": Device(
        "maya", "Maya's office · Seattle, WA",
        {"id": "maya", "name": "Maya Alvarez-Chen", "short_name": "Maya", "role": "caregiver",
         "relation": "daughter", "location": "Seattle, Washington", "device": "Echo Show 15 · Home office"},
        "nova-demo-maya",
        [
            "How's Mom doing?",
            "Prepare a brief for Mom's cardiology visit",
            "Did Mom take her evening pills?",
            "Tell Mom I'll call her Sunday",
            "Any open alerts?",
            "When did Mom last open the front door?",
            "What are my notifications?",
        ],
    ),
}


class Hub:
    """Fan-out of server-sent events to every open browser tab."""

    def __init__(self) -> None:
        self.queues: set[asyncio.Queue] = set()

    async def emit(self, event: dict[str, Any]) -> None:
        for q in list(self.queues):
            q.put_nowait(event)


hub = Hub()
pending_elicits: dict[str, asyncio.Future] = {}
state: dict[str, Any] = {"agent": None, "connected": False, "error": None, "server": {}}


async def handle_elicit(device: Device, params: ElicitRequestParams) -> ElicitResult:
    eid = new_id()
    fut: asyncio.Future = asyncio.get_running_loop().create_future()
    pending_elicits[eid] = fut
    message = getattr(params, "message", "")
    schema = getattr(params, "requested_schema", None)
    schema_json = schema.model_dump(mode="json", by_alias=True, exclude_none=True) if hasattr(schema, "model_dump") else schema
    await hub.emit({"type": "trace", "device": device.id, "item": {"kind": "elicit", "message": message}})
    await hub.emit({"type": "elicit", "device": device.id, "id": eid, "message": message, "schema": schema_json})
    try:
        answer = await asyncio.wait_for(fut, timeout=90)
    except asyncio.TimeoutError:
        answer = {"action": "cancel", "content": None}
    finally:
        pending_elicits.pop(eid, None)
        await hub.emit({"type": "elicit_done", "id": eid})
    await hub.emit({"type": "trace", "device": device.id,
                    "item": {"kind": "elicit_answer", "action": answer["action"], "content": answer.get("content")}})
    return ElicitResult(action=answer["action"], content=answer.get("content"))


def is_connection_error(exc: BaseException) -> bool:
    """The MCP server went away (restart, network): reconnecting fixes it."""
    text = f"{type(exc).__name__}: {exc}".lower()
    return any(k in text for k in ("connection closed", "connecterror", "connection refused", "remoteprotocolerror",
                                   "readerror", "session terminated", "404 not found"))


_reconnect_locks: dict[str, asyncio.Lock] = {}


async def reconnect(device: Device, stale: Any = None) -> None:
    """Replace a dead MCP session. Concurrent callers (the poller and a chat turn) share one reconnect."""
    lock = _reconnect_locks.setdefault(device.id, asyncio.Lock())
    async with lock:
        if device.client is not None and device.client is not stale:
            return  # another caller already reconnected
        log.warning("MCP connection to the Nova server was lost; reconnecting %s", device.id)
        device.client = None  # the old session is dead; drop it rather than closing it from another task
        await device.connect(MCP_URL)


async def with_mcp(device: Device, op):
    """Run an MCP operation for a device; on a lost connection, reconnect once and retry."""
    stale = device.client
    try:
        if device.client is None:
            raise ConnectionError("connection closed: no session")
        return await op()
    except Exception as exc:
        if not (is_connection_error(exc) or isinstance(exc, AssertionError)):
            raise
        await reconnect(device, stale)
        return await op()


async def connect_all() -> None:
    try:
        for d in DEVICES.values():
            d.elicit_handler = handle_elicit
            await d.connect(MCP_URL)
        any_dev = next(iter(DEVICES.values()))
        info = any_dev.client.server_info if any_dev.client else None
        state["server"] = {
            "name": getattr(info, "name", "nova"), "title": getattr(info, "title", None),
            "version": getattr(info, "version", None),
            "protocol_version": any_dev.client.protocol_version if any_dev.client else None,
            "tools": [t.name for t in any_dev.tools],
        }
        state["connected"] = True
        state["error"] = None
    except Exception as exc:
        log.exception("could not connect to the Nova MCP server")
        state["connected"] = False
        state["error"] = f"{type(exc).__name__}: {exc}"[:300]


@asynccontextmanager
async def lifespan(_: FastAPI):
    state["agent"] = await asyncio.to_thread(Agent, DEVICES)
    log.info("Brain: %s", state["agent"].brain_info()["label"])
    if not os.getenv("NOVA_LAZY_CONNECT"):
        await connect_all()  # in single-process mode the MCP server isn't accepting yet: the poller connects
    poller = asyncio.create_task(poll_announcements())
    yield
    poller.cancel()
    try:
        await poller
    except BaseException:  # the poller ends with CancelledError; nothing to report on shutdown
        pass
    for d in DEVICES.values():
        # MCP sessions were opened by another task; closing them here trips anyio's task checks.
        # The process (or test client) is going away, so just drop them.
        d.client = None


async def fetch_clock() -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=5) as http:
        r = await http.get(f"{MCP_BASE}/demo/clock")
        r.raise_for_status()
        data = r.json()
    from datetime import datetime

    HOUSEHOLD["now"] = datetime.fromisoformat(data["now"])
    HOUSEHOLD["speed"] = data.get("speed", 1.0)
    return data


async def poll_announcements() -> None:
    """Deliver Nova's proactive announcements to each device (reading nova://announcements over MCP)."""
    tick = 0
    while True:
        try:
            if not state["connected"] and tick % 3 == 0:
                await connect_all()
            if state["connected"]:
                for d in DEVICES.values():
                    if d.client is None:
                        continue
                    res = await with_mcp(d, lambda d=d: d.client.read_resource("nova://announcements"))
                    text = next((getattr(c, "text", None) for c in res.contents if getattr(c, "text", None)), "{}")
                    items = json.loads(text).get("items", [])
                    for item in items:
                        await hub.emit({"type": "announcement", "device": d.id, "item": item})
                        # Keep the conversation aware of what Nova just said, so "I took it" makes sense.
                        d.history.append({"role": "assistant", "text": f"(Nova announcement) {item['speech']}"})
                    if items:
                        await hub.emit({"type": "circle", "item": {"device": d.id}})
            if tick % 2 == 0:
                clock = await fetch_clock()
                await hub.emit({"type": "clock", "now": clock["now"], "speed": clock["speed"]})
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # server restarting etc.
            log.debug("announcement poll failed: %s", exc)
        tick += 1
        await asyncio.sleep(1.0)


app = FastAPI(title="Nova · Alexa+ simulator", lifespan=lifespan)


async def ensure_connected() -> None:
    if not state["connected"]:
        await connect_all()
    if not state["connected"]:
        raise HTTPException(503, f"Nova MCP server not reachable at {MCP_URL}: {state['error']}")


def device_or_404(device_id: str) -> Device:
    d = DEVICES.get(device_id)
    if not d:
        raise HTTPException(404, f"unknown device {device_id}")
    return d


@app.get("/")
async def landing() -> FileResponse:
    """The story page; falls back to the live demo if it isn't there."""
    site = STATIC / "site" / "index.html"
    return FileResponse(site if site.exists() else STATIC / "index.html")


@app.get("/live")
async def live() -> FileResponse:
    """The live demo (the 'Studio'): two Echo Shows, a Ring doorbell and the inspector."""
    return FileResponse(STATIC / "index.html")


@app.get("/api/status")
async def status() -> dict[str, Any]:
    if not state["connected"]:
        await connect_all()
    agent: Agent = state["agent"]
    return {
        "household_now": (HOUSEHOLD["now"] or household_now()).isoformat(),
        "clock_speed": HOUSEHOLD["speed"],
        "brain": agent.brain_info(),
        "mcp": {"url": MCP_URL, "connected": state["connected"], "error": state["error"],
                "server_name": state["server"].get("title") or state["server"].get("name"), **state["server"]},
        "devices": [d.public() for d in DEVICES.values()],
    }


class ChatIn(BaseModel):
    device: str
    text: str


@app.post("/api/chat")
async def chat(body: ChatIn) -> dict[str, Any]:
    await ensure_connected()
    device = device_or_404(body.device)
    agent: Agent = state["agent"]
    try:
        out = await with_mcp(device, lambda: agent.run_turn(device, body.text.strip(), hub.emit))
    except Exception as exc:
        log.exception("turn failed")
        await hub.emit({"type": "trace", "device": device.id, "item": {"kind": "error", "message": str(exc)[:300]}})
        state["connected"] = False
        raise HTTPException(500, str(exc)[:300])
    await hub.emit({"type": "circle", "item": {"device": device.id}})
    return out


class ElicitIn(BaseModel):
    action: str
    content: dict[str, Any] | None = None


@app.post("/api/elicit/{eid}")
async def answer_elicit(eid: str, body: ElicitIn) -> dict[str, Any]:
    fut = pending_elicits.get(eid)
    if not fut or fut.done():
        raise HTTPException(404, "no pending question")
    fut.set_result({"action": body.action, "content": body.content})
    return {"ok": True}


class AppCallIn(BaseModel):
    device: str
    name: str
    arguments: dict[str, Any] = {}


@app.post("/api/app-call")
async def app_call(body: AppCallIn) -> JSONResponse:
    """Tool calls coming from an MCP App view, proxied by the host."""
    await ensure_connected()
    device = device_or_404(body.device)
    await hub.emit({"type": "trace", "device": device.id, "item": {"kind": "tool_call", "name": body.name,
                                                                    "args": body.arguments, "from": "app"}})
    result = await with_mcp(device, lambda: device.client.call_tool(body.name, body.arguments))
    data = structured_of(result)
    await hub.emit({"type": "trace", "device": device.id, "item": {
        "kind": "tool_result", "name": body.name, "ok": not result.is_error, "speech": data.get("speech"),
        "structured": data, "ui": None, "ms": 0, "from": "app"}})
    await hub.emit({"type": "circle", "item": {"device": device.id}})
    return JSONResponse(result_json(result))


@app.get("/api/timeline")
async def timeline() -> dict[str, Any]:
    await ensure_connected()
    d = DEVICES["maya"]
    res = await with_mcp(d, lambda: d.client.read_resource("nova://timeline"))
    text = next((getattr(c, "text", None) for c in res.contents if getattr(c, "text", None)), "{}")
    return json.loads(text)


@app.post("/api/reset")
async def reset() -> dict[str, Any]:
    base = MCP_URL.rsplit("/mcp", 1)[0]
    async with httpx.AsyncClient(timeout=10) as http:
        r = await http.post(f"{base}/demo/reset")
        r.raise_for_status()
    for d in DEVICES.values():
        d.history.clear()
    await hub.emit({"type": "reset"})
    return {"ok": True}


@app.get("/api/events")
async def events() -> StreamingResponse:
    q: asyncio.Queue = asyncio.Queue()
    hub.queues.add(q)

    async def stream():
        try:
            yield "retry: 2000\n\n"
            while True:
                try:
                    ev = await asyncio.wait_for(q.get(), timeout=15)
                    yield f"data: {json.dumps(ev, default=str)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
        finally:
            hub.queues.discard(q)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ---------------------------------------------------------------------------
# v2: household clock, announcements, vision, Ring
# ---------------------------------------------------------------------------
class ClockIn(BaseModel):
    time: str | None = None
    speed: float | None = None


@app.get("/api/clock")
async def get_clock() -> dict[str, Any]:
    return await fetch_clock()


@app.post("/api/clock")
async def set_clock(body: ClockIn) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=10) as http:
        r = await http.post(f"{MCP_BASE}/demo/clock", json=body.model_dump(exclude_none=True))
        r.raise_for_status()
    clock = await fetch_clock()
    if body.time:
        for d in DEVICES.values():
            d.history.clear()
    await hub.emit({"type": "clock", "now": clock["now"], "speed": clock["speed"]})
    await hub.emit({"type": "circle", "item": {}})
    return clock


@app.get("/api/announcements")
async def list_announcements(device: str) -> dict[str, Any]:
    await ensure_connected()
    d = device_or_404(device)
    result = await with_mcp(d, lambda: d.client.call_tool("read_notifications", {}))
    return {"items": structured_of(result).get("items", [])}


class AckIn(BaseModel):
    device: str
    action: str = "acknowledged"


@app.post("/api/announcements/{ann_id}/ack")
async def ack_announcement(ann_id: int, body: AckIn) -> dict[str, Any]:
    await ensure_connected()
    d = device_or_404(body.device)
    action = body.action if body.action in ("acknowledged", "dismissed") else "acknowledged"
    await with_mcp(d, lambda: d.client.call_tool("acknowledge_notification", {"notification_id": ann_id, "action": action}))
    return {"ok": True}


@app.get("/api/samples")
async def samples() -> dict[str, Any]:
    path = SAMPLES / "fixtures.json"
    fixtures = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    items = [{"id": v["file"].rsplit(".", 1)[0], "kind": v["kind"], "label": v["label"], "url": f"/samples/{v['file']}"}
             for v in fixtures.values()]
    return {"samples": sorted(items, key=lambda x: (x["kind"], x["label"]))}


class VisionIn(BaseModel):
    device: str
    kind: str
    image: str


@app.post("/api/vision")
async def vision(body: VisionIn) -> dict[str, Any]:
    await ensure_connected()
    device = device_or_404(body.device)
    tool = "check_pill_photo" if body.kind == "pill" else "read_care_document"
    said = ("(Rose holds a pill bottle up to the camera) Is this the right pill?" if body.kind == "pill"
            else "(Maya photographs the after-visit summary) Read this and update the plan.")
    agent: Agent = state["agent"]
    try:
        out = await with_mcp(device, lambda: agent.run_direct(device, tool, {"image_base64": body.image}, said, hub.emit))
    except Exception as exc:
        log.exception("vision failed")
        await hub.emit({"type": "trace", "device": device.id, "item": {"kind": "error", "message": str(exc)[:300]}})
        raise HTTPException(500, str(exc)[:300])
    await hub.emit({"type": "circle", "item": {"device": device.id}})
    return out


class RingIn(BaseModel):
    kind: str
    who: str | None = None


@app.post("/api/ring/event")
async def ring_event(body: RingIn) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=10) as http:
        r = await http.post(f"{MCP_BASE}/integrations/ring/events", json=body.model_dump(exclude_none=True),
                            headers={"x-nova-ring-secret": RING_SECRET})
    if r.status_code >= 400:
        raise HTTPException(r.status_code, r.text[:200])
    data = r.json()
    await hub.emit({"type": "trace", "device": "kitchen", "item": {
        "kind": "ring", "at": data.get("signal", {}).get("at"), "text": data.get("signal", {}).get("text"),
        "announced": data.get("announced", [])}})
    await hub.emit({"type": "circle", "item": {"ring": True}})
    return data


# ---------------------------------------------------------------------------
# Speech: Amazon Polly when AWS is configured, otherwise the browser speaks.
# ---------------------------------------------------------------------------
_polly: dict[str, Any] = {"client": None, "ok": None}
VOICES = {"kitchen": ("Ruth", "generative"), "maya": ("Ruth", "generative")}


def _synthesize(text: str, device: str) -> bytes | None:
    if _polly["ok"] is False:
        return None
    try:
        if _polly["client"] is None:
            import boto3

            _polly["client"] = boto3.client("polly")
        voice, engine = VOICES.get(device, ("Ruth", "generative"))
        for eng in (engine, "neural"):
            try:
                out = _polly["client"].synthesize_speech(Text=text[:2900], OutputFormat="mp3", VoiceId=voice, Engine=eng)
                _polly["ok"] = True
                return out["AudioStream"].read()
            except Exception as exc:
                if "security token" in str(exc) or "credentials" in str(exc).lower():
                    raise
        return None
    except Exception as exc:
        log.info("Polly unavailable, browser will speak: %s", str(exc)[:120])
        _polly["ok"] = False
        return None


class TtsIn(BaseModel):
    text: str
    device: str = "kitchen"


@app.post("/api/tts")
async def tts(body: TtsIn) -> Response:
    audio = await asyncio.to_thread(_synthesize, body.text, body.device)
    if not audio:
        return Response(status_code=204)
    return Response(content=audio, media_type="audio/mpeg")


app.mount("/static", StaticFiles(directory=STATIC), name="static")
if SAMPLES.exists():
    app.mount("/samples", StaticFiles(directory=SAMPLES), name="samples")
