# Demo video script (target 2:50)

Record at 1440x900 in Chrome with sound on. Start everything (`uv run python run.py`), click **Reset demo**, hide the inspector until the end. Use the clock control in the top bar for time jumps and time-lapse.

| Time | Screen | Do / say |
|---|---|---|
| 0:00–0:12 | Both Echos + Ring | "Rose is 81 and lives alone in Columbus. Her daughter Maya is in Seattle. Nova is a care circle for Alexa+. It doesn't wait to be asked." |
| 0:12–0:35 | Jump to **7:55 AM**, speed **60×** | At 8:00 Rose's Echo announces her morning pills. Rose taps **Show Alexa** → *Atorvastatin bottle*. Nova: *"That's atorvastatin, your bedtime pill. Put it back. Right now it's time for your lisinopril…"* Say: "Amazon Nova reads the label. Nova checks it against her plan." |
| 0:30–0:38 | Rose | **Show Alexa** → *Ibuprofen* (her knee hurts). Nova: *"Please don't take ibuprofen… your knee instructions say to avoid it… acetaminophen up to 3,000 mg a day."* |
| 0:38–0:55 | Rose | Tap **I took it**. Then the 9 AM prompt: *"How are you feeling today?"* → **A bit dizzy again** → consent: *"Would you like me to let Maya and Leo know?"* → **Yes**. Say: "She decides what her family hears." |
| 0:55–1:25 | Maya | **How's Mom doing?** Briefing card: *dizziness began two days after her lisinopril dose was doubled*, BP 152/91 before vs 108/66 since, Grace's note, Dr. Patel's instruction. "No single signal is alarming. Together, they're worth a call." |
| 1:25–1:35 | Ring | **Grace arrives** → Rose: *"Grace is at the front door."* Maya: *"Grace arrived at Mom's at 10:02."* |
| 1:35–2:05 | Maya | **Scan paperwork** → *After-visit summary* → reconciliation card: Lisinopril 20 → 10 mg, reason, instructions → **Approve**. Rose's Echo: *"Dr. Patel changed your lisinopril from 20 mg to 10 mg…"* Then Rose shows the **Lisinopril 20 mg** bottle → *"Careful… your plan now says 10 mg."* |
| 2:05–2:35 | Jump to **5:55 PM**, speed **300×** | 6 PM reminder → 6:30 follow-up → 7:30 Maya's Echo glows yellow: *"Mom hasn't taken her 6 PM Metformin. I reminded her at 6 and 6:30."* Maya taps **Remind Mom again** → Rose gets *"Message from Maya…"* |
| 2:35–2:50 | Show the inspector | "Twenty-two MCP tools over Streamable HTTP, a token per person, MCP Apps on the Echo Show, consent by elicitation, and Amazon Nova on Bedrock for language and vision. Nova never diagnoses. It notices, shows its evidence, and keeps Rose in charge." |

Tips
- Before recording, make sure the top bar shows **Amazon Nova · Amazon Bedrock** (fix AWS credentials first). Offline mode works but is less impressive for the AWS Builder entry.
- Let each announcement finish speaking before the next click; set speed back to 1× while talking over a card.
- Keep it under 3:00.
