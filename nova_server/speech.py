"""Speech for a voice assistant: short first, details on request.

Alexa design guidance: say the one thing that matters in one or two short
sentences, then offer more. Every Nova tool result carries `speech` (what Alexa
says now) and, when there is more to tell, `more` (what it says if the person
answers "yes", "tell me more" or "go on").
"""

from __future__ import annotations

import re

MAX_SENTENCES = 2
MAX_WORDS = 32
OFFER = "Want the details?"

_SPLIT = re.compile(r"(?<!\bDr\.)(?<!\bMr\.)(?<!\bMs\.)(?<!\bSt\.)(?<=[.!?])\s+(?=[A-Z0-9\"“])")


def sentences(text: str) -> list[str]:
    return [s.strip() for s in _SPLIT.split((text or "").strip()) if s.strip()]


def concise(full: str, *, offer: str = OFFER, keep: int = MAX_SENTENCES, max_words: int = MAX_WORDS) -> tuple[str, str | None]:
    """Split speech into what to say now and what to keep for "tell me more"."""
    parts = sentences(full)
    head: list[str] = []
    words = 0
    for p in parts:
        w = len(p.split())
        if head and (len(head) >= keep or words + w > max_words):
            break
        head.append(p)
        words += w
    rest = parts[len(head):]
    if not rest or sum(len(r.split()) for r in rest) < 4:
        return full.strip(), None
    now = " ".join(head)
    if not now.rstrip().endswith("?"):
        now = f"{now} {offer}"
    return now, " ".join(rest)


def finalize(out: dict, *, offer: str = OFFER) -> dict:
    """Apply the voice budget to a tool result, unless the tool already split it."""
    if isinstance(out, dict) and isinstance(out.get("speech"), str) and not out.get("more"):
        now, more = concise(out["speech"], offer=out.get("offer") or offer)
        if more:
            return {**out, "speech": now, "more": more}
    return out
