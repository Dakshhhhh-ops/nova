# Nova internal contract

How the three parts talk to each other. Keep this file in sync with the code.

```
 Browser (simulator/static)  ──HTTP/SSE──▶  Alexa+ simulator (simulator/app.py, :8080)
                                              │  agent loop: Amazon Nova on Bedrock (tool use)
                                              │  MCP client, one session per device, bearer token per person
                                              ▼
                                 Nova MCP server (nova_server, :8765/mcp, Streamable HTTP)
```

## Devices in the simulator

| device id | person | role | token |
|---|---|---|---|
| `kitchen` | Rose Alvarez (81, Columbus OH) | elder | `nova-demo-rose` |
| `maya` | Maya Alvarez-Chen (daughter, Seattle) | caregiver | `nova-demo-maya` |

## Simulator HTTP API (`simulator/app.py`)

- `GET /api/status` → `{ brain: {name, label}, mcp: {url, connected, server_name, protocol_version, tools: [names]}, devices: [Device] }`
  - `Device = { id, label, person: {id, name, short_name, role, location, device}, suggestions: [str] }`
- `POST /api/chat` body `{device, text}` → `{ reply, cards: [Card], trace: [TraceItem], brain, latency_ms }`
  - `Card = { tool, resource_uri, html, input, result }` where `result` is the MCP `CallToolResult` as JSON (`{content, structuredContent, isError}`) and `html` is the `ui://` resource text.
- `GET /api/events` (Server-Sent Events, `data:` is JSON) events:
  - `{type: "trace", device, item: TraceItem}`
  - `{type: "elicit", device, id, message, schema}` (server asked the user something mid-tool, e.g. consent)
  - `{type: "elicit_done", id}`
  - `{type: "circle", item: TimelineItem}` (something changed in the care circle; refresh the feed)
  - `{type: "reset"}`
- `POST /api/elicit/{id}` body `{action: "accept"|"decline"|"cancel", content: {...}}`
- `POST /api/app-call` body `{device, name, arguments}` → MCP `CallToolResult` JSON (used by MCP App views calling tools through the host)
- `GET /api/timeline` → `{ items: [TimelineItem] }` newest first.
  - `TimelineItem = { at, kind: "dose"|"checkin"|"message"|"alert", who, text, severity? }`
- `POST /api/reset` → re-seed the demo household.
- `POST /api/tts` body `{text, device}` → `audio/mpeg` (Amazon Polly) or `204` when Polly is unavailable (browser should fall back to `speechSynthesis`).

`TraceItem = { kind, at, ... }` kinds:
- `user` `{text}`
- `llm` `{brain, latency_ms, text, tool_calls: [{name, args}]}`
- `tool_call` `{name, args}`
- `tool_result` `{name, ok, speech, structured, ui: resource_uri|null, ms}`
- `elicit` `{message}` / `elicit_answer` `{action, content}`
- `reply` `{text}`
- `error` `{message}`

## MCP tools and structured output

Every tool returns a JSON object (MCP `structuredContent`) with a `speech` string: one or two sentences written to be spoken aloud. Screens use the rest.

UI-bound tools (MCP Apps, `_meta.ui.resourceUri`):

| tool | resource |
|---|---|
| `get_today` | `ui://nova/today.html` |
| `care_briefing` | `ui://nova/briefing.html` |
| `prepare_visit` | `ui://nova/visit.html` |

### `get_today` → 
```json
{
  "speech": "...",
  "person": {"id": "rose", "name": "Rose Alvarez", "short_name": "Rose"},
  "date_label": "Thursday, October 22",
  "doses": [{"med_id": "lisinopril", "name": "Lisinopril", "dose": "20 mg", "purpose": "blood pressure",
             "appearance": "small pink oval pill", "time_label": "8 AM", "scheduled_for": "ISO",
             "status": "taken|skipped|missed|due|upcoming", "logged_at": "ISO|null", "logged_by": "rose|grace|null"}],
  "appointments": [{"title": "...", "provider": "...", "when_label": "Tomorrow at 10 AM", "at": "ISO", "location": "..."}],
  "unread_messages": 1,
  "next_dose": {"name": "...", "time_label": "6 PM"}
}
```

### `care_briefing` →
```json
{
  "speech": "...",
  "person": {"id": "rose", "name": "Rose Alvarez", "short_name": "Rose"},
  "period": "today|week",
  "status": "steady|watch|urgent",
  "headline": "One short sentence",
  "generated_by": "Amazon Nova 2 Lite · Amazon Bedrock | rules",
  "adherence": {"pct": 86, "taken": 48, "scheduled": 56, "morning_pct": 100, "evening_pct": 62,
                "by_med": [{"name": "Metformin", "pct": 75, "missed": 4}]},
  "wellbeing": {"days": [{"date": "Oct 12", "mood": 4, "pain": 2, "sleep": 7.5, "symptoms": ["..."]}],
                "trend": "declining|steady|improving"},
  "insights": [{"id": "...", "severity": "info|watch|urgent", "title": "...", "detail": "...",
                "evidence": ["Oct 15 · \"Felt woozy getting out of bed\""], "suggestion": "..."}],
  "upcoming": [{"title": "...", "when_label": "...", "provider": "..."}],
  "alerts": [{"id": 1, "severity": "watch", "kind": "...", "message": "...", "at": "ISO"}],
  "messages": [{"from": "Grace", "text": "...", "when_label": "Monday 3 PM"}]
}
```

### `prepare_visit` →
```json
{
  "speech": "...",
  "appointment": {"title": "...", "provider": "...", "when_label": "...", "location": "..."},
  "summary": "Two or three sentences for the doctor.",
  "medications": [{"name": "Lisinopril", "dose": "20 mg", "adherence_pct": 100, "note": "Increased from 10 mg on Oct 13"}],
  "symptoms": [{"name": "dizzy when standing", "count": 4, "first_label": "Oct 15", "note": "..."}],
  "questions": ["..."],
  "bring": ["..."],
  "generated_by": "..."
}
```

### Other tools (text + structured, no UI)
- `log_medication(medication="", time_of_day="", status="taken")` → `{speech, logged: [dose], already_taken: [dose], warning}`
- `check_medication(medication="", time_of_day="")` → `{speech, doses: [dose], info}`
- `daily_checkin(how_are_you_feeling)` → `{speech, checkin: {...}, red_flags: [], shared_with: [names], alert_id}`
- `send_message(to, message, urgent=false)` → `{speech, delivered_to: [names]}`
- `read_messages()` → `{speech, messages: [{from, text, when_label}]}`
- `ask_care_notes(question)` → `{speech, answer, sources: [source]}`
- `get_help(reason)` → `{speech, alerted: [names], alert_id}`
- `list_alerts()` / `resolve_alert(alert_id, note="")`
- `set_sharing(category, shared)` (elder only)

## MCP Apps views (`nova_server/views/*.html`)

Self-contained HTML (inline CSS/JS, no external requests). Protocol per ext-apps spec 2026-01-26:
1. View posts `{jsonrpc:"2.0", id, method:"ui/initialize", params:{appCapabilities:{availableDisplayModes:["inline"]}, clientInfo:{name, version}, protocolVersion:"2026-01-26"}}` to `window.parent`.
2. Host replies with `{protocolVersion, hostCapabilities, hostInfo, hostContext:{theme, displayMode, platform, ...}}`.
3. View posts notification `ui/notifications/initialized`.
4. Host posts `ui/notifications/tool-input` `{arguments}` then `ui/notifications/tool-result` (params = CallToolResult: `{content, structuredContent}`).
5. View may post requests `tools/call` `{name, arguments}`; host proxies to the MCP server and replies with the CallToolResult.
6. View posts `ui/notifications/size-changed` `{width, height}` when its height changes.
