"""OAuth 2.1 account linking for Nova.

Alexa+ (and any MCP client: MCP Inspector, Claude, Kiro) connects to Nova the
standard way: it discovers the authorization server from the protected-resource
metadata, registers itself (RFC 7591 dynamic client registration), sends the
person through /authorize with PKCE, and exchanges the code at /token.

The "login" step is Nova's account-linking page, where the person says who
they are in the care circle. In production that page would sit behind Login
with Amazon or Amazon Cognito. The demo bearer tokens keep working, so the
simulator and tests don't need a browser.
"""

from __future__ import annotations

import html
import secrets
import time
from dataclasses import dataclass, field
from typing import Any

from mcp.server.auth.provider import (
    AccessToken,
    AuthorizationCode,
    AuthorizationParams,
    RefreshToken,
    construct_redirect_uri,
)
from mcp.shared.auth import OAuthClientInformationFull, OAuthToken

SCOPE = "nova.care"
ACCESS_TTL = 3600
CODE_TTL = 300


@dataclass
class NovaOAuthProvider:
    """In-memory authorization server for the care circle (single process)."""

    store: Any                     # nova_server.store.Store
    demo_tokens: dict[str, str]    # token -> person id
    issuer: str                    # e.g. http://127.0.0.1:8765
    resource: str                  # e.g. http://127.0.0.1:8765/mcp
    clients: dict[str, OAuthClientInformationFull] = field(default_factory=dict)
    sessions: dict[str, tuple[str, AuthorizationParams, float]] = field(default_factory=dict)
    codes: dict[str, AuthorizationCode] = field(default_factory=dict)
    access: dict[str, AccessToken] = field(default_factory=dict)
    refresh: dict[str, RefreshToken] = field(default_factory=dict)

    # -- clients ----------------------------------------------------------------
    async def get_client(self, client_id: str) -> OAuthClientInformationFull | None:
        return self.clients.get(client_id)

    async def register_client(self, client_info: OAuthClientInformationFull) -> None:
        self.clients[client_info.client_id] = client_info

    # -- authorization ------------------------------------------------------------
    async def authorize(self, client: OAuthClientInformationFull, params: AuthorizationParams) -> str:
        session = secrets.token_urlsafe(24)
        self.sessions[session] = (client.client_id, params, time.time() + 600)
        return f"{self.issuer}/link?session={session}"

    def link_page(self, session: str) -> tuple[int, str]:
        found = self.sessions.get(session)
        if not found or found[2] < time.time():
            return 400, _page("This link has expired", "<p>Start linking again from your Alexa app.</p>")
        client_id, _params, _ = found
        client = self.clients.get(client_id)
        app = html.escape((client.client_name if client and client.client_name else None) or "Alexa+")
        people = "".join(
            f'<button name="person" value="{html.escape(p["id"])}" type="submit">'
            f'<span class="n">{html.escape(p["name"])}</span>'
            f'<span class="r">{html.escape((p.get("relation") or "").split("/")[0])} · {html.escape(p.get("location") or "")}</span>'
            "</button>"
            for p in self.store.people()
        )
        body = (
            f"<p class=lead><b>{app}</b> wants to use Nova on your behalf: medications, check-ins, messages and "
            "the care briefing. Who are you in Rose's care circle?</p>"
            f'<form method="post" action="/link"><input type="hidden" name="session" value="{html.escape(session)}">'
            f'<div class="people">{people}</div></form>'
            "<p class=fine>Demo account linking. In production this step is Login with Amazon or Amazon Cognito, "
            "and the person is identified by their own sign-in.</p>"
        )
        return 200, _page("Link your account to Nova", body)

    def complete_link(self, session: str, person_id: str) -> str | None:
        """The person chose who they are: mint the code and return the client's redirect URL."""
        found = self.sessions.pop(session, None)
        if not found or found[2] < time.time() or not self.store.person(person_id):
            return None
        client_id, params, _ = found
        code = secrets.token_urlsafe(32)
        self.codes[code] = AuthorizationCode(
            code=code, scopes=params.scopes or [SCOPE], expires_at=time.time() + CODE_TTL, client_id=client_id,
            code_challenge=params.code_challenge, redirect_uri=params.redirect_uri,
            redirect_uri_provided_explicitly=params.redirect_uri_provided_explicitly,
            resource=params.resource or self.resource, subject=person_id,
        )
        return construct_redirect_uri(str(params.redirect_uri), code=code, state=params.state)

    async def load_authorization_code(self, client: OAuthClientInformationFull, authorization_code: str) -> AuthorizationCode | None:
        code = self.codes.get(authorization_code)
        if code and code.client_id == client.client_id and code.expires_at > time.time():
            return code
        return None

    async def exchange_authorization_code(self, client: OAuthClientInformationFull, authorization_code: AuthorizationCode) -> OAuthToken:
        self.codes.pop(authorization_code.code, None)
        return self._issue(client.client_id, authorization_code.scopes, authorization_code.subject, authorization_code.resource)

    # -- refresh --------------------------------------------------------------------
    async def load_refresh_token(self, client: OAuthClientInformationFull, refresh_token: str) -> RefreshToken | None:
        rt = self.refresh.get(refresh_token)
        return rt if rt and rt.client_id == client.client_id else None

    async def exchange_refresh_token(self, client: OAuthClientInformationFull, refresh_token: RefreshToken, scopes: list[str]) -> OAuthToken:
        self.refresh.pop(refresh_token.token, None)  # rotate
        return self._issue(client.client_id, scopes or refresh_token.scopes, refresh_token.subject, refresh_token.resource)

    # -- access tokens ---------------------------------------------------------------
    async def load_access_token(self, token: str) -> AccessToken | None:
        person = self.demo_tokens.get(token)
        if person and self.store.person(person):
            return AccessToken(token=token, client_id="alexa-plus-demo", scopes=[SCOPE], subject=person, resource=self.resource)
        at = self.access.get(token)
        if at and (at.expires_at is None or at.expires_at > time.time()) and self.store.person(at.subject or ""):
            return at
        return None

    async def revoke_token(self, token: AccessToken | RefreshToken) -> None:
        self.access.pop(token.token, None)
        self.refresh.pop(token.token, None)

    def _issue(self, client_id: str, scopes: list[str], subject: str | None, resource: str | None) -> OAuthToken:
        access, refresh = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        exp = int(time.time()) + ACCESS_TTL
        self.access[access] = AccessToken(token=access, client_id=client_id, scopes=scopes, expires_at=exp,
                                          subject=subject, resource=resource or self.resource)
        self.refresh[refresh] = RefreshToken(token=refresh, client_id=client_id, scopes=scopes,
                                             subject=subject, resource=resource or self.resource)
        return OAuthToken(access_token=access, expires_in=ACCESS_TTL, scope=" ".join(scopes), refresh_token=refresh)


def _page(title: str, body: str) -> str:
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>{html.escape(title)} · Nova</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter+Tight:wght@400;500;600&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet">
<style>
:root{{--ink:#0A0B10;--ink2:#11131A;--ivory:#F4EEE6;--mist:rgba(244,238,230,.62);--line:rgba(244,238,230,.12);--nova:#3BD1FF}}
*{{box-sizing:border-box}}body{{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(1200px 600px at 50% -10%,#1B2347 0%,var(--ink) 60%);color:var(--ivory);font:16px/1.55 "Inter Tight",system-ui,sans-serif;padding:24px}}
main{{width:min(560px,100%)}}.mark{{font:11px/1 "JetBrains Mono",ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--mist);display:flex;gap:10px;align-items:center}}
.ring{{width:14px;height:14px;border-radius:50%;border:2px solid var(--nova);box-shadow:0 0 18px var(--nova)}}
h1{{font:400 clamp(40px,7vw,64px)/.95 "Instrument Serif",Georgia,serif;letter-spacing:-.02em;margin:22px 0 14px}}.lead{{color:var(--mist);font-size:18px}}
.people{{display:grid;gap:10px;margin:26px 0}}button{{all:unset;cursor:pointer;display:flex;justify-content:space-between;align-items:baseline;gap:16px;padding:18px 20px;border:1px solid var(--line);border-radius:16px;background:rgba(255,255,255,.02);transition:.25s cubic-bezier(.22,1,.36,1)}}
button:hover,button:focus-visible{{border-color:var(--nova);background:rgba(59,209,255,.06);transform:translateY(-1px)}}.n{{font:400 26px/1 "Instrument Serif",Georgia,serif}}.r{{font:11px "JetBrains Mono",ui-monospace,monospace;letter-spacing:.1em;text-transform:uppercase;color:var(--mist)}}
.fine{{font-size:13px;color:var(--mist);border-top:1px solid var(--line);padding-top:16px}}b{{color:var(--ivory);font-weight:600}}
</style></head><body><main><div class="mark"><span class="ring"></span>Nova · account linking</div><h1>{html.escape(title)}</h1>{body}</main></body></html>"""
