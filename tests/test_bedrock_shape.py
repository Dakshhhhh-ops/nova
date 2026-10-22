"""Validate our Bedrock Converse requests against botocore's API model (no network, no credentials)."""

from __future__ import annotations

import boto3
from botocore.stub import Stubber

from nova_server.llm import Bedrock

TOOLS = [{
    "name": "log_medication",
    "description": "Record that a dose was taken.",
    "input_schema": {"type": "object", "properties": {"medication": {"type": "string"}}, "required": []},
}]

HISTORY = [
    {"role": "user", "text": "I just took my pink pill"},
    {"role": "assistant", "text": "", "tool_calls": [{"id": "tu_1", "name": "log_medication", "args": {"medication": "pink"}}]},
    {"role": "tool", "id": "tu_1", "name": "log_medication", "result": {"speech": "You already took it.", "warning": "double_dose_risk"}},
    {"role": "user", "text": "Thanks. Any messages?"},
]


def make_backend() -> tuple[Bedrock, Stubber]:
    b = Bedrock()
    b._client = boto3.client("bedrock-runtime", region_name="us-east-1",
                             aws_access_key_id="test", aws_secret_access_key="test")
    b.model_id = "us.amazon.nova-2-lite-v1:0"
    return b, Stubber(b._client)


def test_converse_request_with_tool_history_is_valid():
    b, stub = make_backend()
    stub.add_response("converse", {
        "output": {"message": {"role": "assistant", "content": [
            {"text": "<thinking>check inbox</thinking>"},
            {"toolUse": {"toolUseId": "tu_2", "name": "read_messages", "input": {}}},
        ]}},
        "stopReason": "tool_use",
        "usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15},
        "metrics": {"latencyMs": 100},
    })
    with stub:
        step = b.step("You are Alexa+.", HISTORY, TOOLS)  # botocore raises if the request shape is invalid
    assert step.tool_calls == [{"id": "tu_2", "name": "read_messages", "args": {}}]
    assert step.text == ""  # thinking stripped


def test_messages_alternate_roles():
    msgs = Bedrock._to_bedrock(HISTORY)
    roles = [m["role"] for m in msgs]
    assert roles == ["user", "assistant", "user"]
    # the tool result and the next user utterance share one user turn, as Converse requires
    assert "toolResult" in msgs[2]["content"][0] and "text" in msgs[2]["content"][1]


def test_plain_completion_request_is_valid():
    b, stub = make_backend()
    stub.add_response("converse", {
        "output": {"message": {"role": "assistant", "content": [{"text": '{"headline": "Steady", "speech": "All good."}'}]}},
        "stopReason": "end_turn",
        "usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15},
        "metrics": {"latencyMs": 100},
    })
    with stub:
        out = b.complete("system", "prompt", json_mode=True)
    assert "Steady" in out


def test_history_starting_with_an_announcement_is_valid():
    b, stub = make_backend()
    history = [{"role": "assistant", "text": "(Nova announcement) It's 6 PM, Rose. Time for your Metformin."},
               {"role": "user", "text": "I took it"}]
    msgs = Bedrock._to_bedrock(history)
    assert msgs[0]["role"] == "user" and [m["role"] for m in msgs] == ["user", "assistant", "user"]
    stub.add_response("converse", {
        "output": {"message": {"role": "assistant", "content": [{"text": "Great."}]}},
        "stopReason": "end_turn", "usage": {"inputTokens": 1, "outputTokens": 1, "totalTokens": 2},
        "metrics": {"latencyMs": 1},
    })
    with stub:
        assert b.step("sys", history, TOOLS).text == "Great."
