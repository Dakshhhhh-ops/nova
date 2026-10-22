# Nova architecture

Nova is two processes and a browser:

| Process | What it is | Talks to |
|---|---|---|
| `nova_server` (port 8765) | The Alexa+ integration: an MCP server (Streamable HTTP at `/mcp`), its OAuth 2.1 authorization server, the care engine thread, vision, and the Ring webhook. SQLite holds the household. | Amazon Bedrock (Amazon Nova) for language and vision |
| `simulator` (port 8080) | A stand-in for Alexa+: one MCP client session per Echo (each with that person's token), the Amazon Nova tool-use agent, the MCP Apps host, the announcement poller, and Amazon Polly voice. | `nova_server` over MCP; Bedrock; Polly; the browser over HTTP + SSE |
| Browser | The story page (`/`) and the live demo (`/live`): Echo Shows, the Ring doorbell, the 3D stage, and the protocol inspector. | `simulator` |

Everything Alexa+ would do is behind the MCP boundary. A real Alexa+ deployment replaces the simulator: Alexa+ links the account (OAuth), calls the same tools, renders the same `ui://` views, and receives announcements as proactive notifications.

## 1. A voice turn
```mermaid
sequenceDiagram
  autonumber
  participant R as Rose (Echo Show 8)
  participant A as Alexa+ agent<br/>(Amazon Nova, Converse)
  participant N as Nova MCP server
  participant DB as SQLite
  R->>A: "I just took my pink pill"
  A->>A: choose a tool (model-visible tools only)
  A->>N: tools/call log_medication {medication: "pink"}<br/>Authorization: Bearer (Rose)
  N->>DB: today's doses for Rose; match "pink" to the small pink oval pill
  DB-->>N: Lisinopril 8 AM already taken at 8:14
  N-->>A: structuredContent {speech: "You already took Lisinopril at 8:14 AM, so please don't take another one.", warning: "double_dose_risk"}
  A->>R: speak (Polly) + screen
```
Every tool returns a `speech` line written for TTS, plus structured data for screens. The agent sees a compact version of large results (`for_model`). A voice guard falls back to `speech` if the model replies with markdown or an essay.

## 2. Nova speaks first: the escalation ladder
```mermaid
sequenceDiagram
  autonumber
  participant E as Care engine<br/>(household clock)
  participant DB as SQLite
  participant P as Announcement poller<br/>(simulator)
  participant R as Rose's Echo
  participant M as Maya's Echo
  E->>DB: 6:00 PM, Metformin pending → announce(dose_reminder, dedupe "dose_reminder:date:1800")
  P->>DB: resources/read nova://announcements (as Rose) → delivered once
  P-->>R: "It's 6 PM, Rose. Time for your Metformin…" [I took it] [Remind me in 10 minutes]
  E->>DB: 6:30 PM, still pending → dose_followup (skipped if she snoozed)
  E->>DB: 7:30 PM, still pending → caregiver_escalation to Maya + open alert
  P-->>M: amber ring: "Mom hasn't taken her 6 PM Metformin. I reminded her at 6 and 6:30."
  M->>P: [Remind Mom again] → send_message → a live announcement on Rose's Echo
```
Triggers fire when the household clock crosses them, are idempotent (unique dedupe keys), and a big jump of the clock skips past them instead of replaying the day. The same engine sends the 9 AM check-in, the 11 AM quiet-home wellness check (escalating to the family at 11:30), appointment reminders, the morning BP prompt after the visit, refill nudges and "refill ready", and the Sunday family digest.

## 3. Consent before sharing (MCP elicitation)
```mermaid
sequenceDiagram
  autonumber
  participant R as Rose
  participant A as Alexa+ agent
  participant N as Nova (daily_checkin)
  A->>N: tools/call daily_checkin {"I'm a bit dizzy this morning"}
  Note over N: resolver ask_before_sharing runs first<br/>(deterministic: concerning symptom? sharing on?)
  alt protocol 2026-07-28
    N-->>A: InputRequiredResult {elicitation: "Would you like me to let Maya and Leo know you're feeling dizzy?"}
    A->>R: ask (screen + voice)
    R-->>A: Yes
    A->>N: retry tools/call with input_responses + request_state
  else protocol 2025-11-25 (Alexa+ today)
    N->>A: elicitation/create (server → client request)
    A->>R: ask
    R-->>A: Yes
    A-->>N: ElicitResult accept {notify: true}
  end
  N-->>A: "I've let Maya and Leo know. Please stand up slowly. Dr. Patel asked to hear about dizziness…"
```
The consent parameter is injected by the SDK (`Resolve(...)`) and never appears in the model-visible input schema. Red flags (a fall, chest pain) skip the question and alert everyone.

## 4. A photo becomes a plan change (Amazon Nova multimodal)
```mermaid
sequenceDiagram
  autonumber
  participant M as Maya's Echo (camera)
  participant S as Simulator (MCP Apps host)
  participant N as Nova MCP server
  participant B as Amazon Bedrock<br/>Amazon Nova (image)
  M->>S: photo of the after-visit summary
  S->>N: tools/call read_care_document {image} (app-only tool)
  N->>B: Converse [image + "extract the medication plan as JSON"]
  B-->>N: {medications: [{Lisinopril, 10 mg, change, was 20 mg, reason}], instructions: [...]}
  N->>N: deterministic reconciliation against the current plan → change / start / stop / continue
  N-->>S: change set cs_… + ui://nova/reconcile.html
  S-->>M: before/after card [Approve] [Discard]
  M->>S: Approve (tools/call from the view, proxied by the host)
  S->>N: apply_care_changes {change_set_id, approve: true}
  N->>N: update plan, save instructions as a care note, announce to Rose in plain words
```
Pill bottles go through the same path (`check_pill_photo`): on her list? due now? already taken? an outdated strength? something the doctor said to avoid? Without AWS, the bundled sample photos resolve from fixtures and other photos go to a local vision model.

## 5. Account linking (OAuth 2.1)
```mermaid
sequenceDiagram
  autonumber
  participant C as MCP client (Alexa+, Inspector, Claude)
  participant N as Nova (resource + authorization server)
  participant U as Person (browser)
  C->>N: POST /mcp (no token) → 401 + WWW-Authenticate
  C->>N: GET /.well-known/oauth-protected-resource/mcp → authorization server
  C->>N: GET /.well-known/oauth-authorization-server
  C->>N: POST /register (RFC 7591) → client_id
  C->>U: open /authorize?…&code_challenge (PKCE S256)
  U->>N: /link: "Who are you in Rose's care circle?" → Maya
  N-->>C: redirect with code + state
  C->>N: POST /token (code + code_verifier) → access + refresh token (subject = maya)
  C->>N: POST /mcp, Bearer token → tools now answer as Maya
```
In production the `/link` step is Login with Amazon or Amazon Cognito. Codes are single use, refresh tokens rotate, and tokens can be revoked. The demo tokens (`nova-demo-rose`, …) still work for the simulator.

## 6. The front door (Ring Partner API: pull and push)
```mermaid
sequenceDiagram
  autonumber
  participant R as Ring (Partner API)
  participant N as Nova /integrations/ring/webhook
  participant E as Care engine
  participant G as Grace (aide)
  participant M as Maya's Echo Show
  R->>N: POST Webhook v1.1 {meta.request_id, data.type: "button_press", attributes.timestamp}<br/>X-Signature: sha256=HMAC(raw body)
  N->>N: verify HMAC before parsing (401 if wrong: Ring won't retry a 4xx)
  N->>N: seen this request_id? → 200 {duplicate}
  N->>E: ding at 9:58 — who? Ring doesn't say → calendar: Grace's visit at 10:00
  E-->>G: "For today's visit: she hasn't logged her 8 AM pills; check her BP sitting and standing; Metformin is running low."
  E-->>M: "Grace arrived at Mom's at 9:58."
  N-->>R: 200 (well within Ring's 5 s)
```
**Pull, too.** `nova_server/ring_api.py` calls the Ring Partner API every 5 minutes, when a caregiver asks about recent activity, and on "Sync from Ring": `GET /v1/users/me` → `GET /v1/devices` → `GET /v1/devices/{id}/status` → `GET /v1/history/devices/{id}/events?event_types=ding,motion.human` (following `links.next`). New events become the same signals as webhooks. Fresh ones (under 10 minutes) are announced; older ones go on the timeline quietly. Ring's event ids are stored, so nothing is imported twice. A `503` from the status endpoint means the device is offline, which is a care signal too.

`motion_detected` (with `attributes.sub_type`, e.g. `human`) feeds the "quiet home" wellness check; `device_offline` lands on the timeline. The simulator signs its events with the same HMAC, so the demo exercises the real verification path. A night-time `door_open` comes from a contact sensor, not Ring, and uses the simple shared-secret endpoint (`/integrations/ring/events`).

## Design choices
- **Deterministic signals, model language.** Patterns (a symptom after a dose change, evening doses slipping, a quiet home) come from rules that are testable and cite evidence. Amazon Nova writes the spoken briefing, extracts check-ins, answers from the notes and reads images. Every model call has a template or fixture fallback.
- **Identity from the token, never from speech.** The same tool answers differently for Rose and Maya; only Rose can change what's shared.
- **Voice first, screen second.** `speech` for the ear (one or two sentences, then "Want the details?" with the rest in `more`), `structuredContent` + `ui://` views for the Echo Show. When a tool returns `speech`, the agent speaks it without a second model call: one Converse round trip per turn instead of two.
- **Fail fast, degrade gracefully.** A throttled Bedrock call falls back for that turn; a dropped MCP connection reconnects and retries; without WebGL the demo renders in 2D.
