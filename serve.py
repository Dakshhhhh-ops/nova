"""Nova in one process on one port, for hosting (AWS App Runner, Docker).

    PORT=8080 NOVA_PUBLIC_URL=https://xyz.us-east-1.awsapprunner.com python serve.py

Routes the MCP server (/mcp, OAuth endpoints, /link, /healthz, /demo/*, /integrations/*) and the
Alexa+ simulator (/, /live, /api/*, /static/*, /samples/*) through one ASGI app. The simulator
talks to the MCP server over HTTP on the same port, exactly as it does when they run apart.
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from urllib.parse import urlparse

from dotenv import load_dotenv

load_dotenv()

PORT = int(os.getenv("PORT", "8080"))
# Public URL: explicit, or what the host tells us (Render, Hugging Face Spaces), or localhost.
PUBLIC_URL = (os.getenv("NOVA_PUBLIC_URL") or os.getenv("RENDER_EXTERNAL_URL")
              or (f"https://{os.environ['SPACE_HOST']}" if os.getenv("SPACE_HOST") else "")
              or f"http://localhost:{PORT}").rstrip("/")
os.environ["NOVA_PUBLIC_URL"] = PUBLIC_URL
os.environ.setdefault("NOVA_MCP_URL", f"http://127.0.0.1:{PORT}/mcp")
os.environ["NOVA_LAZY_CONNECT"] = "1"

from mcp.server.transport_security import TransportSecuritySettings  # noqa: E402

from nova_server import server  # noqa: E402
from simulator import app as simulator  # noqa: E402

public = urlparse(PUBLIC_URL)
security = TransportSecuritySettings(
    enable_dns_rebinding_protection=True,
    allowed_hosts=[public.netloc, f"{public.hostname}:*", "127.0.0.1:*", "localhost:*"],
    allowed_origins=[PUBLIC_URL, "http://127.0.0.1:*", "http://localhost:*"],
)
mcp_app = server.mcp.streamable_http_app(host="0.0.0.0", transport_security=security)
web_app = simulator.app

MCP_PATHS = ("/mcp", "/.well-known/oauth", "/authorize", "/token", "/register", "/revoke", "/link",
             "/healthz", "/demo/", "/integrations/")


@asynccontextmanager
async def both():
    async with mcp_app.router.lifespan_context(mcp_app):
        async with web_app.router.lifespan_context(web_app):
            yield


async def app(scope, receive, send):
    if scope["type"] == "lifespan":
        await receive()  # lifespan.startup
        cm = both()
        try:
            await cm.__aenter__()
        except Exception as exc:  # pragma: no cover
            await send({"type": "lifespan.startup.failed", "message": str(exc)})
            return
        await send({"type": "lifespan.startup.complete"})
        await receive()  # lifespan.shutdown
        try:
            await cm.__aexit__(None, None, None)
        finally:
            await send({"type": "lifespan.shutdown.complete"})
        return
    path = scope.get("path", "")
    target = mcp_app if path == "/mcp" or path.startswith(MCP_PATHS) else web_app
    await target(scope, receive, send)


def main() -> None:
    import logging

    import uvicorn

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    server.engine.start()
    server.ring_api.start_poller(server.store, server.engine)
    print(f"Nova on one port: {PUBLIC_URL}  (story /, live demo /live, MCP /mcp)")
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info", proxy_headers=True, forwarded_allow_ips="*")


if __name__ == "__main__":
    main()
