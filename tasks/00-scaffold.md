# Task 00 — Scaffold the project

You are building the foundation of `meetings-bot` — a CLI that joins Google Meet calls as a
shadow assistant. Read `REQUIREMENTS.md` (behavior source of truth) and `PLAN.md` (stack and
contracts) before writing anything.

## Deliverables

1. **package.json** — name `meetings-bot`, `"type": "module"`, Node `>=22`, a `bin` entry
   `meetings-bot -> dist/bin/meetings-bot.js`. Install (latest stable, pin what npm gives you):
   - runtime: `commander`, `yaml`, `zod`, `pino`
   - browser (install now, used later): `puppeteer`, `puppeteer-extra`,
     `puppeteer-extra-plugin-stealth`
   - tts (used later): `kokoro-js`, `msedge-tts`
   - digest (used later): `fast-glob`, `ignore`
   - dev: `typescript`, `tsx`, `vitest`, `@types/node`, `pino-pretty`, eslint (flat config)
     + typescript-eslint, prettier
   Note: the puppeteer postinstall downloads Chromium — say it's expected if it takes a while.

2. **tsconfig.json** — strict, ESM (`module: NodeNext`), `outDir: dist`, `include: src`,
   `noUncheckedIndexedAccess: true`.

3. **Source tree** — create these empty-but-typed modules (a stub class/function that throws
   "not implemented" is fine; the point is the shape compiles):
   ```
   src/
     bin/meetings-bot.ts       commander CLI with subcommands: join, auth, rehearse, echo, config
     config/schema.ts  config/load.ts
     auth/joiner.ts  auth/session.ts
     captions/source.ts  captions/selectors.ts
     transcript/types.ts  transcript/store.ts
     context/brief.ts  context/reader.ts
     brain/ollama.ts  brain/agent.ts
     wake/detector.ts
     tts/provider.ts  tts/kokoro.ts  tts/edge.ts
     speaker/injector.ts
     agent/orchestrator.ts
     notes/summarizer.ts  notes/writer.ts
     lifecycle/leave.ts  lifecycle/signals.ts
     logging/logger.ts
   ```

4. **Interfaces stubs now, exactly as named** (later tasks fill them; renames cause churn):
   - `transcript/types.ts`: `TranscriptLine { ts, speaker, text, is_self, source }` (matches
     PLAN § 3.1), `WakeEvent { ts, asker?, question, contextLines, clarifyUsed? }`.
   - `config/schema.ts`: export `AppConfig` matching PLAN § 3.3 field-for-field (zod schema).
   - `tts/provider.ts`: `TtsProvider { readonly providerId: string; synthesize(text: string): Promise<{ pcm: Int16Array; sampleRate: number }> }`.
   - `logging/logger.ts`: pino instance reading pretty from `NODE_ENV !== "production"`.

5. **Script entries**: `build` (tsc), `dev` (tsx), `test` (vitest run), `lint`.

6. **.gitignore** — node_modules, dist, `*.log`, `.env`. Explicitly do NOT ignore
   `meeting-notes/` (it ships inside projects). Note in a comment that `~/.meetings-bot/`
   (the runtime home with the Google profile) lives outside any repo by design.

7. **README.md stub** — one section "Status: building — see tasks/". Task 10 finishes it.

## Acceptance criteria

- [ ] `npx tsc --noEmit` passes
- [ ] `npm test` passes (vitest finds zero tests — that's fine, add `tests/` with a trivial smoke test)
- [ ] `npm run build` emits `dist/` and `node dist/bin/meetings-bot.js --help` prints the five subcommands
- [ ] All stub modules compile and export the named interfaces above

## Out of scope

Any behavior. No config loading logic, no browser launching — Task 00 is shape only.