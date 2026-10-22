# Demo video script (target 2:45)

Record at 1440x900 in Chrome. Start both servers, open http://127.0.0.1:8080, click **Reset demo**. Turn sound on (Polly, or the browser voice).

| Time | Screen | Say / do |
|---|---|---|
| 0:00–0:15 | Both Echo devices side by side | "Rose is 81 and lives alone in Columbus. Her daughter Maya lives in Seattle. Nova is a care circle for Alexa+, built as an MCP server." |
| 0:15–0:35 | Rose's Echo | Click **"What's my day look like?"**. The Today card shows taken, due and missed doses. |
| 0:35–0:50 | Rose's Echo | **"I just took my pink pill"** → *"You already took Lisinopril at 8:14 AM, so please don't take another one."* Say: "A double-dose guard. Rose described the pill by its color." |
| 0:50–1:20 | Rose's Echo | **"I'm feeling a bit dizzy this morning and my knee hurts"** → consent prompt *"Would you like me to let Maya and Leo know…?"* → **Yes**. Say: "Nova asks before it shares. That's an MCP elicitation." |
| 1:20–2:00 | Maya's Echo | **"How's Mom doing?"** → Briefing card. Point at the top insight: *dizziness began two days after her lisinopril dose was doubled*, the evidence quotes, Grace's BP reading, and Dr. Patel's instruction with the phone number. Say: "No single data point is alarming. Together, they're worth a call before Saturday." |
| 2:00–2:25 | Maya's Echo | **"Prepare a brief for Mom's cardiology visit"** → Visit brief with questions. Click **Share with circle**. |
| 2:25–2:45 | Inspector panel | Scroll the live trace: Amazon Nova on Bedrock choosing tools, MCP calls over Streamable HTTP with a token per person, `ui://` views, the elicitation. Say: "Thirteen MCP tools, Amazon Nova on Bedrock, Amazon Polly, and it works with any MCP client." |
| 2:45–2:55 | README / repo | "Nova never diagnoses. It notices, shows its evidence, and lets Rose stay in charge." |

Tips
- Keep each utterance on screen for a beat so judges can read the reply.
- If Bedrock is not configured, the top bar says which brain is active. Record with Amazon Nova for the AWS Builder entry.
- Keep the video under 3:00; judges may stop there.
