# Task 10 — Rehearse mode, echo command, repo polish (M5 completion)

Finish the CLI surface (REQUIREMENTS § 5/§ 6) and make the repo presentable. Read
`REQUIREMENTS.md` § 5–§ 8 and every prior task's README-level manual-verification section.

## Spec

### Commands

1. **`rehearse --meeting <url> --project <dir> [flags]`** (REQUIREMENTS § 5) — same `join`
   pipeline, but with a `rehearse: true` mode flag threaded into the orchestrator: forces
   `allow_clarify` on, raises `limits.max_reply_words` ×2 (a rehearsal is where you tune
   wake + voice), and logs every wake-gate decision verbosely (why each finalized line
   fired or didn't — the tuning surface REQUIREMENTS § 6 asks for).
2. **`echo <transcript.jsonl> [flags]`** (§ 6) — no browser. Replays the transcript through
   Task 04's detector at real pace (respect ts deltas, `--fast` = ×10), runs replies through
   Task 03's brain (or `MOCK_BRAIN=1` prints canned fixture answers — CI path), prints
   wake decisions + replies to stdout. This is the REQUIREMENTS-promised CI regression path;
   `npm test` includes an echo-mode integration test over the committed fixture transcripts
   (browser never touched).
3. **`config`** already exists (Task 01) — verify `meetings-bot --help` lists ALL five
   commands with one-line descriptions.

### Polish

- **README.md** full rewrite: what it is, prerequisites (Node 22+, `ollama signin`, dedicated
  Google account, model picked per PLAN § 4), setup (`npm i`, `meetings-bot auth`), the five
  commands with examples, config reference table (every PLAN § 3.3 field), the manual
  verification playbooks from Tasks 05/06/07 collected as a "First real meeting checklist",
  troubleshooting (`MeetDomChangedError` → `--headed`, slow first TTS → warmup, deferred
  replies when you'd rather answer yourself), and a KNOWN-LIMITATIONS section (English-only
  captions+TTS by default; Edge-TTS provider is unofficial; Google could change Meet's DOM
  any day — tasks 06's selector config).
- **Root docs**: cross-link REQUIREMENTS.md / PLAN.md / tasks/README.md; add `CONTRIBUTING` note
  (single-module ownership rule from PLAN § 2.1) and update `.gitignore` for dist/logs.
- **Error UX**: every command failure exits nonzero with one actionable human sentence.
- Version bump + `--version` (commander).

## Tests (vitest)

- `rehearse` flag threading changes the config exactly as specified (and nothing else)
- echo `--fast` completes < 2s on the fixture; MOCK_BRAIN path is deterministic
- CLI `--help` snapshot contains all five commands

## Final acceptance (the whole project)

- [ ] `npm test`, `npm run build`, `npx tsc --noEmit` all green
- [ ] `echo` mode passes on fixture transcripts with zero false wakes (REQUIREMENTS FR goal)
- [ ] README complete per above; a first-time user could join a real meeting from it alone
- [ ] Pilot checklist (REQUIREMENTS M5 "real-meeting pilot"): recorded in README as a
      copy-paste checklist the owner runs once before the first real meeting

## Definition of done for the whole project

After this task: the owner runs through the README checklist in a solo rehearse meeting, a
two-person test meeting, and then the first real meeting. Any DOM breakage found there is a
selector fix in exactly one module per PLAN § 2.1 — that's success for v1.