"""Run the Alexa+ simulator: python -m simulator"""

from __future__ import annotations

import logging
import os

from dotenv import load_dotenv

load_dotenv()


def main() -> None:
    import uvicorn

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    port = int(os.getenv("SIMULATOR_PORT", "8080"))
    print(f"Alexa+ simulator · http://127.0.0.1:{port}")
    uvicorn.run("simulator.app:app", host="127.0.0.1", port=port, log_level="info")


if __name__ == "__main__":
    main()
