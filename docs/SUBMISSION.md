# Devpost submission: Nova

Copy each section into the matching Devpost field.

## Tracks
- Primary track: **Alexa+** (self-hosted MCP server over Streamable HTTP, plus a simulated Alexa+ experience in a web app)
- Mini challenge: **AWS Builder** (Amazon Bedrock with Amazon Nova models, Amazon Polly)
- Mini challenge: **Open Source** (see below; enter only once the repo is public)

## Project description

**Nova is a care circle for Alexa+.** It lets an older adult who lives alone and the family who worry about them share one voice-first care circle.

Rose, 81, talks to the Echo Show in her kitchen: "I just took my pink pill", "I'm feeling a bit dizzy this morning and my knee hurts", "Can I take ibuprofen for my knee?". Her daughter Maya, in Seattle, asks her own Echo "How's Mom doing?" and hears what matters, with the evidence on screen and a next step.

**How it works.** Nova is a self-hosted MCP server (official Python SDK, Streamable HTTP, MCP 2026-07-28 with 2025-11-25 compatibility), the open standard Alexa+ uses for integrations. Each Echo connects with a bearer token for one person, so the same tool answers differently for Rose and for Maya, and Rose controls what her family can see. A simulated Alexa+ (two Echo Show devices in the browser) runs an agent on Amazon Nova through the Amazon Bedrock Converse API. The agent calls Nova's 13 MCP tools and speaks the answers with Amazon Polly.

**What makes it different**
- **Connects the dots, with evidence.** Deterministic pattern rules find what no single data point shows. For example: *dizziness began two days after her lisinopril dose was doubled, mentioned four times, corroborated by the home aide's BP reading; Dr. Patel's notes say to call about dizziness (614-555-0190).* Amazon Nova turns the findings into a warm, 20-second spoken briefing.
- **Safe by design.** A double-dose guard ("you already took it at 8:14, please don't take another"). Answers about medications come only from the doctors' own notes, with sources. No diagnosis. Emergencies alert everyone immediately.
- **Dignity and consent.** Before telling the family about a symptom, Nova asks Rose (MCP elicitation). She can make any category private, and only she can change that.
- **Visual responses on Echo Show.** Today's plan, the care briefing and the doctor-visit brief are MCP Apps (`ui://` views) that render on the device and can call tools back ("Mark taken", "Mark handled", "Share with circle").
- **Doctor-visit prep.** A one-page brief with adherence, symptoms with first-seen dates, and the questions to ask.

**Built with:** Python, MCP Python SDK 2.3 (MCPServer, Streamable HTTP, MCP Apps extension, resolvers/elicitation, OAuth protected-resource metadata), Amazon Bedrock (Converse API, tool use) with Amazon Nova 2 Lite, Amazon Polly (generative voice), FastAPI, SQLite, vanilla JS (Web Speech API).

## AWS Builder: integrations
- `simulator/agent.py`: the Alexa+ agent's tool-use loop on the **Amazon Bedrock Converse API** with **Amazon Nova** (`*.amazon.nova-2-lite-v1:0`, region-aware inference profile selection with fallbacks to Nova Lite and Micro).
- `nova_server/insights.py`: **Amazon Nova** writes the spoken caregiver briefing, extracts structured check-ins (mood, pain, sleep, symptoms) from free speech, answers questions grounded only in care notes, and drafts doctor-visit briefs.
- `simulator/app.py`: **Amazon Polly** generative voice (`Ruth`) for spoken replies.
- `nova_server/llm.py`: one model layer for all of the above.

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
