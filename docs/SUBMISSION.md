# Devpost submission: Nova

Copy each section into the matching Devpost field.

## Tracks
- Primary track: **Alexa+** (self-hosted MCP server over Streamable HTTP, plus a simulated Alexa+ experience in a web app)
- Mini challenge: **AWS Builder** (Amazon Bedrock with Amazon Nova models, including multimodal; Amazon Polly)
- Mini challenge: **Open Source** (see below; enter only once the repo is public)

## Project description

**Nova turns Alexa+ into a proactive, multimodal care circle** for an older adult who lives alone and the family who worry about them.

Rose, 81, lives alone in Columbus. Her daughter Maya is in Seattle. Nova sits between them on Alexa+:

- **It speaks first.** A care engine runs on the household clock. At 6 PM Rose's Echo says *"Time for your Metformin with your meal. That's the large white oblong pill."* At 6:30 it checks in gently. At 7:30, if she still hasn't taken it, Maya's Echo glows yellow: *"Mom hasn't taken her 6 PM Metformin. I reminded her at 6 and 6:30."* It also prompts the morning check-in, reminds about appointments (*"Leo is driving you"*), and runs a wellness check when the home has been quiet all morning, escalating to the family if Rose doesn't answer.
- **It sees, with Amazon Nova multimodal.** Rose holds a pill bottle up to the Echo Show camera: *"That's atorvastatin, your bedtime pill. Put it back. Right now it's time for your lisinopril, the small pink one."* Maya photographs the after-visit summary. Nova reconciles it with the current plan (lisinopril 20 → 10 mg, with the doctor's reason) and waits for her approval. Then it tells Rose in plain words, and later catches the old 20 mg bottle.
- **It connects the dots, with evidence.** *"How's Mom doing?"* gets a spoken briefing and an on-screen card: *dizziness began two days after her lisinopril dose was doubled; home BP averaged 152/91 before and 108/66 since; the home aide saw her unsteady; Dr. Patel's notes say to call about dizziness (614-555-0190).*
- **It listens to the front door (Ring, simulated).** *"Grace arrived at Mom's at 10:02."* A front door opening at 2 AM triggers an urgent notification; a morning with no movement triggers a wellness check.
- **It stays safe and respectful.** It has a double-dose guard. Answers about medications come only from the doctor's notes, with sources. Nothing changes in the plan without a person's approval. Rose is asked before her family hears about a symptom (MCP elicitation), and she controls what they can see. Emergencies skip all of that and alert everyone.

**How it works.** Nova is a self-hosted MCP server (official Python SDK 2.3, Streamable HTTP, MCP 2026-07-28 with 2025-11-25 compatibility), the open standard Alexa+ uses for integrations. It has 21 tools, 8 resources (including `nova://announcements`, the queue Nova uses to speak first), 2 prompts and 5 MCP Apps views that render on the Echo Show screens. Each Echo connects with a bearer token for one person, so the same tool answers differently for Rose and for Maya. A simulated Alexa+ (two Echo Shows and a Ring doorbell in the browser) runs an agent on Amazon Nova through the Bedrock Converse API, delivers Nova's announcements live, and speaks with Amazon Polly. A time-lapse clock plays a whole day in a minute. Deterministic rules find the patterns (so every insight is testable and cites evidence); Amazon Nova reads the images and writes the language. 29 tests and CI.

**Built with:** Python, MCP Python SDK 2.3 (MCPServer, Streamable HTTP, MCP Apps extension, resolvers/elicitation, OAuth protected-resource metadata), Amazon Bedrock (Converse API, tool use, image input) with Amazon Nova 2 Lite, Amazon Polly (generative voice), FastAPI, SQLite, vanilla JS (Web Speech API, getUserMedia, WebAudio), Docker.

## AWS Builder: integrations
- `simulator/agent.py`: the Alexa+ agent's tool-use loop on the **Amazon Bedrock Converse API** with **Amazon Nova** (`*.amazon.nova-2-lite-v1:0`, region-aware inference profile selection with fallbacks to Nova Lite and Micro).
- `nova_server/vision.py` + `nova_server/llm.py` (`vision_json`): **Amazon Nova multimodal** reads pill-bottle labels and after-visit summaries (Converse image blocks); the medication reconciliation that follows is deterministic.
- `nova_server/insights.py`: **Amazon Nova** writes the spoken caregiver briefing, extracts structured check-ins (mood, pain, sleep, symptoms) from free speech, answers questions grounded only in care notes, and drafts doctor-visit briefs.
- `simulator/app.py`: **Amazon Polly** generative voice (`Ruth`) for replies and proactive announcements.
- `tests/test_bedrock_shape.py`: Converse requests (tool use and plain) are validated against the botocore API model.

## Open Source: required fields
- **Contribution URL:** https://github.com/Dakshhhhh-ops/mcp-apps-lite-host *(create this public repo and push the local folder before submitting)*
- **Primary repo URL:** https://github.com/Dakshhhhh-ops/nova
- **GitHub username:** Dakshhhhh-ops
- **What it is:** `mcp-apps-lite-host` is a dependency-free ES module (MIT) that renders MCP Apps (`ui://`) views in any web page. It implements the View ↔ Host JSON-RPC protocol from the ext-apps spec (initialize handshake, tool-input/tool-result, size-changed, `tools/call` proxy, `ui/message`, teardown) in a sandboxed iframe.
- **Why it matters:** The ext-apps repo ships view SDKs and a basic example host, but there was no small drop-in host for custom web apps, simulators or dashboards. Anyone building an Alexa+ simulation, an MCP inspector or a product UI can now show MCP Apps views in a few lines. It was extracted from Nova's Echo Show simulator.

## Product feedback

**MCP (spec + Python SDK 2.3).** Used for the whole Alexa+ integration: MCPServer, Streamable HTTP, structured output, tool annotations, icons, resources, prompts, the MCP Apps extension, elicitation through resolvers, and the bearer-token resource server with RFC 9728 metadata.
- *Worked well:* The protocol does a lot out of the box: structured output from type hints, Protected Resource Metadata from one `AuthSettings`, and an in-process `Client(server)` that made tests trivial. The migration error for `mcp.server.fastmcp` points straight to the guide.
- *Needs work:* Two silent or surprising behaviors cost real time (see friction log): Apps tools registered after the server is built simply don't appear, and `ctx.elicit()` fails on 2026-07-28 connections with an error that doesn't mention resolvers.
- *Would build with it again:* Yes.

**MCP Apps (`io.modelcontextprotocol/ui`).** Used for visual responses on the simulated Echo Show screens.
- *Worked well:* A clean model. `_meta.ui.resourceUri` plus a `ui://` resource, with JSON-RPC over postMessage. Views calling tools back through the host made the cards interactive with very little code.
- *Needs work:* There's no small reference host to copy, so we wrote the host side (handshake, tool-input/tool-result, size-changed, tools/call proxy) from the spec. Guidance on how Alexa+ / Echo Show will render these views (sizes, theme variables, voice + screen pairing) would help builders design for it now.

**Alexa+ (simulated).** We used the simulated path because we don't have Alexa+ Preview access.
- *Worked well:* Choosing MCP as the integration standard means the same server works with Alexa+, Kiro, Claude and the MCP Inspector.
- *Needs work:* There's no way for non-Preview developers to point a real (or sandboxed) Alexa+ at a self-hosted MCP URL, or to test account linking end to end. We had to guess how Alexa+ handles elicitation, `speech`-style results and visual responses.
- *Onboarding:* The Resources page was clear about the two paths (MCP server or simulated). An official Alexa+ MCP test console would change everything.

**Amazon Bedrock + Amazon Nova.** Used for the agent loop (Converse tool use) and for narration, extraction, grounded Q&A and visit briefs.
- *Worked well:* The Converse API's tool-use shape maps one-to-one onto MCP tools (`inputSchema.json` = MCP `inputSchema`). Nova Lite-class models are fast enough for voice turns.
- *Needs work:* Picking the right model identifier per region (`us.` / `eu.` / `apac.` / `global.` inference profiles, Nova vs Nova 2) needed a probe-and-fallback loop in code.
- *Would build with it again:* Yes.

**Amazon Polly.** Used for spoken replies. Generative voices sound natural for an older listener. We added a browser speech fallback for when Polly isn't configured.

## Friction log

| # | Task | Steps | Expected | Actual | Severity | Workaround | Suggestion |
|---|---|---|---|---|---|---|---|
| 1 | Bind tools to MCP Apps views (Python SDK 2.3) | Created `apps = Apps()`, passed it to `MCPServer(extensions=[apps])`, then decorated tools with `@apps.tool(resource_uri=...)` further down the module | Tools appear in `tools/list` | The three UI tools were silently missing; no warning | Medium | Register with `mcp.tool(meta={"ui": {"resourceUri": ...}})` | Warn or raise when an `Apps` instance gains tools after it was applied, or resolve its tools lazily |
| 2 | Ask the user for consent mid-tool (elicitation) | Called `await ctx.elicit(...)` inside a tool on a Streamable HTTP connection that negotiated 2026-07-28 | The client is asked | `Cannot send 'elicitation/create': this transport context has no back-channel for server-initiated requests` | High | Rewrote it as a `Resolve(...)` resolver returning `Elicit(...)`, which the SDK turns into an `InputRequiredResult` round trip | Mention resolvers in that error message, and show the resolver pattern first in the elicitation docs |
| 3 | Test an MCP server against Alexa+ | Looked for a way to connect a self-hosted MCP URL to Alexa+ without Preview access | A sandbox or test console | None, so we built a simulator | High | Simulated Alexa+ in a web app | An Alexa+ MCP test console with account-linking sandbox for hackathon participants |
| 4 | Choose an Amazon Nova model ID for Bedrock Converse | Started from a regional default profile | One stable identifier per model | IDs differ by geography prefix and generation; the right one depends on the region and what is enabled | Low | Probe a candidate list at startup and fall back | An API or SDK helper that resolves "best inference profile for model X in region Y" |
| 5 | Run the simulator without AWS | Machine's local AWS credentials were invalid (`InvalidClientTokenId`) | A clear path to keep building | Every Bedrock and Polly call failed | Medium | Built fallbacks: local Ollama model, then a rules router; browser speech instead of Polly | A free, rate-limited Bedrock sandbox key for hackathons (the AWS credit codes ran out on Oct 7) |

## Feature requests
1. **Alexa+ MCP test console** for non-Preview developers: point Alexa+ at a public MCP URL, sandboxed account linking, see the tool calls. *Critical.*
2. **Echo Show rendering of MCP Apps views**, with published sizes, theme variables and a voice + screen pairing guide. *Important.*
3. **Alexa+ guidance on spoken results**: a convention like a `speech` field so servers can supply a TTS-ready line next to structured data. *Important.*
4. **Proactive notifications from MCP servers to Alexa+** (e.g. "Mom asked me to tell you she's dizzy"), with the user's consent. *Important.*

## If your project existed before the hackathon
It didn't. Nova was built during the submission window.
