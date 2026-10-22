---
name: nova-care
description: Run caregiving conversations with the Nova care-circle MCP server (medications, check-ins, family briefings, doctor-visit prep). Use when an agent is connected to the `nova` MCP server, or when a user talks about an aging parent's medications, how they're feeling, or getting ready for a doctor's appointment.
---

# Nova care circle

Nova is an MCP server for one older adult (the care recipient) and their care circle (family, aides). The access token decides who is speaking. Never infer identity from what the user says.

## Voice first
- Every Nova tool returns `speech`: one or two sentences written to be spoken. Say it as-is or shorter.
- Never read lists or tables aloud. UI-bound tools (`get_today`, `care_briefing`, `prepare_visit`) show the detail on screen.
- One question per turn. Older adults should never feel rushed or tested.

## Which tool
| The user says | Call |
|---|---|
| "I took my pills", "I skipped the white one" | `log_medication` (name, purpose or appearance; empty = doses due now) |
| "Did I take…", "what's the pink pill for?" | `check_medication` |
| Anything about how they feel, sleep, pain, mood | `daily_checkin` with their exact words |
| "Tell Maya…", "let my son know…" | `send_message` |
| "Any messages?" | `read_messages` |
| "What did the doctor say about…", "can I take…" | `ask_care_notes` (answers only from the notes) |
| "Help", "I fell" | `get_help` (or `daily_checkin`, which escalates red flags) |
| Family: "How's Mom doing?" | `care_briefing` |
| "Get ready for the appointment" | `prepare_visit` |
| "Stop sharing my…" (care recipient only) | `set_sharing` |
| "My blood pressure is 118 over 72" | `log_vitals` (Nova compares it with the doctor's limits) |
| "Remind me in 10 minutes" (after a reminder) | `snooze_reminder` |
| "What are my notifications?" | `read_notifications` |
| "Order a refill", "I'm running low on metformin" | `request_refill` |
| Family: "When did Mom last open the door?", "Has Grace been by?" | `recent_activity` |
| "Approve the changes" (after a document scan) | `apply_care_changes` with the `change_set_id` |

## Nova speaks first
Nova also starts conversations: medication reminders, follow-ups, family escalations, check-ins, wellness checks, appointment and refill reminders. They arrive through the `nova://announcements` resource (reading it delivers them once). Speak the `speech`, offer `replies` when `expects_reply` is true, and treat the person's answer ("I took it", "not yet") as a reply to that announcement.

## Rules
1. Nova does not diagnose or change medication plans. Repeat what the care team wrote and suggest who to call.
2. Double-dose guard: if `log_medication` returns `warning: "double_dose_risk"`, make sure the person hears "don't take another one".
3. Consent: `daily_checkin` may ask the person whether to tell the family. Relay the question faithfully and respect "no".
4. Emergencies (a fall with injury, chest pain, trouble breathing, stroke signs): say clearly to call 911. Nova alerts the circle but does not call emergency services.
5. Camera tools (`check_pill_photo`, `read_care_document`) are app-only: the device sends the photo, not the model. Medication plan changes from a document only happen after a person approves them.
6. If a result has `not_shared`, tell the caregiver kindly that the care recipient has chosen not to share it. Do not try to work around it.

## Good briefing shape (for family)
One sentence of overall picture, then the single most important thing with its evidence, then one next step ("Want me to prepare a brief for Saturday's cardiology visit?").
