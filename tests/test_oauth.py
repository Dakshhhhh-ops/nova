"""OAuth 2.1 account linking, end to end, the way Alexa+ or any MCP client would do it."""

from __future__ import annotations

import base64
import hashlib
import os
import secrets
import socket
import tempfile
import threading
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

os.environ.setdefault("NOVA_LLM", "rules")
os.environ.setdefault("NOVA_DB", str(Path(tempfile.mkdtemp()) / "nova-test.db"))

from mcp import Client  # noqa: E402

from nova_server import server  # noqa: E402
from nova_server.seed import seed  # noqa: E402

CALLBACK = "http://localhost:9999/callback"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def base():
    import uvicorn

    seed(server.store)
    port = _free_port()
    srv = uvicorn.Server(uvicorn.Config(server.mcp.streamable_http_app(host="127.0.0.1"), host="127.0.0.1",
                                       port=port, log_level="warning"))
    th = threading.Thread(target=srv.run, daemon=True)
    th.start()
    for _ in range(100):
        if srv.started:
            break
        time.sleep(0.05)
    yield f"http://127.0.0.1:{port}"
    srv.should_exit = True
    th.join(timeout=5)


def link_account(base: str, person: str) -> dict:
    with httpx.Client(base_url=base, follow_redirects=False, timeout=10) as http:
        prm = http.get("/.well-known/oauth-protected-resource/mcp").json()
        assert prm["authorization_servers"]
        meta = http.get("/.well-known/oauth-authorization-server").json()
        assert meta["registration_endpoint"].endswith("/register") and "S256" in meta["code_challenge_methods_supported"]

        reg = http.post("/register", json={
            "redirect_uris": [CALLBACK], "client_name": "Alexa+ (test)", "token_endpoint_auth_method": "none",
            "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"], "scope": "nova.care",
        })
        assert reg.status_code in (200, 201), reg.text
        client_id = reg.json()["client_id"]

        verifier = secrets.token_urlsafe(48)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        auth = http.get("/authorize", params={
            "response_type": "code", "client_id": client_id, "redirect_uri": CALLBACK, "state": "xyz",
            "code_challenge": challenge, "code_challenge_method": "S256", "scope": "nova.care",
        })
        assert auth.status_code in (302, 307), auth.text
        link_url = urlparse(auth.headers["location"])
        assert link_url.path == "/link"
        session = parse_qs(link_url.query)["session"][0]

        page = http.get("/link", params={"session": session})
        assert page.status_code == 200 and "Maya Alvarez-Chen" in page.text and "Alexa+ (test)" in page.text

        done = http.post("/link", data={"session": session, "person": person})
        assert done.status_code == 302
        back = urlparse(done.headers["location"])
        q = parse_qs(back.query)
        assert back.path == "/callback" and q["state"] == ["xyz"]

        tok = http.post("/token", data={
            "grant_type": "authorization_code", "code": q["code"][0], "redirect_uri": CALLBACK,
            "client_id": client_id, "code_verifier": verifier,
        })
        assert tok.status_code == 200, tok.text
        token = tok.json()
        assert token["token_type"].lower() == "bearer" and token["refresh_token"]

        # The code is single-use.
        again = http.post("/token", data={
            "grant_type": "authorization_code", "code": q["code"][0], "redirect_uri": CALLBACK,
            "client_id": client_id, "code_verifier": verifier,
        })
        assert again.status_code >= 400
        return {**token, "client_id": client_id}


async def test_linked_account_acts_as_that_person(base):
    token = link_account(base, "maya")
    import httpx2
    from mcp.client.streamable_http import streamable_http_client

    async with httpx2.AsyncClient(headers={"Authorization": f"Bearer {token['access_token']}"}) as http:
        async with Client(streamable_http_client(f"{base}/mcp", http_client=http)) as c:
            r = await c.call_tool("set_sharing", {"category": "medications", "shared_with_circle": False})
    # Maya is a caregiver, so only Rose may change sharing: the token carries her identity.
    assert "Only the person being cared for" in r.structured_content["speech"]


def test_refresh_rotates_and_bad_tokens_are_rejected(base):
    token = link_account(base, "rose")
    with httpx.Client(base_url=base, timeout=10) as http:
        new = http.post("/token", data={"grant_type": "refresh_token", "refresh_token": token["refresh_token"],
                                         "client_id": token["client_id"]})
        assert new.status_code == 200 and new.json()["access_token"] != token["access_token"]
        reuse = http.post("/token", data={"grant_type": "refresh_token", "refresh_token": token["refresh_token"],
                                           "client_id": token["client_id"]})
        assert reuse.status_code >= 400
        bad = http.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
                        headers={"Authorization": "Bearer not-a-token", "accept": "application/json, text/event-stream"})
        assert bad.status_code == 401
