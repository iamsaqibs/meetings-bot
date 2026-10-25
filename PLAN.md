# Meetings Bot — Technical Plan

> Companion to `REQUIREMENTS.md`. This document locks the tech stack, resolves the research
> questions, corrects a few assumptions the requirements made, and defines the data contracts.
> The buildable work is broken into Cursor-ready prompts in [`tasks/`](./tasks/README.md).

---

## 0. Verdict on feasibility (research summary, Oct 2026)

Every risky assumption in `REQUIREMENTS.md` was validated against current reference
implementations. Three findings materially change the plan:

1. **Google blocks automated logins headless.** Stealth plugins alone no longer suffice.
   Current best practice (see recallai/google-meet-meeting-bot, Dec 2025) is a hybrid:
   do the *one-time* login **headful** in a real-Chrome profile, then run the bot
   **headless reusing that persistent profile**. → We add a `meetings-bot auth` command
   (not in the original §5 interface list — this is the plan's only interface addition).
2. **Captions DOM is unstable; it must be a tiered-selector abstraction.** Community
   implementations converged on: semantic ARIA selectors first (`[role="region"][aria-label="Captions"]`),
   `jsname` fallbacks, then heuristic spans. Caption text mutates mid-sentence → line
   *finalization* detection is a first-class concept, not an afterthought. Toggling captions
   by dispatching a synthetic `c` keypress is more reliable than locating the CC button.
3. **Audio injection is a solved pattern** (CoderOMaster/meeting-assistant, samuelrms/meet-bot):
   override `navigator.mediaDevices.getUserMedia` in a Puppeteer init script so Meet's "mic"
   is a JS `AudioContext.createMediaStreamDestination()` stream; schedule decoded TTS buffers
   into it; no OS virtual audio device, no real microphone, works fully headless. Two
   pitfalls to encode in the plan: Chrome's audio processing (AGC/noise suppression) must be
   disabled via flags + a programmatic gain boost, and the mic must be UI-muted while idle
   so participants never hear artifacts.

Confirmed as-feasible: polling captions DOM (FR-2), Ollama cloud through the local daemon
with tool calling (FR-4/FR-5 — `/v1/chat/completions` supports tools; sign-in once via
`ollama signin`), Piper/Kokoro/Edge-TTS latency (§ FR-6), and the ≤10s wake→speech budget
(see § 5 latency ledger).

Sources are catalogued in § 9.

---

## 1. Tech stack (locked)

| Layer | Choice | Why |
|---|---|---|
| Runtime | **Node.js ≥ 22 (LTS), TypeScript 5.x, ESM** | Puppeteer is a Node lib; TS catches selector/context typos; ESM matches puppeteer ≥ 22 |
| Browser automation | **Puppeteer + `puppeteer-extra` + `puppeteer-extra-plugin-stealth`** | Required by FR-1; stealth plugin is standard for Meet automation; pinned bundled Chromium |
| CLI | **`commander`** | § 5 commands map 1:1 to subcommands; trivial help/UX |
| Config | **`yaml` + `zod`** | § 5 config.yaml; zod gives typed schema + friendly validation errors |
| Logging | **`pino` (pretty in dev)** | Structured, fast, cheap to grep |
| Tests | **`vitest`** | Fast, TS-native; echo-mode integration tests run on CI without a browser or daemon |
| Transcript storage | **Append-only JSONL + `fs.fsync`** | FR "crash-safe transcript: append-per-line, fsync per line" |
| Project digest | **`fast-glob` + `ignore`** | FR-5 tree; `ignore` implements real .gitignore semantics |
| LLM client | **Plain `fetch` against `http://localhost:11434/v1`** | Ollama's OpenAI-compatible endpoint supports tools + streaming; no SDK dependency to go stale |
| TTS #1 (default) | **`kokoro-js` (Kokoro-82M, q8 ONNX, CPU)** | Best *local* quality (voice `af_heart` graded A); ~0.9–1.3s to first sentence; Apache-2.0; ~92MB |
| TTS #2 (optional) | **`msedge-tts` (Edge-TTS)** | Free Microsoft neural voices, best quality overall, ~1.2s latency; unofficial API — kept behind the provider interface |
| LLM models | **Any Ollama `*-cloud` model with tool calling**; default in config | Owner has an Ollama subscription; see § 4 for picking a model |

Package versions: install latest stable at scaffold time and pin them in `package.json`
(the exact majors drift; the *contract* above is what's locked).

Out of scope on purpose: Python (no reason to add a second runtime), Playwright (Puppeteer
mandated), any cloud STT (captions replace it in v1).

---

## 2. Architecture

### 2.1 Module graph

```
bin/meetings-bot.ts (commander)
 ├─ config/          schema.ts · load.ts        zod-validated ~/.meetings-bot/config.yaml
 ├─ auth/            joiner.ts · session.ts     headful login once → persistent profile dir
 ├─ captions/        source.ts                  in-page MutationObserver + drain → CaptionLine stream
 ├─ transcript/      types.ts · store.ts        JSONL append + fsync, speaker tagging, self-exclusion
 ├─ context/         brief.ts · reader.ts       brief builder (gitignore-aware) + read_file tool impl
 ├─ brain/           ollama.ts · agent.ts       /v1 chat streaming + tool-call loop + retries
 ├─ wake/            detector.ts                lexical gate → LLM gate → WakeEvent
 ├─ tts/             provider.ts · kokoro.ts · edge.ts
 ├─ speaker/         injector.ts                getUserMedia override + AudioBuffer playback + mute mgmt
 ├─ agent/           orchestrator.ts            the meeting loop wiring everything
 ├─ notes/           summarizer.ts · writer.ts  transcript → decisions/actions → NNN-*.md
 ├─ lifecycle/       leave.ts · signals.ts      meeting-end detection, SIGINT, partial-notes rescue
 └─ logging/logger.ts
commands: join · auth · rehearse · echo · config
```

**Rule encoded everywhere:** anything that talks to Meet's DOM goes through one seam
(`captions/source.ts` selectors, `speaker/injector.ts` mute buttons, `auth/joiner.ts`
navigation). FR's "DOM selector changes = single module to patch" is enforced by keeping
all `jsname`-style strings in one constants file per module.

### 2.2 The meeting loop (orchestrator)

```
join → [lobby wait] → admitted → enable captions (synthetic 'c') → attach CaptionSource
  │
  ├─ caption line finalized ──► wake detector
  │      ◄─ WakeEvent? ──► rate-limit check (FR-7, hard rule 5)
  │                └────► brain: system prompt(persona + brief + transcript excerpt)
  │                        ├─ may call read_file (tool loop, FR-5)
  │                        └─ streams answer ──► tts → speaker.play() (unmute→speak→mute)
  │                                          └─ tag self lines; on audio failure → Meet chat (FR-10)
  │
  ├─ every finalized line ──► transcript.store (fsync per line)
  ├─ meeting-end banner / idle timeout / SIGINT ──► stop loop
  └─► notes.summarizer → notes.writer → meeting-notes/NNN-*.md + .raw/NNN-transcript.jsonl
```

### 2.3 Latency pipeline (the ≤10s budget, FR non-functional)

The naive path (captions finalize → full LLM answer → full TTS render → play) misses the
budget on every stage. The pipeline is therefore **streaming, sentence-granular**:

```
LLM stream ──► sentence splitter ──► TTS render sentence k ──► playback queue (FIFO)
     │             (while sentence k-1 is playing)
```

Ledger (worst-case, measured from the researched implementations):

| Stage | Cost | Basis |
|---|---|---|
| Caption finalization lag | 1.5–3s | caption text stabilizes a beat behind speech; `finalize_ms` config |
| Wake gate | 0–1s | lexical gate is free; LLM gate only when ambiguous |
| LLM first sentence | 2–4s | streaming; flash-tier cloud models |
| Kokoro first sentence | ~1.3s | researched benchmark (M-series CPU) |
| Injection + unmute | <0.3s | UI button click + buffer scheduling |
| **Total** | **~5–9s** | ✓ within the 10s budget |

If Kokoro first-sentence latency ever becomes the bottleneck, flip `tts.provider: edge`
(1.2s, sometimes slower cold) or add Piper (~0.4s, robotic) — the provider interface makes
this a config change, not a code change.

---

## 3. Data contracts

### 3.1 Transcript JSONL (`meeting-notes/.raw/NNN-transcript.jsonl`)

```json
{"ts":"2026-10-25T13:05:22.105Z","speaker":"Aadil","text":"hey assistant, what's the auth flow?","is_self":false,"source":"caption"}
{"ts":"2026-10-25T13:05:31.480Z","speaker":"Saqib's Assistant","text":"The auth flow is cookie-session based. I can walk through the middleware in the notes.","is_self":true,"source":"tts"}
```

- `ts` — ISO-8601, per finalized line.
- `speaker` — best-available attribution from the captions DOM (§ 3 research: avatar `img[alt]`,
  leading short span, `[data-self-name]`); `"unknown"` never `"me"` unless matched.
- `is_self` — true when speaker matches the wake/display name **or** the line arrived while
  `speaker.play()` was active. Excluded from wake detection and LLM context (FR-6, risk table).
- Written append-per-line with fsync (crash-safe requirement).

### 3.2 Wake event (internal)

```ts
interface WakeEvent { ts: string; asker?: string; question: string; contextLines: TranscriptLine[]; clarifyUsed?: boolean }
```

### 3.3 `~/.meetings-bot/config.yaml` (zod-validated; § 5 superset)

```yaml
wake_names: ["assistant", "saqib's assistant"]   # lowercase, matched on transcript text
bot_name: "Saqib's Assistant"                    # echo display + self-line matching

ollama:
  base_url: "http://localhost:11434/v1"
  model: "gpt-oss:120b-cloud"        # any tool-capable *-cloud model; see § 4
  temperature: 0.3
  max_context_tokens: 24000          # FR-4 hard cap, sliding window

tts:
  provider: "kokoro"                 # "kokoro" | "edge"
  voice: "af_heart"                  # kokoro voice ids; edge voice like "en-US-AndrewMultilingualNeural"
  gain: 1.0                          # programmatic boost to defeat Chrome AGC (start ~2.0)

limits:
  max_reply_words: 150               # FR-7
  max_replies: 15                    # hard rule 5
  max_talk_seconds: 600

wake:
  allow_clarify: true                # FR-3, at most one clarifying line per ambiguity
  finalize_ms: 1500                  # caption line stabilization window

defer_phrases:                        # FR-8 seed list; an LLM defer-gate runs alongside
  ["estimate", "approval", "would saqib prefer", "saqib's schedule", "budget", "sign-off", "timeline commitment"]

meet:
  idle_timeout_minutes: 8            # no finalized captions for N min → treat as ended
```

### 3.4 Notes file (`<project>/meeting-notes/NNN-YYYY-MM-DD-<slug>.md`)

Sections (FR-9): **Summary**, **Decisions**, **Action items** (owner from caption attribution),
**Q&A log** (each wake event: timestamp, asker, question → answer). NNN = max existing + 1,
0-padded to 3. Summary/decisions come from one LLM summarization pass over the transcript with
the *same* defer discipline (never invent facts; unknown owner → `"owner: unattributed"`).

---

## 4. Prerequisites (owner actions before their task)

1. **Node 22+** — `node --version`.
2. **Ollama signed in** — `ollama signin` (browser flow, credentials land in macOS Keychain).
   Verify: `curl http://localhost:11434/v1/models` returns cloud models.
3. **Pick the brain model.** Requirements: tool calling + streaming + fast enough first
   token. Candidates seen on Ollama's tool-capable listing (Oct 2026 — verify, Ollama retires
   cloud models periodically): `gpt-oss:120b-cloud`, `beam` (free), `glm-5.3-flash:cloud`,
   `deepseek-v4.1-flash:cloud`, `minimax-m3.1-flash:cloud`. Check `ollama.com/search?c=tools`.
   Default `gpt-oss:120b-cloud` is the documented safe pick; a flash-tier model is the speed pick.
4. **Dedicated Google account** — create it, display name = the wake name (e.g., "Saqib's
   Assistant"), so Meet renders the bot's name without any name-typing step (FR-1 relies on
   this; do **not** add an in-join rename flow in v1).

---

## 5. Amendments to REQUIREMENTS.md (plan-level, flagged)

- **Add `meetings-bot auth`** to § 5's command list: one-time headful login into the
  persistent profile (`~/.meetings-bot/profile`), reusing real-Chrome + stealth; the bot
  itself stays headless on that profile. Reason: Google now blocks automated headless logins.
- **§ FR-6 sample-rate note:** Kokoro renders 24kHz internally; target stays "16 kHz mono PCM"
  at the WebRTC boundary — the AudioContext in `speaker/injector.ts` handles resample, so the
  provider contract is simply `{ pcm: Int16Array, sampleRate: number }`.
- **Mute policy precision:** "muted when idle" is enforced at the *Meet UI* mic button
  (participants see the true state), with `track.enabled` toggling as the programmatic
  fallback. Both live behind `speaker/injector.ts`.
- **Leave detection adds an idle timeout** (no finalized captions for `meet.idle_timeout_minutes`)
  because a silently-ended meeting may never show a banner in the bot's viewport.

Everything else in REQUIREMENTS.md stands as written. Requirements doc is the source of truth
for *what*; this file is the source of truth for *how*.

---

## 6. Build order → Cursor tasks

| Task | File | Requirement milestone |
|---|---|---|
| 00 Scaffold | `tasks/00-scaffold.md` | pre-M1 |
| 01 Config | `tasks/01-config.md` | pre-M1 |
| 02 Context brief | `tasks/02-context-brief.md` | M4 (built early: pure Node, zero browser risk) |
| 03 LLM brain | `tasks/03-llm-brain.md` | M2 |
| 04 Transcript + wake detector | `tasks/04-transcript-wake.md` | M2 (echo-mode CI core) |
| 05 Auth + joiner | `tasks/05-auth-joiner.md` | M1 (highest real-world risk, isolated) |
| 06 Captions source | `tasks/06-captions.md` | M1 completion |
| 07 TTS + speaker injector | `tasks/07-tts-speaker.md` | M3 |
| 08 Live orchestrator | `tasks/08-orchestrator.md` | M3/M5 integration |
| 09 Notes + lifecycle | `tasks/09-notes-lifecycle.md` | M5 |
| 10 Rehearse/echo/polish | `tasks/10-rehearse-polish.md` | M5 |

Do them in order; each prompt is self-contained (context refs, spec, acceptance criteria,
verification). Pure-Node tasks (02, 03, 04) are fully testable in vitest; browser tasks carry
manual verification steps for `--headed` / `rehearse` runs.

---

## 9. Research sources

- Meet automation + login reality check: [google-meet-meeting-bot PR #2 (recallai)](https://github.com/recallai/google-meet-meeting-bot/pull/2),
  [Google-Meet-Scheduler](https://github.com/amanraj1608/google-meet-scheduler/),
  [meet-bot (AndBroCorp)](https://github.com/AndBroCorp/meet-bot)
- Captions DOM strategy: [gmeetcaptions bookmarklet (sanand0/tools)](https://github.com/sanand0/tools/blob/main/gmeetcaptions/README.md),
  [hermes-agent meet_bot.py](https://github.com/NousResearch/hermes-agent/blob/HEAD/plugins/google_meet/meet_bot.py),
  [s-anand.net — Meet captions transcript recorder](https://www.s-anand.net/blog/google-meet-captions-local-transcript-recorder/),
  [openhuman caption handling commit](https://github.com/senamakel/openhuman/commit/f72de99d254c7dbdba138f606e00ae0b27f410f9)
- Audio injection: [meeting-assistant (CoderOMaster)](https://github.com/CoderOMaster/meeting-assistant),
  [hermes-agent audio_bridge.py](https://github.com/NousResearch/hermes-agent/blob/HEAD/plugins/google_meet/audio_bridge.py),
  [samuelrms/meet-bot ARCHITECTURE + noise-suppression PR](https://github.com/samuelrms/meet-bot/pull/2)
- Ollama cloud + tools: [Tool calling docs](https://docs.ollama.com/capabilities/tool-calling),
  [OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility), [Cloud docs](https://docs.ollama.com/cloud),
  [ollama signin](https://www.mintlify.com/ollama/ollama/cli/signin), [Cloud models blog](https://ollama.com/blog/cloud-models)
- TTS benchmarks: [kokoro.js README](https://github.com/hexgrad/kokoro/blob/main/kokoro.js/README.md),
  [Kokoro-82M-ONIX model card](https://huggingface.co/onnx-community/Kokoro-82M-ONNX/blob/main/README.md),
  [Micdrop — local TTS in Node](https://micdrop.dev/blog/local-tts-node-kokoro-vs-piper),
  [Piper/Edge-TTS comparison](https://dev.to/tony_make_5eb96ab94641071/how-i-built-an-offline-tts-system-with-piper-tts-and-edge-tts-1c80)