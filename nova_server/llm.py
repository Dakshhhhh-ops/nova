"""Model access for Nova.

Primary: Amazon Nova models on Amazon Bedrock (Converse API).
Fallback: a local Ollama model, so the project still runs offline.
Last resort: no model at all; callers fall back to deterministic templates.

Messages use one neutral shape so the agent loop does not care which
backend answers:

    {"role": "user", "text": "..."}
    {"role": "assistant", "text": "...", "tool_calls": [{"id", "name", "args"}]}
    {"role": "tool", "id": "...", "name": "...", "result": {...}}
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

import httpx

log = logging.getLogger("nova.llm")


@dataclass
class Step:
    """One model turn: some text and/or tool calls."""

    text: str = ""
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    latency_ms: int = 0


class Backend:
    name = "none"
    label = "No model"

    def available(self) -> bool:
        return False

    def complete(self, system: str, prompt: str, *, max_tokens: int = 600, json_mode: bool = False) -> str:
        raise NotImplementedError

    def step(self, system: str, history: list[dict[str, Any]], tools: list[dict[str, Any]]) -> Step:
        raise NotImplementedError


# ---------------------------------------------------------------------------
# Amazon Bedrock: Amazon Nova
# ---------------------------------------------------------------------------
NOVA_LABELS = {
    "nova-2-lite": "Amazon Nova 2 Lite",
    "nova-2-pro": "Amazon Nova 2 Pro",
    "nova-pro": "Amazon Nova Pro",
    "nova-lite": "Amazon Nova Lite",
    "nova-micro": "Amazon Nova Micro",
    "nova-premier": "Amazon Nova Premier",
}


def _nova_label(model_id: str) -> str:
    for key, label in NOVA_LABELS.items():
        if key in model_id:
            return label
    return model_id


class Bedrock(Backend):
    name = "bedrock"

    def __init__(self) -> None:
        self.region = os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION") or ""
        self.model_id: str | None = None
        self._client = None
        self._checked = False
        self._ok = False
        self.error: str | None = None

    @property
    def label(self) -> str:  # type: ignore[override]
        return f"{_nova_label(self.model_id or 'amazon.nova')} · Amazon Bedrock"

    def _candidates(self, region: str) -> list[str]:
        forced = os.getenv("NOVA_MODEL_ID")
        if forced:
            return [forced]
        geo = {"us": "us", "eu": "eu", "ap": "apac", "ca": "us", "sa": "us"}.get(region[:2], "us")
        return [
            f"{geo}.amazon.nova-2-lite-v1:0",
            "global.amazon.nova-2-lite-v1:0",
            f"{geo}.amazon.nova-lite-v1:0",
            "amazon.nova-lite-v1:0",
            f"{geo}.amazon.nova-micro-v1:0",
        ]

    def available(self) -> bool:
        if self._checked:
            return self._ok
        self._checked = True
        try:
            import boto3

            session = boto3.Session()
            region = self.region or session.region_name or "us-east-1"
            self.region = region
            self._client = session.client("bedrock-runtime", region_name=region)
            last = None
            for model_id in self._candidates(region):
                try:
                    self._client.converse(
                        modelId=model_id,
                        messages=[{"role": "user", "content": [{"text": "ping"}]}],
                        inferenceConfig={"maxTokens": 4},
                    )
                    self.model_id = model_id
                    self._ok = True
                    log.info("Bedrock ready: %s in %s", model_id, region)
                    return True
                except Exception as exc:  # try the next candidate
                    last = exc
                    msg = str(exc)
                    if "security token" in msg or "credentials" in msg.lower() or "ExpiredToken" in msg:
                        break
            self.error = str(last)[:300] if last else "no model"
        except Exception as exc:
            self.error = str(exc)[:300]
        log.warning("Bedrock unavailable: %s", self.error)
        return False

    def complete(self, system: str, prompt: str, *, max_tokens: int = 600, json_mode: bool = False) -> str:
        assert self._client and self.model_id
        if json_mode:
            prompt += "\n\nRespond with a single JSON object and nothing else."
        resp = self._client.converse(
            modelId=self.model_id,
            system=[{"text": system}],
            messages=[{"role": "user", "content": [{"text": prompt}]}],
            inferenceConfig={"maxTokens": max_tokens, "temperature": 0.3},
        )
        return "".join(c.get("text", "") for c in resp["output"]["message"]["content"])

    def step(self, system: str, history: list[dict[str, Any]], tools: list[dict[str, Any]]) -> Step:
        assert self._client and self.model_id
        t0 = time.perf_counter()
        kwargs: dict[str, Any] = {
            "modelId": self.model_id,
            "system": [{"text": system}],
            "messages": self._to_bedrock(history),
            "inferenceConfig": {"maxTokens": 700, "temperature": 0},
        }
        if tools:
            kwargs["toolConfig"] = {
                "tools": [
                    {"toolSpec": {"name": t["name"], "description": t["description"][:1000],
                                  "inputSchema": {"json": t["input_schema"]}}}
                    for t in tools
                ]
            }
        resp = self._client.converse(**kwargs)
        out = Step(latency_ms=int((time.perf_counter() - t0) * 1000))
        for block in resp["output"]["message"]["content"]:
            if "text" in block:
                out.text += block["text"]
            elif "toolUse" in block:
                tu = block["toolUse"]
                out.tool_calls.append({"id": tu["toolUseId"], "name": tu["name"], "args": tu.get("input") or {}})
        out.text = _strip_thinking(out.text)
        return out

    @staticmethod
    def _to_bedrock(history: list[dict[str, Any]]) -> list[dict[str, Any]]:
        msgs: list[dict[str, Any]] = []

        def push(role: str, block: dict[str, Any]) -> None:
            if msgs and msgs[-1]["role"] == role:
                msgs[-1]["content"].append(block)
            else:
                msgs.append({"role": role, "content": [block]})

        for m in history:
            if m["role"] == "user":
                push("user", {"text": m["text"]})
            elif m["role"] == "assistant":
                if m.get("text"):
                    push("assistant", {"text": m["text"]})
                for c in m.get("tool_calls", []):
                    push("assistant", {"toolUse": {"toolUseId": c["id"], "name": c["name"], "input": c["args"]}})
            elif m["role"] == "tool":
                result = m["result"]
                content = [{"json": result}] if isinstance(result, dict) else [{"text": str(result)}]
                push("user", {"toolResult": {"toolUseId": m["id"], "content": content,
                                             "status": "error" if m.get("error") else "success"}})
        if msgs and msgs[0]["role"] != "user":
            # Converse must start with a user turn; a device can wake up with Nova speaking first.
            msgs.insert(0, {"role": "user", "content": [{"text": "(The device is listening.)"}]})
        return msgs


# ---------------------------------------------------------------------------
# Ollama (local fallback)
# ---------------------------------------------------------------------------
class Ollama(Backend):
    name = "ollama"

    def __init__(self) -> None:
        self.url = os.getenv("OLLAMA_URL", "http://localhost:11434").rstrip("/")
        self.model = os.getenv("OLLAMA_MODEL", "qwen3:8b")
        self._checked = False
        self._ok = False

    @property
    def label(self) -> str:  # type: ignore[override]
        return f"{self.model} · Ollama (local fallback)"

    def available(self) -> bool:
        if self._checked:
            return self._ok
        self._checked = True
        try:
            tags = httpx.get(f"{self.url}/api/tags", timeout=2).json()
            names = [m["name"] for m in tags.get("models", [])]
            self._ok = any(n == self.model or n.startswith(self.model.split(":")[0]) for n in names)
            if self._ok and self.model not in names:
                self.model = next(n for n in names if n.startswith(self.model.split(":")[0]))
        except Exception:
            self._ok = False
        return self._ok

    def _chat(self, payload: dict[str, Any]) -> dict[str, Any]:
        payload.setdefault("stream", False)
        payload.setdefault("think", False)
        payload.setdefault("options", {"temperature": 0.2})
        r = httpx.post(f"{self.url}/api/chat", json={"model": self.model, **payload}, timeout=120)
        r.raise_for_status()
        return r.json()

    def complete(self, system: str, prompt: str, *, max_tokens: int = 600, json_mode: bool = False) -> str:
        payload: dict[str, Any] = {
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}],
            "options": {"temperature": 0.3, "num_predict": max_tokens},
        }
        if json_mode:
            payload["format"] = "json"
        return _strip_thinking(self._chat(payload)["message"].get("content", ""))

    def step(self, system: str, history: list[dict[str, Any]], tools: list[dict[str, Any]]) -> Step:
        t0 = time.perf_counter()
        msgs: list[dict[str, Any]] = [{"role": "system", "content": system}]
        for m in history:
            if m["role"] == "user":
                msgs.append({"role": "user", "content": m["text"]})
            elif m["role"] == "assistant":
                msgs.append({
                    "role": "assistant",
                    "content": m.get("text", ""),
                    "tool_calls": [{"function": {"name": c["name"], "arguments": c["args"]}} for c in m.get("tool_calls", [])],
                })
            elif m["role"] == "tool":
                msgs.append({"role": "tool", "tool_name": m["name"], "content": json.dumps(m["result"], default=str)})
        data = self._chat({
            "messages": msgs,
            "tools": [{"type": "function", "function": {"name": t["name"], "description": t["description"],
                                                         "parameters": t["input_schema"]}} for t in tools],
        })
        msg = data.get("message", {})
        out = Step(text=_strip_thinking(msg.get("content", "")), latency_ms=int((time.perf_counter() - t0) * 1000))
        for c in msg.get("tool_calls") or []:
            fn = c.get("function", {})
            args = fn.get("arguments") or {}
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except json.JSONDecodeError:
                    args = {}
            out.tool_calls.append({"id": f"call_{uuid.uuid4().hex[:8]}", "name": fn.get("name", ""), "args": args})
        return out


def _strip_thinking(text: str) -> str:
    text = re.sub(r"<thinking>.*?</thinking>", "", text or "", flags=re.S)
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S)
    return text.strip()


def parse_json(text: str) -> dict[str, Any] | None:
    """Pull the first JSON object out of a model reply."""
    if not text:
        return None
    text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.M).strip()
    try:
        val = json.loads(text)
        return val if isinstance(val, dict) else None
    except json.JSONDecodeError:
        pass
    m = re.search(r"\{.*\}", text, flags=re.S)
    if m:
        try:
            val = json.loads(m.group(0))
            return val if isinstance(val, dict) else None
        except json.JSONDecodeError:
            return None
    return None


_BACKEND: Backend | None = None


def get_backend(force: str | None = None) -> Backend:
    """Pick the best available model once per process.

    NOVA_LLM=auto (default) tries Bedrock, then Ollama, then none.
    """
    global _BACKEND
    if _BACKEND is not None and force is None:
        return _BACKEND
    choice = (force or os.getenv("NOVA_LLM", "auto")).lower()
    order: list[Backend]
    if choice == "bedrock":
        order = [Bedrock()]
    elif choice == "ollama":
        order = [Ollama()]
    elif choice in ("rules", "none", "off"):
        order = []
    else:
        order = [Bedrock(), Ollama()]
    chosen: Backend = Backend()
    for b in order:
        if b.available():
            chosen = b
            break
    _BACKEND = chosen
    return chosen


# ---------------------------------------------------------------------------
# Vision: Amazon Nova (multimodal) on Bedrock, local VL model as fallback
# ---------------------------------------------------------------------------
_FORMATS = {"image/png": "png", "image/jpeg": "jpeg", "image/jpg": "jpeg", "image/webp": "webp", "image/gif": "gif"}


def vision_json(system: str, prompt: str, image: bytes, mime: str = "image/png") -> tuple[dict[str, Any] | None, str]:
    """Ask a multimodal model about an image; returns (parsed JSON or None, label of who answered)."""
    fmt = _FORMATS.get(mime.lower(), "png")
    backend = get_backend()
    if isinstance(backend, Bedrock) and backend.available() and backend._client is not None:
        model_id = backend.model_id or ""
        if "micro" in model_id:  # Nova Micro is text-only
            model_id = model_id.replace("nova-micro", "nova-lite")
        try:
            resp = backend._client.converse(
                modelId=model_id,
                system=[{"text": system}],
                messages=[{"role": "user", "content": [
                    {"image": {"format": fmt, "source": {"bytes": image}}},
                    {"text": prompt + "\n\nRespond with a single JSON object and nothing else."},
                ]}],
                inferenceConfig={"maxTokens": 800, "temperature": 0},
            )
            text = "".join(c.get("text", "") for c in resp["output"]["message"]["content"])
            return parse_json(_strip_thinking(text)), f"{_nova_label(model_id)} vision · Amazon Bedrock"
        except Exception as exc:
            log.warning("Bedrock vision failed: %s", exc)
    model = os.getenv("OLLAMA_VISION_MODEL", "qwen3-vl:2b-instruct")
    url = os.getenv("OLLAMA_URL", "http://localhost:11434").rstrip("/")
    try:
        names = [m["name"] for m in httpx.get(f"{url}/api/tags", timeout=2).json().get("models", [])]
        if model in names:
            import base64

            r = httpx.post(f"{url}/api/chat", timeout=180, json={
                "model": model, "stream": False, "format": "json", "options": {"temperature": 0},
                "messages": [{"role": "system", "content": system},
                             {"role": "user", "content": prompt, "images": [base64.b64encode(image).decode()]}],
            })
            r.raise_for_status()
            return parse_json(_strip_thinking(r.json()["message"].get("content", ""))), f"{model} · Ollama (local fallback)"
    except Exception as exc:
        log.warning("local vision failed: %s", exc)
    return None, "none"
