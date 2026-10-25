# MASTER PROMPT — paste/attach this in a Cursor Agent chat

You are the sole build agent for **meetings-bot** in this repository. Take it from an empty
directory containing only docs to a finished v1. This is a long, multi-hour build. Work
autonomously and don't stop to ask questions the docs already answer.

## Read first, in this order

1. `REQUIREMENTS.md` — behavioral source of truth (FRs, behavior policy, risk table)
2. `PLAN.md` — locked stack, data contracts (§ 3), latency pipeline (§ 2.3), amendments (§ 5)
3. `tasks/README.md` — task index and ground rules

## Operating rules

- Build `tasks/00-scaffold.md` → `tasks/10-rehearse-polish.md` **strictly in order**. Each
  task file is self-contained: follow its Spec and its tests literally.
- **Gate of completion per task:** `npx tsc --noEmit` green, `npm test` green,
  `npm run build` green, every acceptance criterion verifiably met, no TODO stubs left in
  implemented modules. If a gate fails, fix it before moving on.
- **Commit after each completed task** — the repo starts without git, so run `git init` first
  (and add the .gitignore from Task 00 before the first commit). Message style:
  `feat(task-05): headful auth + headless joiner`, with a body listing what passed.
  Never commit `dist/`, logs, or anything from `~/.meetings-bot` (it must never be inside the repo).
- Respect module ownership (PLAN § 2.1): all Meet DOM strings live in the owning module only
  (`captions/selectors.ts`, `speaker/selectors.ts`, `auth/selectors.ts`, `agent/chatChannel.ts`).
- Do not swap the stack (PLAN § 1). If a package version fights you, pin a compatible version
  and note it — do not substitute libraries.
- No new dependencies beyond PLAN § 1's list. No runtime env vars beyond `$MEETINGS_BOT_HOME`,
  `$MEETINGS_BOT_LIVE`, `$MOCK_BRAIN`, `$EDITOR`.
- Follow the coding style established in earlier tasks. TypeScript, ESM, strict.

## Autonomy map

**Fully autonomous — build and verify with tests only:**
00 scaffold · 01 config · 02 brief · 03 brain (live tests are `MEETINGS_BOT_LIVE=1` and
optional — never let a skipped live test fail CI) · 04 wake detector · 08 orchestrator
(mocked) · 09 notes · 10 polish (code parts).

**Owner checkpoints — implement the code, make pure tests pass, then STOP and print the
checkpoint block below. Never fabricate or mark manual verification as done:**

- **CHECKPOINT A (after Task 05 is code-complete):** the owner must
  1. create the dedicated Google account (display name = the wake name, e.g. "Saqib's Assistant"),
  2. run `meetings-bot auth` and complete sign-in/2FA,
  3. run the Task 05 Manual Verification (solo Meet, `--headed`, admit the bot).
- **CHECKPOINT B (during/after Tasks 06–07, same session as A if possible):** the owner runs
  the Manual Verification from Tasks 06 (captions produce finalized lines) and 07 (voice
  speaks and re-mutes; no self-trigger).

Checkpoint block format (print it, then wait for my reply; I will type `verified` or
`verified with notes: …`):

```
OWNER CHECKPOINT A
  Task 05 status: <one line>
  What I need from you:
    1. <exact step>
    2. <exact step>     ← copy the steps verbatim from the task file + PLAN.md § 4
  When done, reply: verified
```

**While a checkpoint is pending you may continue** with the *next autonomous task in order*
(say so explicitly: "Checkpoint A pending — proceeding with Task 08 code, will fold
verification back in"). Do not skip a checkpoint's verification at the END: Task 10's final
acceptance requires A and B confirmed.

## Non-negotiable behaviors (from REQUIREMENTS § 3 — if any test/code contradicts these, the code is wrong)

1. Never speaks without a valid wake event. 2. No verbatim repeats in-meeting. 3. Never
invents project facts — "I don't have that in the project" + a real follow-up in the notes.
4. No commitments/opinions on the owner's behalf (defer rule FR-8). 5. Participation ceiling
`limits.max_replies` / `max_talk_seconds`.

## If the environment fights you

- Missing Google credentials profile → fail fast pointing to `meetings-bot auth` (Task 05).
- Ollama daemon absent at runtime → typed `BrainConfigError` with remediation (Task 03), not a crash.
- Any `MeetDomChangedError` scenario → this is EXPECTED someday; ensure the error names the
  single module to patch and suggests `--headed`.
- If vitest mocks get gnarly around puppeteer, extract the pure logic and test that (Tasks
  06/08 hint at this already) — don't drop coverage to make the browser mock easier.

## Definition of done (only when ALL hold)

- All 11 tasks complete, committed, and their acceptance criteria checked off.
- `npm test && npm run build && npx tsc --noEmit` green on the final commit.
- `meetings-bot echo tests/fixtures/transcripts/*.jsonl --fast` runs with zero false wakes.
- README.md final per Task 10, including the "First real meeting checklist" (CHECKPOINT A/B
  results recorded there).
- Final message to me: a summary table of the 11 tasks, commits, any deviations from the
  task files (and why), and the exact remaining owner steps for the first real meeting.