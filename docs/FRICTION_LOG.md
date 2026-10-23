# Nova: friction log

Friction we hit while building Nova for the Amazon Developer *Build, Ship, Shape* hackathon (Alexa+ track), with Amazon Bedrock and Amazon Nova, Amazon Polly, the Ring Partner API and the MCP Python SDK. Each entry gives the task, the steps, what we expected and what happened, a severity, our workaround and a suggestion.

| # | Task | Severity |
|---|---|---|
| 1 | Bind tools to MCP Apps views (Python SDK 2.3) | Medium |
| 2 | Ask the user for consent mid-tool (elicitation) | High |
| 3 | Test an MCP server against Alexa+ | High |
| 4 | Choose an Amazon Nova model ID for Bedrock Converse | Low |
| 5 | Run the simulator without AWS | Medium |
| 6 | Call Amazon Nova from a brand-new AWS account | Critical |
| 7 | Ask for consent in a tool on a client without elicitation support | High |
| 8 | Deploy the MCP server on AWS App Runner | High |
| 9 | Test a Ring webhook receiver | Medium |
| 10 | Keep a hosted demo linked to Ring | Medium |
| 11 | Test Nova's event-history import against Ring | Medium |

## 1. Bind tools to MCP Apps views (Python SDK 2.3)

**Severity:** Medium

**Steps:** Created `apps = Apps()`, passed it to `MCPServer(extensions=[apps])`, then decorated tools with `@apps.tool(resource_uri=...)` further down the module

**Expected:** Tools appear in `tools/list`

**Actual:** The three UI tools were silently missing; no warning

**Workaround:** Register with `mcp.tool(meta={"ui": {"resourceUri": ...}})`

**Suggestion:** Warn or raise when an `Apps` instance gains tools after it was applied, or resolve its tools lazily

## 2. Ask the user for consent mid-tool (elicitation)

**Severity:** High

**Steps:** Called `await ctx.elicit(...)` inside a tool on a Streamable HTTP connection that negotiated 2026-07-28

**Expected:** The client is asked

**Actual:** `Cannot send 'elicitation/create': this transport context has no back-channel for server-initiated requests`

**Workaround:** Rewrote it as a `Resolve(...)` resolver returning `Elicit(...)`, which the SDK turns into an `InputRequiredResult` round trip

**Suggestion:** Mention resolvers in that error message, and show the resolver pattern first in the elicitation docs

## 3. Test an MCP server against Alexa+

**Severity:** High

**Steps:** Looked for a way to connect a self-hosted MCP URL to Alexa+ without Preview access

**Expected:** A sandbox or test console

**Actual:** None, so we built a simulator

**Workaround:** Simulated Alexa+ in a web app

**Suggestion:** An Alexa+ MCP test console with account-linking sandbox for hackathon participants

## 4. Choose an Amazon Nova model ID for Bedrock Converse

**Severity:** Low

**Steps:** Started from a regional default profile

**Expected:** One stable identifier per model

**Actual:** IDs differ by geography prefix and generation; the right one depends on the region and what is enabled

**Workaround:** Probe a candidate list at startup and fall back

**Suggestion:** An API or SDK helper that resolves "best inference profile for model X in region Y"

## 5. Run the simulator without AWS

**Severity:** Medium

**Steps:** Machine's local AWS credentials were invalid (`InvalidClientTokenId`)

**Expected:** A clear path to keep building

**Actual:** Every Bedrock and Polly call failed

**Workaround:** Built fallbacks: local Ollama model, then a rules router; browser speech instead of Polly

**Suggestion:** A free, rate-limited Bedrock sandbox key for hackathons (the AWS credit codes ran out on Oct 7)

## 6. Call Amazon Nova from a brand-new AWS account

**Severity:** Critical

**Steps:** Created an IAM user with `AmazonBedrockFullAccess`, configured the CLI, called Converse on `us.amazon.nova-2-lite-v1:0`, then every other Nova model and region

**Expected:** A few thousand tokens to build and record a demo

**Actual:** `ThrottlingException: Too many tokens per day` after under 50 tokens in total, in every US/EU/APAC region, and still the next day after the daily reset (Nova Micro, Lite, Pro and Nova 2 Lite alike; Nova Premier is retired); `AccessDeniedException` (account verification) in others; the IAM user can't even read Service Quotas (`servicequotas:ListServiceQuotas` isn't in `AmazonBedrockFullAccess`)

**Workaround:** Made throttling fail fast and fall back per turn (offline router, local model) so the demo never stalls, and re-probe Bedrock in the background every 10 minutes so Amazon Nova takes over again without a restart; Polly still worked; filed a quota increase

**Suggestion:** Show the daily token quota, the amount used and the reset time in the Bedrock console and in the throttling error; give new accounts a usable default for Nova Lite/Micro; add `servicequotas:Get*`/`List*` for Bedrock to `AmazonBedrockFullAccess`; offer hackathon participants a fast-track quota

## 7. Ask for consent in a tool on a client without elicitation support

**Severity:** High

**Steps:** A resolver returned `Elicit(...)` and an MCP client that doesn't declare the elicitation capability called the tool

**Expected:** The question is skipped, or the SDK falls back

**Actual:** `MCPError: Client did not declare the form elicitation capability required by resolver…`, so the whole tool call failed

**Workaround:** Check `ctx.client_capabilities.elicitation` in the resolver and skip the question (keeping the symptom private)

**Suggestion:** Let a resolver declare an optional elicitation with a default outcome, or document the capability check next to `Elicit`

## 8. Deploy the MCP server on AWS App Runner

**Severity:** High

**Steps:** IAM user with App Runner, ECR and IAM permissions; `aws apprunner list-services`

**Expected:** A list (or an empty list)

**Actual:** `SubscriptionRequiredException: The AWS Access Key Id needs a subscription for the service` on a new account

**Workaround:** Deployed the same Docker image on another host for the live link

**Suggestion:** Say in the error that the account is still being activated, and link to the account status

## 9. Test a Ring webhook receiver

**Severity:** Medium

**Steps:** Implemented Webhook v1.1 from the Ring Partner API docs (payload, `X-Signature` HMAC-SHA256, retry rules) and looked for a way to send a test event to our URL

**Expected:** A test sender, like a "send test event" button or CLI

**Actual:** We couldn't find one without a partner account, so there was no way to confirm our receiver against Ring itself

**Workaround:** The simulator builds v1.1 payloads and signs them with the same HMAC scheme; tests cover signature, dedupe and event mapping

**Suggestion:** A "send test webhook" tool in the Ring Developer Portal open to every developer (like `stripe trigger`), plus a published JSON Schema for each event type

## 10. Keep a hosted demo linked to Ring

**Severity:** Medium

**Steps:** Generated a token in the Ring Developer Playground, set it as `RING_ACCESS_TOKEN`, and synced the live demo (users/me, devices, status, history all returned 200)

**Expected:** A token that lasts through a judging window, or a read-only sandbox credential for demos

**Actual:** The Playground token lasts about 30 minutes; the next sync, hours later, got `401 Unauthorized` on `/v1/users/me`. A hosted demo can't stay linked without a partner app and OAuth refresh tokens

**Workaround:** Nova keeps the last real sync (no token, no email) and shows it labelled **Recorded** when a live call fails

**Suggestion:** Longer-lived Playground tokens, or a read-only demo token, for hackathons and public demos

## 11. Test Nova's event-history import against Ring

**Severity:** Medium

**Steps:** Called `GET /v1/history/devices/{id}/events?event_types=ding,motion.human` for the Playground doorbell

**Expected:** Some sample presses or motion events to test against

**Actual:** `{"data": []}`: the Playground device has no history, and we found no way to trigger a test ding or motion event for it

**Workaround:** Built the import against recorded-shape fixtures (pagination, dedupe, fresh vs backfilled events) and drove real-time events through signed simulated webhooks

**Suggestion:** A "send test event" control for Playground devices that also lands in event history
