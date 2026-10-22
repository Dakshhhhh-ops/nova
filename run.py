"""Start everything: the Nova MCP server and the Alexa+ simulator.

    uv run python run.py            # then open http://127.0.0.1:8080
    uv run python run.py --no-browser
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
import webbrowser

import httpx
from dotenv import load_dotenv

load_dotenv()

MCP_PORT = int(os.getenv("NOVA_MCP_PORT", "8765"))
SIM_PORT = int(os.getenv("SIMULATOR_PORT", "8080"))


def wait_for(url: str, seconds: float = 20) -> bool:
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
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    server = subprocess.Popen([sys.executable, "-m", "nova_server"], env=env)
    try:
        if not wait_for(f"http://127.0.0.1:{MCP_PORT}/healthz"):
            sys.exit("Nova MCP server did not start; see the log above.")
        print(f"Nova MCP server ready at http://127.0.0.1:{MCP_PORT}/mcp")
        sim = subprocess.Popen([sys.executable, "-m", "simulator"], env=env)
        if wait_for(f"http://127.0.0.1:{SIM_PORT}/api/status", 60) and "--no-browser" not in sys.argv:
            webbrowser.open(f"http://127.0.0.1:{SIM_PORT}")
        print(f"Alexa+ simulator ready at http://127.0.0.1:{SIM_PORT}  (Ctrl+C to stop)")
        sim.wait()
    except KeyboardInterrupt:
        pass
    finally:
        for proc in (locals().get("sim"), server):
            if proc and proc.poll() is None:
                proc.terminate()


if __name__ == "__main__":
    main()
