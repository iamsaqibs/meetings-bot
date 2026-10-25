# Cursor Build Tasks — Meetings Bot

Build **in order**, one task per Agent session. Every prompt is self-contained, but each
assumes the previous tasks' files exist.

**How to use:** open Cursor in this repo → start a new Agent chat → paste the full contents
of the task file → let it run → verify with its checks before moving on.

Order and purpose:

| # | Task | Builds | Milestone |
|---|------|--------|-----------|
| [00](./00-scaffold.md) | Scaffold | package/tsconfig/eslint/vitest/CLI skeleton | pre-M1 |
| [01](./01-config.md) | Config | zod config schema + `config` command | pre-M1 |
| [02](./02-context-brief.md) | Project brief | digest builder + read_file tool (pure Node) | M4 |
| [03](./03-llm-brain.md) | LLM brain | Ollama /v1 client, streaming, tool loop | M2 |
| [04](./04-transcript-wake.md) | Transcript + wake | JSONL store, wake detector, self-exclusion | M2 |
| [05](./05-auth-joiner.md) | Auth + joiner | headful login + headless Meet join | M1 |
| [06](./06-captions.md) | Captions | tiered selectors, finalization, live capture | M1 |
| [07](./07-tts-speaker.md) | TTS + speaker | Kokoro (+Edge), audio injection, mute mgmt | M3 |
| [08](./08-orchestrator.md) | Orchestrator | the live meeting loop | M3–M5 |
| [09](./09-notes-lifecycle.md) | Notes + lifecycle | summarizer, writer, leave detection, crash rescue | M5 |
| [10](./10-rehearse-polish.md) | Rehearse + polish | rehearse/echo commands, pilot checklist | M5 |

Ground rules for every task (repeat to Cursor if it drifts):

- `REQUIREMENTS.md` is the source of truth for behavior; `PLAN.md` for stack and contracts.
- TypeScript, ESM, no new deps without checking `PLAN.md` § 1.
- All selectors, all DOM strings, all Meet-specific logic live in the module that owns them.
- `npm test` and `npx tsc --noEmit` must pass before the task is done.
- Don't create git commits unless asked.