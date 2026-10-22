"""Run the Nova MCP server.

    python -m nova_server                     # Streamable HTTP on http://127.0.0.1:8765/mcp
    python -m nova_server --stdio --as maya   # stdio, acting as one circle member (for local agents)
    python -m nova_server --reset             # re-seed the demo household and exit
"""

from __future__ import annotations

import argparse
import logging

from dotenv import load_dotenv

load_dotenv()


def main() -> None:
    parser = argparse.ArgumentParser(prog="nova_server", description="Nova care-circle MCP server")
    parser.add_argument("--stdio", action="store_true", help="serve over stdio instead of Streamable HTTP")
    parser.add_argument("--as", dest="as_person", default="rose", help="circle member for stdio mode (rose, maya, leo, grace)")
    parser.add_argument("--reset", action="store_true", help="re-seed the demo household and exit")
    parser.add_argument("--host", default=None)
    parser.add_argument("--port", type=int, default=None)
    args = parser.parse_args()

    from . import server
    from .seed import seed

    if args.reset:
        seed(server.store)
        print(f"Demo household re-seeded in {server.DB_PATH}")
        return

    if args.stdio:
        server.set_stdio_user(args.as_person)
        server.mcp.run("stdio")
        return

    import uvicorn

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    host = args.host or server.HOST
    port = args.port or server.PORT
    app = server.mcp.streamable_http_app(host=host)
    print(f"Nova MCP server · Streamable HTTP · http://{host}:{port}/mcp")
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
