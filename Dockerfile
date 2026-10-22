# Nova MCP server (Streamable HTTP on :8765/mcp)
FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.13.0 /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev
COPY nova_server ./nova_server
ENV NOVA_MCP_HOST=0.0.0.0 NOVA_MCP_PORT=8765 PYTHONUNBUFFERED=1
EXPOSE 8765
CMD ["uv", "run", "--no-sync", "python", "-m", "nova_server"]
