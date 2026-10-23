# Demo video script (target 2:50)

One main story, then one shorter example. The main story shows vision, state that persists, human approval, two identities, voice and screen, and MCP in a single sequence, without jumping between topics.

`scripts/make_video.py all --url <app>` records and edits this script automatically. By hand: record at 1440x900 in Chrome with sound on, start everything (`uv run python run.py`), open `/live` and use the **Start the story** card (top left), which runs each step below.

| Time | Screen | Do / say |
|---|---|---|
| 0:00–0:20 | Title, then the story page | "Fifty-three million Americans care for a family member, unpaid. Rose is 81 and lives alone in Columbus. Her daughter Maya lives in Seattle. Nova links Rose's Echo Show, her Ring doorbell and Maya's Echo." |
| 0:20–0:45 | Maya | **Scan paperwork → After-visit summary.** The card shows the change: lisinopril 20 → 10 mg, with the doctor's reason (dizziness when standing, low blood pressure). Say: "After a cardiology visit, Dr. Patel lowers Rose's lisinopril. Maya photographs the summary, and Nova reads the change." |
| 0:45–1:05 | Maya, then Rose | **Approve.** Say: "Nothing changes until Maya approves." Rose's Echo: *"Rose, Dr. Patel changed your lisinopril from 20 mg once daily to 10 mg."* |
| 1:05–1:25 | Rose | **Show Alexa → Lisinopril 20 mg** (the old bottle). *"Careful, Rose: this is the old 20 mg lisinopril. Your plan is now 10 mg, so please set this bottle aside."* |
| 1:25–1:50 | Maya | Her Echo glows: *"Mom picked up her old 20 mg lisinopril bottle. I told her to set it aside: her plan is 10 mg now."* Tap **Order a 10 mg lisinopril refill** → *"Done, I've sent the Lisinopril refill to Elm Street Pharmacy."* Say: "Maya hears what happened, and orders the new dose with one tap." |
| 1:50–2:20 | Both, time-lapse to 6 PM | 6 PM reminder → 6:30 follow-up → 7:30 Maya's Echo: *"Mom hasn't taken her 6 PM Metformin. I reminded her at 6 and 6:30."* Say: "Nova also speaks first. When a pill is missed, it reminds Rose, follows up, and only then tells Maya." |
| 2:20–2:50 | Under the hood | "An MCP server for Alexa+ with twenty-five tools, a token for each person, and consent by elicitation, with Amazon Nova on Bedrock for language and vision. Nova never diagnoses. It notices, shows its evidence, and keeps Rose in charge." |

Tips
- Before recording, make sure the top bar shows **Amazon Nova 2 Lite** when Bedrock is available.
- Let each announcement finish speaking before the next click.
- Keep it under 3:00.
