"""Amazon Nova comes back by itself: a throttled Bedrock is retried in the background, and a
quota hit mid-session falls back without a restart."""

from __future__ import annotations

import time

import pytest

from nova_server import llm


@pytest.fixture()
def fresh(monkeypatch):
    monkeypatch.setenv("NOVA_LLM", "auto")
    monkeypatch.setattr(llm, "_BACKEND", None)
    monkeypatch.setattr(llm, "_BEDROCK_ERROR", None)
    monkeypatch.setattr(llm, "_LAST_PROBE", 0.0)
    monkeypatch.setattr(llm.Ollama, "available", lambda self: False)
    yield monkeypatch


def throttled(self):
    self.error = "ThrottlingException: Too many tokens per day, please wait before trying again."
    return False


def answers(self):
    self.model_id, self._client, self._ok = "us.amazon.nova-2-lite-v1:0", object(), True
    return True


def test_throttled_at_startup_then_recovers(fresh):
    fresh.setattr(llm.Bedrock, "available", throttled)
    b = llm.get_backend()
    assert b.name == "none"
    assert llm.bedrock_note() == "Amazon Nova daily quota reached, retrying"

    # The quota resets; the next request after the retry interval re-probes in the background.
    fresh.setattr(llm.Bedrock, "available", answers)
    fresh.setattr(llm, "_LAST_PROBE", time.time() - llm.RETRY_SECONDS - 1)
    llm.get_backend()
    for _ in range(100):
        if isinstance(llm._BACKEND, llm.Bedrock):
            break
        time.sleep(0.02)
    assert llm.get_backend().label == "Amazon Nova 2 Lite · Amazon Bedrock"
    assert llm.bedrock_note() is None


def test_no_retry_storm_within_interval(fresh):
    calls = []

    def count(self):
        calls.append(1)
        return throttled(self)

    fresh.setattr(llm.Bedrock, "available", count)
    llm.get_backend()
    for _ in range(20):
        llm.get_backend()
    time.sleep(0.05)
    assert len(calls) == 1


def test_quota_hit_mid_session_falls_back(fresh):
    fresh.setattr(llm.Bedrock, "available", answers)
    b = llm.get_backend()
    assert isinstance(b, llm.Bedrock)

    class Throttles:
        def converse(self, **_):
            raise RuntimeError("ThrottlingException: Too many tokens per day")

    b._client = Throttles()
    with pytest.raises(RuntimeError):
        b.complete("sys", "hi")
    assert llm.get_backend().name == "none"
    assert "quota" in llm.bedrock_note()


def test_offline_label_says_why():
    from simulator.rules import RulesBrain

    llm._BEDROCK_ERROR, saved = "ThrottlingException: Too many tokens per day", llm._BEDROCK_ERROR
    try:
        assert RulesBrain("elder").label == "Nova offline router (Amazon Nova daily quota reached, retrying)"
    finally:
        llm._BEDROCK_ERROR = saved
