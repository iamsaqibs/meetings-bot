# Task 07 — TTS providers + speaker injector (M3)

Get the bot's voice into the meeting. Read `REQUIREMENTS.md` FR-6 + FR-10, § 9.1 decision
(default = Kokoro, Edge-TTS second), risk table row "Bot hears itself", and `PLAN.md` § 0.3
(getUserMedia override is THE pattern; AGC/AEC pitfalls) and § 2.3 (streaming pipeline).

## Spec

### `tts/provider.ts` — contract (stub exists)

`TtsProvider.synthesize(text) -> { pcm: Int16Array, sampleRate }` (PLAN § 5: providers return
raw PCM; AudioContext resamples at the webRTC boundary — 24kHz Kokoro → any is fine).
Factory `createTtsProvider(config)`.

### `tts/kokoro.ts` — default provider

- `KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "q8", device: "cpu" })`.
- Lazy-load on first synthesize; cache the instance process-wide; warm up once at orchestrator
  start (first-call latency ~1s otherwise — REHEARSE the warmup, don't let it happen mid-meeting).
- **Sentence-split before synthesis** (`TextSplitterStream`), so the orchestrator (Task 08) can
  render sentence-by-sentence behind playback — the latency pipeline depends on it. Provide
  `synthesizeStream(text): AsyncGenerator<{ pcm, sampleRate }>` yielding per sentence.
- Voice: `config.tts.voice` (default `af_heart`). Refuse non-English voice configs with a
  clear message (kokoro-js phonemization is English-only — RESEARCH note).

### `tts/edge.ts` — second provider (behind config.tts.provider)

`msedge-tts` → decode to Int16 PCM at whatever rate it returns; document that this provider
is cloud + unofficial (PLAN § 1). Include a 3s-timeout + one retry; failure → typed error the
orchestrator turns into the FR-10 chat fallback. Note Edge voices accept rate/pitch params —
expose only `config.tts.voice` for them.

### `speaker/injector.ts` — the audio bridge (the delicate part)

1. **`installAudioBridge(page, config)`** — `evaluateOnNewDocument`, BEFORE Meet scripts:
   override `navigator.mediaDevices.getUserMedia` so Meet's mic request returns a stream from
   `new AudioContext().createMediaStreamDestination()` (pattern: meeting-assistant). Keep the
   AudioContext global (`window.__mbAudio`), keep it alive with a silent looping buffer
   keepalive (Proton's Safari-throttle trick — cheap insurance for headless tab policies).
   Fake-device flag from Task 05 remains the harmless fallback for permission flows.
2. **`window.__mbSpeak(pcm: number[], sampleRate, gain)`** — decode to Float32, resample via
   `new AudioBuffer` at the context rate, `AudioBufferSourceNode → GainNode(gain) →
   destination`, start; resolve the promise when `ended` fires. Gain: AGC defeat knob
   (config `tts.gain`, default 1.0; if colleagues hear it quiet, raise; research notes Chrome
   APM can attenuate injected audio even with flags off — set flags from Task 05).
3. **Mute policy** (REQUIREMENTS FR-6 + PLAN § 5 amendment): idle = Meet UI mic button muted
   — participants see true state. Speaking = click unmute → wait ~200ms → play → re-mute
   ("re-mute" per FR-6). Buttons live in `speaker/selectors.ts` (mic toggle aria-labels),
   fallback = `track.enabled` toggling on the sender if UI button can't be found (log which
   path ran). All under `speakSequence(pages of audio)` with a lock: TTS during wake-processing
   must NEVER overlap (one reply per wake event, FR-7).
4. **Self-caption window**: `setSpeaking(true)` at unmute, `false` at re-mute — feeds the
   transcript self-tagging from Task 06 (the "Bot hears itself" risk row).

## Tests (vitest)

- kokoro + edge synthesize on a fixture sentence when `MEETINGS_BOT_LIVE=1` (skipped otherwise;
  run once locally by hand)
- injector: unit-test the injected script's `__mbSpeak` math (pcm→Float32→buffers) in isolation
  with a pure helper — the browser parts verify manually
- provider factory dispatch + unknown provider error
- sentence splitter: 4 sentences → 4 yields; mid-sentence long clause handled

## Manual verification (owner, rehearse meeting from Task 05 steps)

1. Bot joins muted. Say "hey assistant, are you there?" → bot unmutes, you hear a spoken
   answer in the call, re-mutes.
2. Its OWN captions (`is_self: true`) never trigger a reply (say its name back at it while it
   speaks).
3. `npx tsx -e` spot-check: kokoro renders a sentence to a wav file — listen to the file if
   quality feels off, tune `tts.voice`.

## Acceptance criteria

- [ ] `npm test`, `npx tsc --noEmit` green
- [ ] Manual verification recorded (speak + mute/unmute cycle + no self-trigger)

## Out of scope

Wake/brain wiring (08), chat fallback implementation (08; edge provider just must throw typed errors).