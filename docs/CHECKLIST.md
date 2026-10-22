# Submission checklist

Deadline: **Oct 23, 2026, 12:00 PM PDT** (Oct 24, 12:30 AM IST). Submit at least an hour early; Devpost gets slow at the end.

## Before recording
- [ ] Pull the latest `main` and run `uv sync`.
- [ ] `uv run pytest -q`: all tests pass.
- [ ] AWS: `aws sts get-caller-identity` works. If Bedrock is no longer throttled, the top bar of `/live` shows **Amazon Nova · Amazon Bedrock**. If it's still throttled, record in offline mode and say in the video that Amazon Nova runs the brain when the account quota allows (the code path is in `simulator/agent.py` and `nova_server/llm.py`).
- [ ] `uv run python run.py`, then open the printed URL. Check the story page (`/`) and the live demo (`/live`).
- [ ] Click **Reset demo** in `/live`.

## Video (under 3 minutes, public, English)
- [ ] Either record by hand following [DEMO_SCRIPT.md](DEMO_SCRIPT.md), or run the recorder:
      `uv run --with playwright --with imageio-ffmpeg --with boto3 python scripts/record_demo.py --url <printed URL>`
      → `demo/nova-demo.mp4`
- [ ] Watch it once end to end: audio levels, nothing cut off, under 3:00.
- [ ] Upload to YouTube as **Public**, with title "Nova · a care circle for Alexa+". No copyrighted music.

## Devpost form → where the content is
| Field | Source |
|---|---|
| Project description | `docs/SUBMISSION.md` → "Project description" |
| Built with | `docs/SUBMISSION.md` → "Built with" line |
| GitHub repo | https://github.com/Dakshhhhh-ops/nova (public, MIT `LICENSE` at the root) |
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
- [ ] Push the local folder `C:\Users\daksh\OneDrive\Desktop\mcp-apps-lite-host` (it's already committed; add the remote and push).
- [ ] Put the URL in the Open Source fields.

## Final checks
- [ ] README renders on GitHub (screenshots, the mermaid diagram, docs links).
- [ ] CI badge or Actions tab is green.
- [ ] No secrets in the repo (`.env` is git-ignored; only `.env.example` is committed).
