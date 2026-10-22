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

---

# v2 additions: proactive care engine, vision, Ring, notifications

## Household clock (time-lapse)
The household has its own clock so a whole day can play out in a minute.
- MCP server: `GET /demo/clock` → `{now, speed}`; `POST /demo/clock` body `{time?: "HH:MM", speed?: number}` → `{now, speed}`. `speed` 1 = real time; 60 = one minute per second.
- Simulator proxies: `GET /api/clock`, `POST /api/clock` (same shapes). `/api/status` also has `household_now` and `clock_speed`.
- SSE `{type: "clock", now, speed}` every ~2 s and right after any change. The UI should tick its clocks locally between events using `speed`.

## Announcements (Nova speaks first)
The care engine on the MCP server creates announcements; the simulator polls the MCP resource `nova://announcements` for each device and pushes new ones over SSE.

`Announcement = { id, at, to, kind, severity, title, speech, expects_reply, replies: [str], status, related: {} }`
- `kind`: `dose_reminder` | `dose_followup` | `caregiver_escalation` | `checkin_prompt` | `appointment_reminder` | `wellness_check` | `care_plan_change` | `message` | `visitor` | `info`
- `severity`: `info` | `watch` | `urgent`
- SSE `{type: "announcement", device, item: Announcement}`
- UI behaviour: play a short chime, speak `speech`, show a large announcement card on that device's screen (title + speech), with the light bar in Alexa's style: **yellow pulsing** for caregiver notifications (`caregiver_escalation`, `visitor`, `message` to a caregiver), cyan for prompts to Rose, **red** for `urgent`. If `expects_reply`, show `replies` as big tappable chips; a tap sends that text as a normal utterance on the device (`POST /api/chat`) and acks the announcement.
- `POST /api/announcements/{id}/ack` body `{device, action: "acknowledged" | "dismissed"}`.
- `GET /api/announcements?device=maya` → `{items: [Announcement]}` newest first (for a notifications drawer; show an unread count badge on the device header).

## Vision (Amazon Nova multimodal)
- `GET /api/samples` → `{samples: [{id, kind: "pill"|"document", label, url}]}` (images served from `/samples/...`).
- `POST /api/vision` body `{device, kind: "pill"|"document", image: "data:image/png;base64,..."}` → same shape as `/api/chat` (`{reply, cards, trace, brain, latency_ms}`), with trace over SSE as usual.
- Rose's device: a "Show Alexa" camera action (webcam capture via `getUserMedia` when available, file upload, or one of the sample pill bottles) → `kind: "pill"` → tool `check_pill_photo` → card `ui://nova/pillcheck.html`.
- Maya's device: a "Scan paperwork" action (upload or the sample after-visit summary) → `kind: "document"` → tool `read_care_document` → card `ui://nova/reconcile.html`.

`check_pill_photo` structuredContent:
```json
{ "speech": "...", "verdict": "ok_now|wrong_time|already_taken|not_on_list|unclear",
  "identified": {"name": "Atorvastatin", "strength": "40 mg", "directions": "...", "label_text": "...", "confidence": 0.9},
  "matched_med": {"id": "atorvastatin", "name": "Atorvastatin", "dose": "40 mg", "purpose": "cholesterol", "appearance": "...", "times": ["9 PM"]} ,
  "due_now": [{"name": "Lisinopril", "appearance": "small pink oval pill", "time_label": "8 AM"}],
  "advice": "Put this one back. Your morning pills are ...", "generated_by": "..." }
```
`read_care_document` structuredContent:
```json
{ "speech": "...", "change_set_id": "cs_ab12", "status": "pending",
  "source": {"title": "After Visit Summary", "provider": "Dr. Anika Patel", "facility": "Ohio Heart Center", "date": "10/24/2026"},
  "changes": [{"op": "change|start|stop|continue", "name": "Lisinopril", "from": "20 mg once daily", "to": "10 mg once daily", "reason": "dizziness, low blood pressure"}],
  "instructions": ["Check blood pressure every morning and write it down", "..."],
  "generated_by": "..." }
```
`reconcile.html` buttons: **Approve changes** → `tools/call apply_care_changes {change_set_id, approve: true}`; **Discard** → `approve: false`. Result: `{speech, status: "applied"|"discarded", applied: [change], plan: [{name, dose, times, appearance}]}`; the view should then show the updated plan.

## Ring (simulated front door)
- `POST /api/ring/event` body `{kind: "ding"|"motion"|"door_open", who?: "grace"|"delivery"|"rose"|"unknown"}` → `{ok, signal}`. The simulator forwards to the MCP server webhook `POST /integrations/ring/events`.
- Timeline items gain `kind: "ring"`.
- UI: a compact **Ring Video Doorbell · Front door (Columbus)** panel (third, smaller device under/next to Rose's) with an illustrated porch "live view", the last event, and buttons: "Grace arrives", "Package delivered", "Rose heads out for a walk", "Motion". 

## New tools (agent-visible)
- `read_notifications()` → `{speech, items: [Announcement]}` ("Alexa, what are my notifications?")
- `snooze_reminder(minutes=10)` → `{speech, at}`
- `recent_activity(hours=24)` → `{speech, items}` (caregivers: "When did Mom last open the door?")
- `check_pill_photo`, `read_care_document`, `apply_care_changes` (see above)
