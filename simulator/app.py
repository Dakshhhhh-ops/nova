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

from .agent import Agent, Device, new_id, result_json, structured_of

log = logging.getLogger("nova.simulator")

STATIC = Path(__file__).resolve().parent / "static"
MCP_URL = os.getenv("NOVA_MCP_URL", "http://127.0.0.1:8765/mcp")

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
    await connect_all()
    yield
    for d in DEVICES.values():
        try:
            await d.close()
        except Exception:
            pass


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
async def index() -> FileResponse:
    return FileResponse(STATIC / "index.html")


@app.get("/api/status")
async def status() -> dict[str, Any]:
    if not state["connected"]:
        await connect_all()
    agent: Agent = state["agent"]
    return {
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
        out = await agent.run_turn(device, body.text.strip(), hub.emit)
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
    result = await device.client.call_tool(body.name, body.arguments)
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
    res = await d.client.read_resource("nova://timeline")
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
