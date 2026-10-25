# Task 01 — Config module

Implement configuration loading and the `meetings-bot config` command (REQUIREMENTS § 5).
Read `REQUIREMENTS.md` § 5 and `PLAN.md` § 3.3 first, plus `src/config/schema.ts` (already
stubbed with the exact `AppConfig` shape).

## Spec

1. **Runtime home**: `~/.meetings-bot/` (respect `$MEETINGS_BOT_HOME` for tests). Subdirs the
   whole project will use, create lazily: `profile/` (Chromium profile w/ Google credentials —
   never leave this dir), `cache/` (project briefs), `logs/`.

2. **schema.ts** — a zod schema matching PLAN § 3.3 exactly: `wake_names[]` (required, ≥1),
   `bot_name`, `ollama{base_url,model,temperature,max_context_tokens}`, `tts{provider: enum
   ["kokoro","edge"], voice, gain}`, `limits{max_reply_words,max_replies,max_talk_seconds}`,
   `wake{allow_clarify,finalize_ms}`, `defer_phrases[]`, `meet{idle_timeout_minutes}`.
   Defaults for every field except `wake_names`, `bot_name`, `model` — those are required
   because they're human-specific (wake names from caption text, per REQUIREMENTS FR-3).
   Export both the schema and the inferred `AppConfig` type.

3. **load.ts** — `loadConfig(path?)`: read the yaml, merge over defaults field-by-field
   (deep merge, arrays replace), validate with zod, on failure print a zod-formatted error
   listing every problem (path + expected/actual) and exit 1. If the file doesn't exist,
   write a fully-commented default template to disk (so first run is self-documenting) and
   load it — the required fields get clearly-marked placeholder values like
   `bot_name: "CHANGE ME — your assistant's name"`, and a warning is logged on every load
   while a required field equals its placeholder.

4. **config command** — `meetings-bot config` opens the config file in `$EDITOR` (fallback
   to `$VISUAL`, then `vi`), validates after the editor exits, and prints either
   `✓ config valid` or the validation errors.

5. **Precedence note for later tasks**: env overrides are intentionally *not* part of v1;
   the CLI flags `--model`, `--name` (REQUIREMENTS § 5) patch the loaded config object in
   argv order — implement that patching in `load.ts` as `mergeCliFlags(config, flags)`.

## Tests (vitest, pure — no browser, no daemon)

- validation errors surface field paths (bogus provider, missing wake_names)
- defaults merge correctly over a partial file
- template generation is idempotent (doesn't clobber an existing user-edited file)
- `mergeCliFlags` overrides `ollama.model` and `bot_name` from `--model`/`--name`
- `$MEETINGS_BOT_HOME` redirect honored

## Acceptance criteria

- [ ] `npm test` green, `npx tsc --noEmit` green
- [ ] `node dist/bin/meetings-bot.js config` opens an editor (or prints a sane fallback)
- [ ] Running any command twice creates the template once and never clobbers edits

## Out of scope

Network calls, anything in `profile/` beyond mkdir.