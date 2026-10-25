# Task 04 — Transcript store + wake detector (the CI-testable core)

This is the heart of FR-2/FR-3/FR-7 minus the browser: where caption lines become a durable
transcript, and where "was the bot addressed?" is decided. Read `REQUIREMENTS.md` FR-2,
FR-3, FR-7, behavior policy § 3, and `PLAN.md` § 3.1–3.2 (contracts) + § 2 research note on
caption finalization.

## Spec

### `transcript/store.ts` — TranscriptStore

1. `append(line: TranscriptLine)` — opens (one persistent fd), serializes one JSON object per
   line, **fsync per line** (REQUIREMENTS non-functional "crash-safe: append-per-line, fsync
   per line" — do not batch).
2. `lines()`, `lastNonSelf(n)` helpers for prompt building.
3. `TranscriptLine.source: "caption" | "tts" | "chat" | "system"`, `is_self` flag mandatory.
4. Rotating path: the store is created by the orchestrator with the final `.raw/NNN-transcript.jsonl`
   path (Task 09 picks the number NNN — the store just takes a path from config).

### `wake/detector.ts` — WakeDetector

Two-stage gate (FR-3), each stage pure and separately testable:

1. **Lexical gate** (no LLM, decides most cases in <1ms): fire only when
   - a wake name from `config.wake_names` appears (case/punctuation-insensitive, matched on
     word-ish boundaries so "assistant" doesn't fire on "assistance" or a speaker *named*
     "Assistant" — see the speaker-name exclusion below) in the finalized line, or in either
     of the two preceding lines that form the sentence's context; AND
   - the line (or the immediately following line within 1.5s) has question/request form:
     ends-with or contains `?`, or an imperative/directive verb stem list
     (`what/why/how/when/can/could/do you/please/tell/show/explain/check/find/are you/get/give/give me...`),
     or `allow_clarify`-eligible ambiguity. Bare name mention + no question form → **no fire**
     (explicit REQUIREMENTS rule: "require a question/request form, not a bare name mention").
2. **Speaker exclusion**: if the candidate line's speaker equals `config.bot_name` (normalized),
   or the line was delivered while the bot was speaking → never fires (FR-6 no self-triggering).
   `setSpeaking(active: boolean)` feeds this.
3. **LLM gate** (only for lexical passes that are ambiguous — e.g., contains a wake name and
   a question but the question reads like it's aimed at the room): call the brain with a tiny
   system prompt, `temperature 0`, `max_tokens 12`, and return `{ addressed: boolean, defer: boolean }`.
   Defer-detection (FR-8) rides the same gate: commitment/estimate/approval/`"would Saqib
   prefer X"` phrasing → `defer: true` (combined with `defer_phrases` lexical pre-match).
   Cache the verdict keyed by normalized question text + speaker (same question re-asked →
   same verdict, no second LLM call — cost control).
4. Output: `feed(line: FinalizedLine): WakeEvent | null`, plus `clarifyOnce(event)` hook
   honoring `allow_clarify` (at most ONE clarifying line per ambiguity, per FR-3).
5. Rate discipline lives here too (FR-7): `canReply(now)` — no back-to-back without a new
   wake event; ≤1 reply per wake event; if two wake events arrive within 5s, merge them into
   one event carrying both questions ("answers once covering both"). Counters for
   `limits.max_replies` exposed to the orchestrator; talk-time accounting is Task 08's.

## Tests (vitest — this task's value is coverage)

Fixture transcripts (`tests/fixtures/transcripts/*.jsonl`), committed, shaped like PLAN § 3.1:

- fires on direct + near-context address ("Hey Saqib's Assistant, ...", name in prior line)
- no fire on bare name mention (someone says "I'll ask the assistant later")
- no fire on question without wake name
- no fire on own speaker / during speaking window
- no fire on speaker's own name matching a wake word (participant literally named "Assistant")
- merges two events inside 5s; refuses back-to-back reply without new event
- clarify budget: at most one per meeting
- LLM gate called only for ambiguous cases (mock brain) and its verdict cached
- fsync per line: spy on `fs.fsyncSync` call count == append count

Then wire the `echo` **half**: `src/bin/wake-echo.ts` module (the `echo` command body arrives
in Task 10; export now) — given a fixture transcript, print every `WakeEvent` + the mock or
live reply to stdout, one JSON line per event.

## Acceptance criteria

- [ ] `npm test` (≥ 20 assertions here), `npx tsc --noEmit` green
- [ ] `tsx src/bin/wake-echo.ts` on a fixture prints 3+ wake events correctly, 0 false fires

## Out of scope

Browser, TTS, notes. Detector consumes already-finalized lines.