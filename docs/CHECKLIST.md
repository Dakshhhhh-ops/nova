# Submission checklist

Deadline: **Oct 23, 2026, 12:00 PM PDT** (Oct 24, 12:30 AM IST). Submit at least an hour early; Devpost gets slow at the end.

## Before recording
- [ ] Pull the latest `main` and run `uv sync`.
- [ ] `uv run pytest -q`: all tests pass.
- [ ] AWS: `aws sts get-caller-identity` works. The Bedrock daily quota resets at midnight UTC (05:30 IST); the servers re-check every 10 minutes and switch by themselves, so the top bar of `/live` changes from **Nova offline router (Amazon Nova daily quota reached, retrying)** to **Amazon Nova 2 Lite · Amazon Bedrock** without a restart. Record once it does. If it never does, record in offline mode; the label already explains why.
- [ ] `uv run python run.py`, then open the printed URL. Check the story page (`/`) and the live demo (`/live`).
- [ ] Click **Reset demo** in `/live`.

## Video (under 3 minutes, public, English)
- [ ] Either record by hand following [DEMO_SCRIPT.md](DEMO_SCRIPT.md), or run the recorder:
      `uv run --with playwright --with imageio-ffmpeg --with boto3 python scripts/record_demo.py --url <printed URL>`
      → `demo/nova-demo.mp4`
- [ ] Watch it once end to end: audio levels, nothing cut off, under 3:00.
- [ ] Upload to YouTube as **Public**, with title "Nova · catches medication mistakes before they happen (Alexa+)". No copyrighted music.

## Devpost form → where the content is
| Field | Source |
|---|---|
| Project description | `docs/SUBMISSION.md` → "Project description" |
| Built with | `docs/SUBMISSION.md` → "Built with" line |
| GitHub repo | https://github.com/Dakshhhhh-ops/nova (public, MIT `LICENSE` at the root) |
| Try-it link | https://nova-6kte.onrender.com (open it once a minute before judging: free hosting sleeps). For Amazon Nova there, add `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_REGION=us-east-1` in the Render dashboard (never in the repo). |
| Video URL | your YouTube link |
| Track | **Alexa+** (self-hosted MCP server + simulated Alexa+ experience) |
| Mini challenges | **AWS Builder**; **Open Source** only if `mcp-apps-lite-host` is public |
| AWS Builder: services and how | `docs/SUBMISSION.md` → "AWS Builder: integrations" |
| Product feedback | `docs/SUBMISSION.md` → "Product feedback" |
| Friction log (up to a 10% bonus) | `docs/SUBMISSION.md` → "Friction log" table |
| Feature requests (optional) | `docs/SUBMISSION.md` → "Feature requests" |
| Existed before the hackathon? | No: built during the submission window |
| Open Source fields | `docs/SUBMISSION.md` → "Open Source: required fields" |

## Open Source mini challenge (optional, $5k)
- [ ] Create an empty public repo `Dakshhhhh-ops/mcp-apps-lite-host` on GitHub.
- [ ] Push the local folder `C:\Users\daksh\OneDrive\Desktop\mcp-apps-lite-host` (v0.2 is committed; add the remote and push). Its CI runs the unit and browser tests.
- [ ] Put the URL in the Open Source fields.

## Final checks
- [ ] README renders on GitHub (screenshots, the mermaid diagram, docs links).
- [ ] CI badge or Actions tab is green.
- [ ] No secrets in the repo (`.env` is git-ignored; only `.env.example` is committed).
