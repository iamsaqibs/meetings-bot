# Task 08 — Live orchestrator (the meeting loop)

Wire everything: this task is where FR-3/4/6/7/8/10 live together. Read `REQUIREMENTS.md`
FR-6 through FR-10, behavior policy § 3, `PLAN.md` § 2.2 (loop) and § 2.3 (latency pipeline).
This task assumes Tasks 02–07 all pass their own acceptance criteria.

## Spec

### `agent/orchestrator.ts` — `runMeeting(options): Promise<MeetingResult>`

Startup sequence (fail fast per PLAN § 3 order):
1. config load → brief build/load (Task 02) → `ensureBrainReachable` (Task 03) →
   TTS provider + warmup (Task 07, only if speaking enabled; failures degrade to
   chat-only mode per FR-10 — never abort the meeting).
2. Browser + join (Task 05) → captions attach (Task 06) → transcript store open
   (Task 04) → loop.

The loop:
- Each finalized caption line → store.append → wake detector.feed.
- On WakeEvent → policy gates in order. ANY gate failing = no reply, log reason:
  - rate limits (FR-7, Task 04's counters + `limits.max_replies` / talk-time ceiling from
    hard rule 5 — track cumulative spoken seconds from measured playback durations),
  - defer gate positive (FR-8: reply with the exact defer line from REQUIREMENTS, e.g.
    "That's better answered by Saqib himself — over to you." — the wording table lives in
    `agent/deferPhrases.ts`, seeded by config),
  - "I don't have that" guard: REQUIREMENTS hard rule 3 — never invent. The brain's system
    prompt already forbids fabrication (Task 03); here also scan replies for a set of
    hedged-invention tells the model was told to use ("I don't have that in the project") —
    when present, ADD the question to the notes follow-ups list (Task 09 consumes it).
- Reply rendering pipeline (PLAN § 2.3): stream LLM → sentence-split → TTS per sentence →
  `speaker.speakSequence`. On `TtsError`/track-swap failure mid-reply (FR-10): abort audio,
  post the full answer text to Meet's in-meeting chat (find chat button, textarea, send —
  `agent/chatChannel.ts`, DOM strings owned there), log the degradation. `is_self` window
  covers TTS-spoken lines so the bot can't hear itself (FR-6).
- Transcript excerpt for the brain: `store.lastNonSelf(...)` sliding window (Task 03).
- `usedFiles` from the brain → log + append a `source:"system"` line to the transcript
  ("read files: X,y") for notes attribution.
- No verbatim repeats (hard rule 2): keep hashes of sent replies; if the generated reply
  hashes equal a previous one, ask the brain once to rephrase, else skip with a logged
  degradation.
- Wake-event merging within 5s (Task 04) flows through as combined-question replies.

### `commands/join` final wiring + `--headed`, `--model`, `--name` flags (config merging from Task 01's `mergeCliFlags`)

Latency tracking: measure and log `wake→first-sound` per reply; if it exceeds 10s, log a
`slow_reply` warning with the per-stage breakdown (REQUIREMENTS non-functional budget).

Teardown: SIGINT → clean stop path (Task 09 supplies what happens after; orchestrator
emits `MeetingResult { transcriptPath, stats }`).

## Tests (vitest with mocked browser/detector/brain/speaker)

- gate ordering: deferral beats rate limit beats reply
- TTS-fail → chat fallback path called with full text; degradation logged
- no-repeat rule triggers rephrase path
- talk-time ceiling stops further replies (hard rule 5)
- self lines excluded from excerpt sent to brain

This is the richest unit-test surface in the project — the browser is mocked; the real
meeting comes from Task 10's rehearse mode.

## Acceptance criteria

- [ ] `npm test`, `npx tsc --noEmit` green
- [ ] A dry-run harness (`tsx src/bin/dry-run.ts`, browser stubbed) walks one full fake
      meeting end-to-end printing a timeline to stdout — include it as a committed fixture test

## Out of scope

Notes writing/leave handling internals (09, but emit the artifacts' paths), rehearse/echo
commands (10).