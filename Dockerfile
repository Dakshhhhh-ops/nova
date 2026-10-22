# Nova: story page, live demo and MCP server on one port (AWS App Runner, any container host)
FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.13.0 /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev
COPY nova_server ./nova_server
COPY simulator ./simulator
COPY samples ./samples
COPY serve.py ./
# NOVA_PUBLIC_URL must be the public https URL (OAuth metadata and allowed hosts use it)
ENV PORT=8080 PYTHONUNBUFFERED=1 PYTHONIOENCODING=utf-8 NOVA_LLM=auto
EXPOSE 8080
CMD ["uv", "run", "--no-sync", "python", "serve.py"]
# MCP server only: docker run -e NOVA_DEMO=0 -p 8765:8765 <image> uv run --no-sync python -m nova_server --host 0.0.0.0
