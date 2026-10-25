# Task 02 — Project brief builder + file reader (M4, built early: pure Node)

Build FR-5: the on-disk project digest the brain is grounded in, plus the read-only
`read_file` tool it can call mid-meeting. This module never touches a browser. Read
`REQUIREMENTS.md` FR-5, hard rule 3, and `PLAN.md` § 2.1/§ 4 (context module) first.

## Spec

### `context/brief.ts` — `buildProjectBrief(projectDir): Promise<Brief>`

1. `Brief` = `{ projectDir, hash, tree: string, seedText: string, totalBytes, generatedAt }`.
2. **Tree**: walk with `fast-glob`, filter with the `ignore` package (read `.gitignore`
   `.npmignore`-equivalents only from .gitignore — not npm-specific). Depth-cap `4`, entries
   `500`, render as an ASCII tree. Always include hidden config dots (`.env.example` yes,
   `.env` excluded by gitignore anyway).
3. **Seed text** — concatenated, each under its own heading, stop when budget hit:
   - `README.md`, `CLAUDE.md` (both, whichever exist — REQUIREMENTS names them explicitly)
   - manifests: `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml` (name/scripts/deps sections)
   - top-level `docs/*.md` (max 5 files, first 200 lines each)
   - hard budget: **20,000 chars** for seed text; truncate per-file at a heading boundary when
     the budget is near, list what was truncated at the end (`(seed truncated: 3 files)`) so
     the brain knows it may `read_file` those.
4. **Cache** to `~/.meetings-bot/cache/<project-hash>/brief.md` + `brief.json`
   (`project-hash` = 16-hex of sha256 over the absolute resolved path + the set of relevant
   file mtimes — cheap staleness check on load). `loadBrief(projectDir)` returns the cache
   if hash matches, rebuilds otherwise.

### `context/reader.ts` — `readProjectFile(projectDir, relPath): Promise<ReadFileResult>`

1. Resolve `path.resolve(projectDir, relPath)` and **refuse anything outside it** — resolve
   then `startsWith` the resolved root + separator. Symlinks inside the project that point
   out of the root are refused too (`realpath` check first). This is hard rule "requests
   outside the project root are refused" (FR-5) — test it aggressively (absolute paths, `..`,
   `~/`, symlink escape).
2. Cap read size at 100KB total; binary sniff (magic bytes / null-heavy) → return
   `{ ok: false, reason: "binary" }`.
3. Format the successful result for the LLM: fenced code block with the path and a line-number
   gutter? No gutter — plain fenced block with the path above it. Return a result type, and
   export `describeReadResult` used by the brain loop to render it into the tool message.

## Tests (vitest, tempdir-based)

- gitignore respected (`node_modules`, deep negation patterns from `ignore`)
- depth + entry caps actually cap
- budget truncation flags truncated files
- path escape: absolute, `../`, `~`, symlink-out-of-root → all refused
- binary file refused; large file truncated at cap
- cache hit/miss with mtime change

## Acceptance criteria

- [ ] `npm test`, `npx tsc --noEmit` green
- [ ] Run manually against this repo: `tsx -e "import {buildProjectBrief} from './src/context/brief'"` (or a tiny script) prints a tree + seed that looks right and caches

## Out of scope

Anything LLM or browser. `brain/agent.ts` wiring of the tool is Task 03.