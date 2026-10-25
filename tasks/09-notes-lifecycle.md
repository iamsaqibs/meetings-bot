# Task 09 — Notes writer + lifecycle (M5)

End-of-meeting deliverables and crash safety. Read `REQUIREMENTS.md` FR-9, hard rule 3
("genuinely adds it to the notes follow-ups"), non-functional reliability rows, `PLAN.md`
§ 3.4 (notes format) and § 3.1 (raw transcript path).

## Spec

### `notes/numbering.ts`

Pick `NNN` by scanning `<project>/meeting-notes/` for `NNN-*.md` (max existing + 1, 0-pad 3).
Race-safe enough for a single bot (read-then-create loop).

### `notes/summarizer.ts`

One LLM pass (Task 03's `chat`, not the full tool-loop agent) over the transcript with a
summarizer system prompt whose rules mirror the meeting persona's: never invent; attribute
decisions/actions to caption-attributed owners; unknown owner → `"unattributed"`; flag
follow-ups the bot promised during the meeting ("genuinely adds it to the notes follow-ups"
— hard rule 3: every "I can check after the call" becomes an action item owner = bot).
Output: strict JSON `{ summary, decisions[], actions[{ text, owner }], followups[] }`,
validated with zod, one retry on invalid JSON. Then a `defer` note: the summarizer must
carry the orchestrator's follow-up additions (Task 08's guard output) — merge them.

### `notes/writer.ts`

Render the markdown per PLAN § 3.4 into `NNN-YYYY-MM-DD-<slug>.md`
(slug = 5 words from the first wake question or the meeting date if unwoken),
sections: Summary / Decisions / Action items (with owner) / Q&A log (each `WakeEvent`:
ts, asker, question → answer, marked `via audio` or `via chat` for FR-10 fallbacks).
Companion: copy/refresh `<project>/meeting-notes/.raw/NNN-transcript.jsonl` (the store
already wrote there live — writer verifies it exists and is complete, else reconstructs
from in-memory lines).

### `lifecycle/leave.ts` — meeting-end detection

Poll every 5s during the meeting (Task 05 provides `isLeaveDetected`): banner detected OR
captions-idle past `meet.idle_timeout_minutes` OR browser closed → leave path.
On ANY exit path: flush partial notes (REQUIREMENTS: "unexpected leave → still writes
partial notes" — mark the notes heading with `(partial — meeting ended unexpectedly)`,
keep transcript as-is). `lifecycle/signals.ts`: SIGINT/SIGTERM/uncaughtException →
graceful path, exit 0 on clean, 130 on Ctrl+C.

### `commands/join` — final teardown call from Task 08's `MeetingResult`

Order: stop captions → flush transcript → close browser → notes → summary printed.

## Tests (vitest)

- numbering: existing 001/003 → next 004; empty dir → 001; bad names don't crash
- summarizer JSON validation + retry on invalid output (mock brain)
- writer output: full fixture transcript → assert all four sections, owner attribution,
  `via chat` marker, followups merged
- partial-notes marker on simulated crash path (throw inside the loop fixture)
- leave: idle timeout triggers end path without banner

## Manual verification

Run a rehearse meeting (Task 10 wires the command), Ctrl+C mid-call → partial notes exist
with correct numbering; run to natural end → full notes.

## Acceptance criteria

- [ ] `npm test`, `npx tsc --noEmit` green

## Out of scope

Rehearse/echo commands (10 — they're command shells over these modules).