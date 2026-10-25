# Task 06 — Captions source (M1 completion)

Turn Meet's live captions into a stream of finalized `TranscriptLine`s. Read `REQUIREMENTS.md`
FR-2 + risk table ("Meet DOM changes" / "captions lag"), `PLAN.md` § 0 research: tiered
selectors + finalization are the two load-bearing ideas, sourced from the gmeetcaptions /
hermes-agent / openhuman references.

## Spec

### `captions/selectors.ts` — the single module where caption DOM strings live

Tiered, tried in order, all three tiers defined here, all overridable from config for quick
repairs without code:

1. **Semantic (most stable)**: region `[role="region"][aria-label="Captions"]` (localized
   labels: check `aria-label` falls back among "Captions"/"Sous-titres"/"字幕" only if a
   `captions.ariaLabels` config list is set — default assumes en-US per REQUIREMENTS § 9).
2. **`jsname` tier**: container `div[jsname="tgaKEf"]`, legacy `div[jsname="YSxPC"]` — keep
   BOTH (Meet rolls these back and forth).
3. **Heuristic**: `[aria-live]` + `[role="region"]` candidates scored by containing
   plausible-avatar `img[alt]` nodes and `[data-self-name]` descendants; reject toolbar chrome.

### `captions/source.ts` — attach in page, drain from Node

1. **Enable captions** (FR-2 "bot turns captions on itself"): preferred = dispatch a synthetic
   keyboard `c` keypress on the document (reliable across Meet UI variants, per hermes-agent);
   fallback = locate the CC toggle button by aria-label. If neither works → log warning,
   continue silently (FR-2 explicit fallback behavior), return `{ captionsOn: false }`.
2. **Observer in page context** (`page.evaluateOnNewDocument` or inject after join): a
   `MutationObserver` on the captions container. Pattern from hermes-agent: observer pushes
   raw row snapshots into a global drain queue `window.__mbCaptions`; Node polls
   `window.__mbCaptions` every 250ms and clears it. Rows carry: speaker element text/avatar
   alt, text, the row's stable-ish identity (data attr or childKey hash).
3. **Speaker attribution, best-available in order** (FR-2): `img[alt]` on the row (filter
   Material icon ligatures — snake_case alts like `mic_off`/`closed_caption_off` are icons,
   not names); leading short non-empty `<span>` = speaker, remainder = text (Meet concatenates
   speaker+text with no separator — strip the prefix, keep only if the span is short, e.g.
   ≤ 32 chars, else treat whole thing as text with `speaker: "unknown"`); `[data-self-name]`
   marks the local user.
4. **Finalization**: caption text mutates mid-sentence. A line is FINAL when its text is
   unchanged for `wake.finalize_ms` (default 1500ms) OR a different speaker's row begins.
   Emit only finalized lines (detector consumes finalized lines per Task 04's contract), with
   `ts` = first-stable-time. Finalization state machine = pure, unit-tested.
5. **Self-tagging**: finalized line whose speaker ≈ `config.bot_name` (or whose arrival
   overlaps the speaking window — orchestrator calls `setSpeaking`) → `is_self: true`
   (FR-6: excluded from wake + context).

### Wire to transcript + detector (light glue only; orchestrator still Task 08)

Provide `attachCaptions(page, config, sink: (line) => void)` and stop().

## Tests (vitest)

- Finalization state machine as pure unit tests with synthetic mutation timelines
  (line grows → stable → final; speaker switch cuts immediately)
- Speaker extraction from four fixture HTML rows (each tier one) — full HTML fixtures in
  `tests/fixtures/captions/*.html` parsed with jsdom or a light parse
- Icon-ligature filtering, prefix-strip threshold
- Tiered selector resolution against fixture HTML for all three tiers

## Manual verification (owner, `--headed` rehearse call)

Captions auto-enable; your spoken sentences appear in `~/.meetings-bot/logs` as finalized
lines with your name; a mention ("hey assistant what's the auth flow") surfaces once as a
WakeEvent via the Task 04 echo path — no false fire on ordinary speech.

## Acceptance criteria

- [ ] `npm test`, `npx tsc --noEmit` green
- [ ] Manual verification recorded

## Out of scope

Speaking (07), orchestrator (08), WebRTC fallback STT — that's v1.1, interface reserved only.