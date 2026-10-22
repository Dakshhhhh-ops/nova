"""Start everything: the Nova MCP server and the Alexa+ simulator.

    uv run python run.py            # opens the story page; the live demo is at /live
    uv run python run.py --no-browser

Ports default to 8765 (MCP) and 8080 (simulator); if one is taken, the next free port is used.
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
import webbrowser

import httpx
from dotenv import load_dotenv

load_dotenv()


def free_port(preferred: int, span: int = 30) -> int:
    for port in range(preferred, preferred + span):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                s.close()
                # also make sure nothing answers on all interfaces (e.g. a dev server on 0.0.0.0)
                with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
                    probe.settimeout(0.2)
                    if probe.connect_ex(("127.0.0.1", port)) == 0:
                        continue
                return port
            except OSError:
                continue
    raise SystemExit(f"No free port near {preferred}")


def wait_for(url: str, seconds: float = 30) -> bool:
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            if httpx.get(url, timeout=1).status_code < 500:
                return True
        except httpx.HTTPError:
            pass
        time.sleep(0.3)
    return False


def main() -> None:
    mcp_port = free_port(int(os.getenv("NOVA_MCP_PORT", "8765")))
    sim_port = free_port(int(os.getenv("SIMULATOR_PORT", "8080")))
    env = {
        **os.environ, "PYTHONIOENCODING": "utf-8",
        "NOVA_MCP_PORT": str(mcp_port), "NOVA_MCP_URL": f"http://127.0.0.1:{mcp_port}/mcp",
        "NOVA_PUBLIC_URL": os.getenv("NOVA_PUBLIC_URL", f"http://127.0.0.1:{mcp_port}"),
        "SIMULATOR_PORT": str(sim_port),
    }
    server = subprocess.Popen([sys.executable, "-m", "nova_server"], env=env)
    sim = None
    try:
        if not wait_for(f"http://127.0.0.1:{mcp_port}/healthz"):
            sys.exit("Nova MCP server did not start; see the log above.")
        print(f"Nova MCP server ready at http://127.0.0.1:{mcp_port}/mcp")
        sim = subprocess.Popen([sys.executable, "-m", "simulator"], env=env)
        if wait_for(f"http://127.0.0.1:{sim_port}/api/status", 60) and "--no-browser" not in sys.argv:
            webbrowser.open(f"http://127.0.0.1:{sim_port}")
        print(f"Nova is running: story page http://127.0.0.1:{sim_port}  ·  live demo http://127.0.0.1:{sim_port}/live"
              "  (Ctrl+C to stop)")
        sim.wait()
    except KeyboardInterrupt:
        pass
    finally:
        for proc in (sim, server):
            if proc and proc.poll() is None:
                proc.terminate()


if __name__ == "__main__":
    main()
