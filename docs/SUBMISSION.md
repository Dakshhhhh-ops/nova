# Devpost submission: Nova

Copy each section into the matching Devpost field.

## Links
- Live: https://nova-6kte.onrender.com (story page) · https://nova-6kte.onrender.com/live (live demo) · MCP endpoint https://nova-6kte.onrender.com/mcp
- Code: https://github.com/Dakshhhhh-ops/nova

## Tracks
- Track: **Alexa+** (self-hosted MCP server over Streamable HTTP, plus a simulated Alexa+ experience in a web app)
- Track: **Ring** (Nova calls the Ring Partner API at runtime: `users/me`, `devices`, device `status`, and event `history` for doorbell presses and people at the door; plus signed Webhook v1.1 events). *If Devpost allows only one track, choose Alexa+; Ring is part of the same project either way.*
- Mini challenge: **AWS Builder** (Amazon Bedrock with Amazon Nova models, including multimodal; Amazon Polly)
- Mini challenge: **Open Source** (`mcp-apps-lite-host`, see below)

## Project description

**Nova catches medication mistakes before they happen, and connects the dots**, like a dose change and new dizziness, for an older adult who lives alone and the family who worry about her. It links the living room (Rose's Echo Show), the front door (her Ring doorbell) and the cloud (Maya's Echo Show in Seattle, and Nova on AWS) into one care circle on Alexa+.

Rose, 81, lives alone in Columbus. Her daughter Maya is in Seattle. Nova sits between them on Alexa+:

- **It speaks first.** A care engine runs on the household clock. At 6 PM Rose's Echo says *"Time for your Metformin with your meal. That's the large white oblong pill."* At 6:30 it checks in gently. At 7:30, if she still hasn't taken it, Maya's Echo glows yellow: *"Mom hasn't taken her 6 PM Metformin. I reminded her at 6 and 6:30."* It also prompts the morning check-in, reminds about appointments (*"Leo is driving you"*), and runs a wellness check when the home has been quiet all morning, escalating to the family if Rose doesn't answer.
- **It sees, with Amazon Nova multimodal.** Rose holds a pill bottle up to the Echo Show camera: *"That's atorvastatin, your bedtime pill. Put it back. Right now it's time for your lisinopril, the small pink one."* When her knee hurts and she reaches for ibuprofen, Nova stops her, quoting her doctor's instructions and the safe alternative. Maya photographs the after-visit summary. Nova reconciles it with the current plan (lisinopril 20 → 10 mg, with the doctor's reason) and waits for her approval. Then it tells Rose in plain words, and later catches the old 20 mg bottle.
- **It connects the dots, with evidence.** *"How's Mom doing?"* gets a spoken briefing and an on-screen card: *dizziness began two days after her lisinopril dose was doubled; home BP averaged 152/91 before and 110/66 since; the home aide saw her unsteady; Dr. Patel's notes say to call about dizziness (614-555-0190).*
- **It listens to the front door (Ring Partner API).** Nova calls Ring's API for the linked account's devices, whether the doorbell is online, and the event history (doorbell presses and people at the door, nothing else), and takes Ring's signed webhooks for real time. Ring doesn't say who rang, so Nova checks the care calendar: *"Grace arrived at Mom's at 10:02,"* and Grace gets her visit checklist. A camera going offline is a care signal too. A front door opening at 2 AM triggers an urgent notification; a morning with no movement triggers a wellness check.
- **It stays safe and respectful.** It has a double-dose guard. Answers about medications come only from the doctor's notes, with sources. Nothing changes in the plan without a person's approval. Rose is asked before her family hears about a symptom (MCP elicitation), and she controls what they can see. Emergencies skip all of that and alert everyone.

**Who would ship it.** Home-care agencies (Grace's employer), Medicare Advantage and Part D plans (scored on medication adherence for diabetes drugs, RAS antagonists like lisinopril and statins: Rose's exact three prescriptions), pharmacies (refills and post-visit reconciliation), and families directly through Alexa+ account linking.

**Running it for real.** Nova handles health data, so a real deployment runs in the care organization's own AWS account under a Business Associate Addendum, using HIPAA-eligible services only (Amazon Bedrock, Amazon Polly, Amazon ECS/RDS), with TLS everywhere and KMS-encrypted storage. "Minimum necessary" is already in the design: identity from the token, sharing controlled by Rose, consent before symptoms are shared, approval before plan changes, and an audit trail of who logged or handled what. Details are in the README.

**How it works.** Nova is a self-hosted MCP server (official Python SDK 2.3, Streamable HTTP, MCP 2026-07-28 with 2025-11-25 compatibility), the open standard Alexa+ uses for integrations. It has 25 tools, 8 resources (including `nova://announcements`, the queue Nova uses to speak first), 2 prompts and 5 MCP Apps views that render on the Echo Show screens. Each Echo connects with a bearer token for one person, so the same tool answers differently for Rose and for Maya. A simulated Alexa+ (two Echo Shows and a Ring doorbell in the browser) runs an agent on Amazon Nova through the Bedrock Converse API, delivers Nova's announcements live, and speaks with Amazon Polly. A time-lapse clock plays a whole day in a minute. Deterministic rules find the patterns (so every insight is testable and cites evidence); Amazon Nova reads the images and writes the language. Account linking uses standard OAuth 2.1 (dynamic client registration, PKCE), so any MCP client can link a person's account. 68 tests and CI.

**Built with:** Python, MCP Python SDK 2.3 (MCPServer, Streamable HTTP, MCP Apps extension, resolvers/elicitation, OAuth 2.1 authorization server with dynamic registration and PKCE), Amazon Bedrock (Converse API, tool use, image input) with Amazon Nova 2 Lite, Amazon Polly (generative voice), FastAPI, SQLite, vanilla JS (Web Speech API, getUserMedia, WebAudio), Docker.

## AWS Builder: integrations
- `simulator/agent.py`: the Alexa+ agent's tool-use loop on the **Amazon Bedrock Converse API** with **Amazon Nova** (`*.amazon.nova-2-lite-v1:0`, region-aware inference profile selection with fallbacks to Nova Lite and Micro).
- `nova_server/vision.py` + `nova_server/llm.py` (`vision_json`): **Amazon Nova multimodal** reads pill-bottle labels and after-visit summaries (Converse image blocks); the medication reconciliation that follows is deterministic.
- `nova_server/insights.py`: **Amazon Nova** writes the spoken caregiver briefing, extracts structured check-ins (mood, pain, sleep, symptoms) from free speech, answers questions grounded only in care notes, and drafts doctor-visit briefs.
- `simulator/app.py`: **Amazon Polly** generative voice (`Ruth`) for replies and proactive announcements.
- `tests/test_bedrock_shape.py`: Converse requests (tool use and plain) are validated against the botocore API model.

## Open Source: required fields
- **Contribution URL:** https://github.com/Dakshhhhh-ops/mcp-apps-lite-host (public, MIT, CI green)
- **Primary repo URL:** https://github.com/Dakshhhhh-ops/nova
- **GitHub username:** Dakshhhhh-ops
- **What it is:** `mcp-apps-lite-host` (v0.2) is a dependency-free ES module (MIT) that renders MCP Apps (`ui://`) views in any web page. It implements the full 2026-01-26 View ↔ Host message set (initialize, tool input including partial input, tool result, cancel, size and display modes, host-context changes, `tools/call` proxy with tool-visibility checks, `resources/read` and `list`, `ui/message`, model context, open-link, and a teardown that waits for the view) in a sandboxed iframe. It enforces the view's `_meta.ui.csp`, sets the iframe permissions `allow` attribute, and has a sandbox-proxy mode (a static `sandbox-proxy.html` on a second origin, as the spec requires for web hosts). It ships with 35 unit tests and 6 browser tests that run views built with the official `@modelcontextprotocol/ext-apps` SDK in Chromium; CI runs both.
- **Why it matters:** The ext-apps repo ships view SDKs and a basic example host, but there was no small drop-in host for custom web apps, simulators or dashboards. Anyone building an Alexa+ simulation, an MCP inspector or a product UI can now show MCP Apps views in a few lines. It was extracted from Nova's Echo Show simulator.

## Product feedback

Each tool we used, answered the same way: what we used it for, what worked, what needs work, how onboarding felt, and whether we'd build with it again.

**MCP (spec + Python SDK 2.3)**
- *Used for:* the whole Alexa+ integration: MCPServer, Streamable HTTP, structured output, tool annotations, icons, resources, prompts, MCP Apps, elicitation through resolvers, and an OAuth 2.1 authorization server (dynamic registration, PKCE, RFC 9728 metadata).
- *Worked well:* A lot comes out of the box: structured output from type hints, protected-resource and authorization-server metadata from one `AuthSettings`, a DNS-rebinding guard, and an in-process `Client(server)` that made 68 tests easy to write. The migration error for `mcp.server.fastmcp` points straight to the guide.
- *Needs work:* Three behaviors cost real time (see the friction log): Apps tools registered after the server is built silently don't appear; `ctx.elicit()` fails on 2026-07-28 connections with an error that doesn't mention resolvers; and a resolver that elicits throws for clients without the elicitation capability unless you check `client_capabilities` yourself.
- *Onboarding:* Good once you find the v2 docs. The rename from FastMCP to MCPServer and the new resolver model needed source reading.
- *Would build with it again:* Yes.

**MCP Apps (`io.modelcontextprotocol/ui`)**
- *Used for:* five visual responses on the Echo Show screens (today, briefing, visit brief, pill check, reconciliation), including buttons that call tools back through the host.
- *Worked well:* A clean model: `_meta.ui.resourceUri` plus a `ui://` resource, JSON-RPC over postMessage, and `visibility: ["app"]` to keep camera-only tools away from the model.
- *Needs work:* No small reference host to copy, so we wrote the host side from the spec (we've extracted it as `mcp-apps-lite-host`). Alexa+ guidance for these views is missing: Echo Show sizes, viewing distance, theme variables, and how a view pairs with the spoken reply.
- *Onboarding:* The spec is thorough; examples for a non-chat host (a device screen) would help.
- *Would build with it again:* Yes.

**Alexa+ (simulated experience)**
- *Used for:* the target platform. We built the MCP integration and a simulated Alexa+ (two Echo Shows, a Ring doorbell, an agent loop) because we don't have Alexa+ Preview access.
- *Worked well:* MCP as the integration standard means the same server works with Alexa+, the MCP Inspector, Claude and Kiro without changes.
- *Needs work:* Non-Preview developers can't point a real or sandboxed Alexa+ at a self-hosted MCP URL, or test account linking end to end. We had to guess how Alexa+ handles elicitation, short spoken results versus screen detail, proactive notifications and MCP Apps.
- *Onboarding:* The Resources page was clear about the two paths (an MCP server or a simulated experience). An official Alexa+ MCP test console would change everything.
- *Would build with it again:* Yes, and we'd move to the real device the day Preview access allows it.

**Amazon Bedrock + Amazon Nova**
- *Used for:* the agent's tool-use loop (Converse API), image understanding (pill-bottle labels, after-visit summaries), the spoken caregiver briefing, check-in extraction, answers grounded in care notes, and visit briefs.
- *How we keep it cheap and fast:* every Nova tool returns a short `speech` line written for the ear, so when a tool answers, Alexa speaks that line without a second Converse call. That halves tokens and waiting time per turn.
- *Worked well:* The Converse API's tool-use shape maps one-to-one onto MCP tools (`inputSchema.json` is the MCP `inputSchema`), and image blocks in the same API made vision a few lines. A real Nova Lite call in eu-central-1 answered quickly.
- *Needs work:* **New-account quotas blocked us.** Every Amazon Nova model in us-east-1, us-west-2 and eu-north-1 returned `ThrottlingException: Too many tokens per day` after fewer than 50 tokens in total, other regions returned `AccessDeniedException` (account verification), and nothing says what the quota is or when it resets. Picking the right model ID per region (`us.` / `eu.` / `apac.` / `global.` inference profiles, Nova versus Nova 2) needed a probe-and-fallback loop.
- *Onboarding:* The API and SDK were smooth; the account side was the hard part (IAM user, then quotas we couldn't see because `AmazonBedrockFullAccess` doesn't include Service Quotas read access).
- *Would build with it again:* Yes. We kept the integration in, validated request shapes against the botocore model in tests, and fall back gracefully until the quota is raised.

**Amazon Polly**
- *Used for:* every spoken reply and proactive announcement (generative voice "Ruth"), plus the narrator voice in our demo-video recorder.
- *Worked well:* It worked first time on the new account, the generative voices sound natural for an older listener, and latency was fine for conversation.
- *Needs work:* We'd like SSML or prosody controls for the generative engine (a slightly slower rate for older listeners) and a list of which voices support which engine in each region, in one API call.
- *Onboarding:* Easy: one managed policy and a single `synthesize_speech` call.
- *Would build with it again:* Yes.

**Ring Partner API**
- *Used for:* the front door. `nova_server/ring_api.py` calls `GET /v1/users/me`, `GET /v1/devices`, `GET /v1/devices/{id}/status` and `GET /v1/history/devices/{id}/events?event_types=ding,motion.human` (following `links.next`), on a 5-minute poll, when a caregiver asks about recent activity, and from "Sync from Ring" in the demo. `/integrations/ring/webhook` takes Webhook v1.1 events, verifies `X-Signature` and dedupes on `meta.request_id`.
- *Worked well:* The Developer Playground token got us calling the APIs in minutes, and the official starter (`ring-api-helloworld`) made the request shapes and the two auth modes obvious. JSON:API responses are consistent, the `event_types` filter with dotted subtypes (`motion.human`) let us ask for only what a care app needs, and the webhook docs are concrete: the full v1.1 payload, the exact signature scheme and clear retry rules.
- *Needs work:* The required `User-Agent` and `Hardware_Id` headers (missing ones give a 406) are easy to miss, and the starter's scripts don't send them. Full response examples for event history (`start`/`end` units, pagination) are spread across a very long page. Events say *that* someone is at the door, not *who* (understandably), so a care app has to infer it: an opt-in "expected visitor" hint would help aides and families. There's no way to send a test webhook to your own URL without a partner account.
- *Onboarding:* Fast with the Playground; production needs app registration and account linking.
- *Would build with it again:* Yes. It's the obvious way to turn the front door into a care signal.

**AWS account setup (IAM, App Runner)**
- *Used for:* an IAM user for Bedrock and Polly, and an attempt to deploy on AWS App Runner.
- *Worked well:* IAM managed policies made the permissions clear, and `aws sts get-caller-identity` made it easy to confirm the key.
- *Needs work:* App Runner returned `SubscriptionRequiredException` ("needs a subscription for the service") on a new account with no hint about what to do, so we deployed elsewhere for now. A single "account activation status" page listing which services are still pending would save hours.
- *Onboarding:* The slowest part of the whole build.
- *Would build with it again:* Yes, once the account is fully activated.

## Friction log

| # | Task | Steps | Expected | Actual | Severity | Workaround | Suggestion |
|---|---|---|---|---|---|---|---|
| 1 | Bind tools to MCP Apps views (Python SDK 2.3) | Created `apps = Apps()`, passed it to `MCPServer(extensions=[apps])`, then decorated tools with `@apps.tool(resource_uri=...)` further down the module | Tools appear in `tools/list` | The three UI tools were silently missing; no warning | Medium | Register with `mcp.tool(meta={"ui": {"resourceUri": ...}})` | Warn or raise when an `Apps` instance gains tools after it was applied, or resolve its tools lazily |
| 2 | Ask the user for consent mid-tool (elicitation) | Called `await ctx.elicit(...)` inside a tool on a Streamable HTTP connection that negotiated 2026-07-28 | The client is asked | `Cannot send 'elicitation/create': this transport context has no back-channel for server-initiated requests` | High | Rewrote it as a `Resolve(...)` resolver returning `Elicit(...)`, which the SDK turns into an `InputRequiredResult` round trip | Mention resolvers in that error message, and show the resolver pattern first in the elicitation docs |
| 3 | Test an MCP server against Alexa+ | Looked for a way to connect a self-hosted MCP URL to Alexa+ without Preview access | A sandbox or test console | None, so we built a simulator | High | Simulated Alexa+ in a web app | An Alexa+ MCP test console with account-linking sandbox for hackathon participants |
| 4 | Choose an Amazon Nova model ID for Bedrock Converse | Started from a regional default profile | One stable identifier per model | IDs differ by geography prefix and generation; the right one depends on the region and what is enabled | Low | Probe a candidate list at startup and fall back | An API or SDK helper that resolves "best inference profile for model X in region Y" |
| 5 | Run the simulator without AWS | Machine's local AWS credentials were invalid (`InvalidClientTokenId`) | A clear path to keep building | Every Bedrock and Polly call failed | Medium | Built fallbacks: local Ollama model, then a rules router; browser speech instead of Polly | A free, rate-limited Bedrock sandbox key for hackathons (the AWS credit codes ran out on Oct 7) |
| 6 | Call Amazon Nova from a brand-new AWS account | Created an IAM user with `AmazonBedrockFullAccess`, configured the CLI, called Converse on `us.amazon.nova-2-lite-v1:0`, then every other Nova model and region | A few thousand tokens to build and record a demo | `ThrottlingException: Too many tokens per day` after under 50 tokens in total, in every US/EU region; `AccessDeniedException` (account verification) in others; the IAM user can't even read Service Quotas (`servicequotas:ListServiceQuotas` isn't in `AmazonBedrockFullAccess`) | Critical | Made throttling fail fast and fall back per turn (offline router, local model) so the demo never stalls, and re-probe Bedrock in the background every 10 minutes so Amazon Nova takes over again without a restart; Polly still worked; filed a quota increase | Show the daily token quota, the amount used and the reset time in the Bedrock console and in the throttling error; give new accounts a usable default for Nova Lite/Micro; add `servicequotas:Get*`/`List*` for Bedrock to `AmazonBedrockFullAccess`; offer hackathon participants a fast-track quota |
| 7 | Ask for consent in a tool on a client without elicitation support | A resolver returned `Elicit(...)` and an MCP client that doesn't declare the elicitation capability called the tool | The question is skipped, or the SDK falls back | `MCPError: Client did not declare the form elicitation capability required by resolver…`, so the whole tool call failed | High | Check `ctx.client_capabilities.elicitation` in the resolver and skip the question (keeping the symptom private) | Let a resolver declare an optional elicitation with a default outcome, or document the capability check next to `Elicit` |
| 8 | Deploy the MCP server on AWS App Runner | IAM user with App Runner, ECR and IAM permissions; `aws apprunner list-services` | A list (or an empty list) | `SubscriptionRequiredException: The AWS Access Key Id needs a subscription for the service` on a new account | High | Deployed the same Docker image on another host for the live link | Say in the error that the account is still being activated, and link to the account status |
| 9 | Test a Ring webhook receiver | Implemented Webhook v1.1 from the Ring Partner API docs (payload, `X-Signature` HMAC-SHA256, retry rules) and looked for a way to send a test event to our URL | A test sender, like a "send test event" button or CLI | We couldn't find one without a partner account, so there was no way to confirm our receiver against Ring itself | Medium | The simulator builds v1.1 payloads and signs them with the same HMAC scheme; tests cover signature, dedupe and event mapping | A "send test webhook" tool in the Ring Developer Portal open to every developer (like `stripe trigger`), plus a published JSON Schema for each event type |

## Feature requests
1. **Alexa+ MCP test console** for non-Preview developers: point Alexa+ at a public MCP URL, sandboxed account linking, see the tool calls. *Critical.*
2. **Echo Show rendering of MCP Apps views**, with published sizes, theme variables and a voice + screen pairing guide. *Important.*
3. **Alexa+ guidance on spoken results**: a convention like a `speech` field so servers can supply a TTS-ready line next to structured data. *Important.*
4. **Proactive notifications from MCP servers to Alexa+** (e.g. "Mom asked me to tell you she's dizzy"), with the user's consent. *Important.*

## If your project existed before the hackathon
It didn't. Nova was built during the submission window.
