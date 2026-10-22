"""The simulated Alexa+ agent.

Each Echo device in the simulator holds its own MCP session to the Nova
server (Streamable HTTP) with the bearer token of the person who owns the
device, exactly like Alexa+ would after account linking. A turn runs the
classic tool-use loop: Amazon Nova (Bedrock Converse) decides which Nova
tools to call, the simulator calls them over MCP, and Nova speaks the result.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import uuid
from contextlib import AsyncExitStack
from datetime import datetime
from typing import Any, Awaitable, Callable

import httpx2
from mcp import Client
from mcp.client.extension import advertise
from mcp.client.streamable_http import streamable_http_client
from mcp_types import ElicitRequestParams, ElicitResult, Implementation

from nova_server.llm import Backend, get_backend

from .rules import RulesBrain

log = logging.getLogger("nova.simulator")

APPS_EXTENSION = "io.modelcontextprotocol/ui"
APP_MIME = "text/html;profile=mcp-app"
MAX_STEPS = 6
HISTORY_TURNS = 8

Emit = Callable[[dict[str, Any]], Awaitable[None]]


def now_iso() -> str:
    return datetime.now().replace(microsecond=0).isoformat()


def result_json(result: Any) -> dict[str, Any]:
    return result.model_dump(mode="json", by_alias=True, exclude_none=True)


def structured_of(result: Any) -> dict[str, Any]:
    sc = getattr(result, "structured_content", None)
    if isinstance(sc, dict):
        return sc
    for block in getattr(result, "content", []) or []:
        text = getattr(block, "text", None)
        if text:
            try:
                val = json.loads(text)
                if isinstance(val, dict):
                    return val
            except json.JSONDecodeError:
                return {"speech": text}
    return {}


MAX_SPOKEN_CHARS = 420


def for_model(data: dict[str, Any], has_ui: bool) -> dict[str, Any]:
    """What the model sees of a tool result.

    UI-bound results (briefings, visit briefs) can be large; the screen shows the
    detail, so the model only needs the spoken line and the headline. Other results
    are passed through with long lists trimmed.
    """
    if has_ui:
        keep = {k: data[k] for k in ("speech", "headline", "status", "summary") if k in data}
        if isinstance(data.get("insights"), list):
            keep["top_insights"] = [i.get("title") for i in data["insights"][:3]]
        if isinstance(data.get("questions"), list):
            keep["questions"] = data["questions"][:5]
        keep["on_screen"] = "Full details are showing on the screen."
        return keep
    out: dict[str, Any] = {}
    for k, v in data.items():
        out[k] = v[:6] if isinstance(v, list) else v
    return out


def voice_guard(text: str, fallback: str) -> str:
    """Keep replies speakable: no markdown, no essays. Fall back to the tool's speech line."""
    clean = re.sub(r"[*#`>|]+", "", text or "")
    clean = re.sub(r"^\s*[-•]\s+", "", clean, flags=re.M)
    clean = re.sub(r"[🌀-🫿☀-➿]", "", clean)
    clean = re.sub(r"\s+", " ", clean).strip()
    if not clean:
        return fallback
    if len(clean) > MAX_SPOKEN_CHARS and fallback:
        return fallback
    return clean


class Device:
    def __init__(self, device_id: str, label: str, person: dict[str, Any], token: str, suggestions: list[str]) -> None:
        self.id = device_id
        self.label = label
        self.person = person
        self.token = token
        self.suggestions = suggestions
        self.client: Client | None = None
        self.tools: list[Any] = []
        self.history: list[dict[str, Any]] = []
        self.lock = asyncio.Lock()
        self._stack: AsyncExitStack | None = None
        self.elicit_handler: Callable[["Device", ElicitRequestParams], Awaitable[ElicitResult]] | None = None

    def public(self) -> dict[str, Any]:
        return {"id": self.id, "label": self.label, "person": self.person, "suggestions": self.suggestions}

    async def connect(self, url: str) -> None:
        self._stack = AsyncExitStack()
        http = httpx2.AsyncClient(headers={"Authorization": f"Bearer {self.token}"},
                                  timeout=httpx2.Timeout(90.0, connect=5.0))
        await self._stack.enter_async_context(http)

        async def on_elicit(_ctx: Any, params: ElicitRequestParams) -> ElicitResult:
            if self.elicit_handler is None:
                return ElicitResult(action="decline")
            return await self.elicit_handler(self, params)

        client = Client(
            streamable_http_client(url, http_client=http),
            elicitation_callback=on_elicit,
            client_info=Implementation(name="nova-alexa-plus-simulator", version="0.1.0"),
            extensions=[advertise(APPS_EXTENSION, {"mimeTypes": [APP_MIME]})],
            read_timeout_seconds=120,
        )
        self.client = await self._stack.enter_async_context(client)
        self.tools = (await self.client.list_tools()).tools

    async def close(self) -> None:
        if self._stack:
            await self._stack.aclose()
        self.client = None

    def tool_specs(self) -> list[dict[str, Any]]:
        return [
            {"name": t.name, "description": t.description or t.title or t.name,
             "input_schema": t.input_schema or {"type": "object", "properties": {}}}
            for t in self.tools
        ]

    def ui_uri(self, tool_name: str) -> str | None:
        for t in self.tools:
            if t.name == tool_name:
                meta = t.meta or {}
                ui = meta.get("ui") or {}
                return ui.get("resourceUri") or meta.get("ui/resourceUri")
        return None


def system_prompt(device: Device) -> str:
    p = device.person
    t = datetime.now()
    if p["role"] == "elder":
        who = (f"{p['name']} ({p['short_name']}), 81, who lives alone in {p['location']}. She is the person being cared for. "
               "Speak slowly and simply, be warm and patient, never patronizing.")
    else:
        who = (f"{p['name']} ({p['short_name']}), {p['relation'].split('/')[0]} of Rose Alvarez, in {p['location']}. "
               "They are a caregiver who wants clear, honest updates and the next step.")
    return (
        f"You are Alexa+ on {p['device']}, talking with {who}\n"
        f"Local time: {t.strftime('%A %B')} {t.day}, {t.strftime('%I:%M %p').lstrip('0')}.\n"
        "You have the Nova care-circle integration (MCP tools). Use Nova tools for anything about medications, how "
        "the person feels, the care circle, messages, appointments, doctor's notes, alerts and briefings.\n"
        "- When Rose says how she feels, call daily_checkin with her exact words.\n"
        "- When Rose says she took (or skipped) a pill, call log_medication. If she asks whether she took it, call check_medication.\n"
        "- 'How is Mom doing?' and similar from family: call care_briefing.\n"
        "- To tell someone something, call send_message.\n"
        "Answer in one to three short spoken sentences, no markdown or lists. Prefer the tool's `speech` text; you "
        "may shorten it. Never invent medical facts, doses or advice. If there is an emergency, tell them to call 911."
    )


class Agent:
    def __init__(self, devices: dict[str, Device]) -> None:
        self.devices = devices
        self.backend: Backend = get_backend()

    def brain_for(self, device: Device) -> Backend:
        return self.backend if self.backend.name != "none" else RulesBrain(device.person["role"])

    def brain_info(self) -> dict[str, str]:
        if self.backend.name == "none":
            return {"name": "rules", "label": RulesBrain("elder").label}
        return {"name": self.backend.name, "label": self.backend.label}

    async def run_turn(self, device: Device, text: str, emit: Emit) -> dict[str, Any]:
        async with device.lock:
            return await self._run_turn(device, text, emit)

    async def _run_turn(self, device: Device, text: str, emit: Emit) -> dict[str, Any]:
        assert device.client is not None
        t_start = time.perf_counter()
        trace: list[dict[str, Any]] = []
        cards: list[dict[str, Any]] = []
        last_speech = ""

        async def push(item: dict[str, Any]) -> None:
            item = {"at": now_iso(), **item}
            trace.append(item)
            await emit({"type": "trace", "device": device.id, "item": item})

        await push({"kind": "user", "text": text})
        device.history.append({"role": "user", "text": text})
        brain = self.brain_for(device)
        system = system_prompt(device)
        specs = device.tool_specs()
        reply = ""
        for _ in range(MAX_STEPS):
            try:
                step = await asyncio.to_thread(brain.step, system, device.history, specs)
            except Exception as exc:  # model failure: fall back to the offline router for this turn
                log.exception("model step failed")
                await push({"kind": "error", "message": f"{brain.label}: {str(exc)[:200]}. Using offline router."})
                brain = RulesBrain(device.person["role"])
                step = await asyncio.to_thread(brain.step, system, device.history, specs)
            await push({"kind": "llm", "brain": brain.label, "latency_ms": step.latency_ms, "text": step.text,
                        "tool_calls": [{"name": c["name"], "args": c["args"]} for c in step.tool_calls]})
            if not step.tool_calls:
                reply = voice_guard(step.text, last_speech)
                device.history.append({"role": "assistant", "text": reply})
                break
            device.history.append({"role": "assistant", "text": step.text, "tool_calls": step.tool_calls})
            for call in step.tool_calls:
                await push({"kind": "tool_call", "name": call["name"], "args": call["args"]})
                t0 = time.perf_counter()
                try:
                    result = await device.client.call_tool(call["name"], call["args"])
                    data = structured_of(result)
                    ok = not getattr(result, "is_error", False)
                except Exception as exc:
                    log.exception("tool call failed")
                    result, data, ok = None, {"error": str(exc)[:300]}, False
                ms = int((time.perf_counter() - t0) * 1000)
                uri = device.ui_uri(call["name"]) if ok else None
                if data.get("speech"):
                    last_speech = data["speech"]
                await push({"kind": "tool_result", "name": call["name"], "ok": ok, "speech": data.get("speech"),
                            "structured": data, "ui": uri, "ms": ms})
                if uri and result is not None:
                    html = await self.read_ui(device, uri)
                    cards.append({"tool": call["name"], "resource_uri": uri, "html": html,
                                  "input": call["args"], "result": result_json(result)})
                device.history.append({"role": "tool", "id": call["id"], "name": call["name"],
                                       "result": for_model(data, bool(uri)) if ok else {"error": data.get("error", "tool failed")},
                                       "error": not ok})
        if not reply:
            reply = last_speech or "Sorry, I couldn't finish that."
            device.history.append({"role": "assistant", "text": reply})
        self._trim(device)
        await push({"kind": "reply", "text": reply})
        return {
            "reply": reply, "cards": cards, "trace": trace, "brain": brain.label,
            "latency_ms": int((time.perf_counter() - t_start) * 1000),
        }

    async def read_ui(self, device: Device, uri: str) -> str:
        assert device.client is not None
        res = await device.client.read_resource(uri)
        for c in res.contents:
            text = getattr(c, "text", None)
            if text:
                return text
        return ""

    @staticmethod
    def _trim(device: Device) -> None:
        """Keep the last few user turns so context stays small; never split a tool exchange."""
        users = [i for i, m in enumerate(device.history) if m["role"] == "user"]
        if len(users) > HISTORY_TURNS:
            device.history = device.history[users[-HISTORY_TURNS]:]


def new_id() -> str:
    return uuid.uuid4().hex[:12]
