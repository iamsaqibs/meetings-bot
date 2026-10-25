# meetings-bot

A shadow assistant that joins a Google Meet next to you, stays muted, and speaks only when someone addresses it by name. Answers come from the project directory you pass in. When the call ends it writes a transcript and notes beside that project.

Behavior: [REQUIREMENTS.md](REQUIREMENTS.md). Stack and layout: [PLAN.md](PLAN.md). How it was built: [tasks/README.md](tasks/README.md). Where Meet selectors live: [CONTRIBUTING.md](CONTRIBUTING.md).

## Prerequisites

- Node.js 22 or newer
- [Ollama](https://ollama.com) running locally, signed in with `ollama signin` (cloud models). Check with `curl http://localhost:11434/v1/models`
- A model that can call tools and stream. PLAN § 4 lists current candidates (`gpt-oss:120b-cloud`, `glm-5.3-flash:cloud`, and other flash-tier tool models). Cloud models retire; if a call returns HTTP 410, pick another tag and put it in `ollama.model`
- A dedicated Google account whose display name is the wake name, for example `Saqib's Assistant`. The bot does not type a name during join; Meet shows the account name
- macOS `afconvert` if you switch TTS to Edge (it ships with macOS)

## Setup

```bash
npm install
npm run build
meetings-bot config          # writes ~/.meetings-bot/config.yaml and opens $EDITOR
meetings-bot auth            # headful Chrome, sign in once, including 2FA
```

Replace the `CHANGE ME` placeholders before a real meeting: `wake_names`, `bot_name`, and `ollama.model`. `bot_name` should match the Google account's display name.

Override the runtime directory with `$MEETINGS_BOT_HOME` if you do not want `~/.meetings-bot`.

## Commands

```bash
meetings-bot join --meeting <url> --project <dir> [--headed] [--name <name>] [--model <tag>]
meetings-bot rehearse --meeting <url> --project <dir> [--headed] [--name <name>] [--model <tag>]
meetings-bot echo <transcript.jsonl> [--fast] [--project <dir>] [--model <tag>]
meetings-bot auth [--profile <dir>]
meetings-bot config
meetings-bot --help
meetings-bot --version
```

`rehearse` is the same loop as `join`, with one clarifying question allowed and `limits.max_reply_words` doubled. It logs why each caption line did or did not wake the bot.

`echo` replays a JSONL transcript with no browser. Timestamps play at real speed; `--fast` is ten times quicker. `MOCK_BRAIN=1` prints canned answers so CI does not call Ollama.

```bash
MOCK_BRAIN=1 meetings-bot echo tests/fixtures/transcripts/meeting.jsonl --fast
```

Ctrl+C during `join` or `rehearse` closes the browser, writes partial notes, and exits 130.

## Config

File: `~/.meetings-bot/config.yaml`. Arrays replace on merge. Anything you omit keeps the default, except `wake_names`, `bot_name`, and `ollama.model`, which are required.

| Field | Default | Role |
|---|---|---|
| `wake_names` | required | Names that address the bot. Word boundaries, so "assistant" does not match "assistance" |
| `bot_name` | required | Display name. Also used to ignore the bot's own captions |
| `ollama.base_url` | `http://localhost:11434/v1` | Local Ollama OpenAI-compatible API |
| `ollama.model` | required | Cloud model tag. See PLAN § 4 |
| `ollama.temperature` | `0.3` | Reply temperature |
| `ollama.max_context_tokens` | `24000` | Sliding window for the brief plus transcript |
| `tts.provider` | `kokoro` | `kokoro` (local) or `edge` (unofficial Microsoft cloud) |
| `tts.voice` | `af_heart` | Kokoro English voices look like `af_heart`. Edge uses a Microsoft voice id |
| `tts.gain` | `1` | Playback gain into the Meet mic. Values above 1 are clipped |
| `limits.max_reply_words` | `150` | Spoken reply cap, cut on a sentence boundary when possible |
| `limits.max_replies` | `15` | Wake replies per meeting |
| `limits.max_talk_seconds` | `600` | Spoken audio per meeting, measured from playback |
| `wake.allow_clarify` | `true` | One "was that meant for me?" per meeting. Rehearse forces this on |
| `wake.finalize_ms` | `1500` | How long a caption line must stay unchanged before it is final |
| `defer_phrases` | estimate, approval, would saqib prefer, saqib's schedule, budget, sign-off, timeline commitment | Questions that get the deference sentence and nothing else |
| `meet.idle_timeout_minutes` | `8` | No finalized captions for this long and the meeting is treated as over |
| `captions.ariaLabels` | `["Captions"]` | Extra aria-labels for the captions region if Meet renames it |

A commitment, estimate, approval, schedule, or "would Saqib prefer" question is answered with: "That's better answered by Saqib himself — over to you."

## First real meeting checklist

Owner checkpoints A and B have not been confirmed yet. Run this once in a solo Meet before inviting anyone else.

1. Create the dedicated Google account. Set its display name to the wake name (`bot_name`).
2. `meetings-bot config` and replace every `CHANGE ME` value. Set `ollama.model` to a tag `curl http://localhost:11434/v1/models` actually returns.
3. `meetings-bot auth`. Finish sign-in and 2FA in the window that opens. The command should print that the session was saved.
4. Open a Meet URL in your own browser and stay in the call. Then:
   `meetings-bot join --meeting <url> --project . --headed`
   Admit the bot. It should appear as the dedicated account, camera off, microphone muted.
5. Captions turn on by themselves. Your sentences show up as finalized lines (speaker = your Meet name) under `<project>/meeting-notes/.raw/`. Ordinary speech that does not address the bot stays silent.
6. Say "hey assistant, are you there?" (use your real wake name). The bot unmutes, you hear a short answer in the call, then it mutes again. While it is talking, its own captions must not make it reply to itself.
7. Ask something that is not in the project. It should say it does not have that, and the question should land in the notes follow-ups. Ask a budget or approval question. It should defer to you in one sentence.
8. Leave the Meet, or press Ctrl+C. Ctrl+C exits 130 and the notes heading includes `(partial — meeting ended unexpectedly)`. A normal leave writes full notes: `meeting-notes/NNN-YYYY-MM-DD-<slug>.md` plus `.raw/NNN-transcript.jsonl`.
9. Optional voice check, no Meet required:
   `MEETINGS_BOT_LIVE=1 npm test` synthesizes a short Kokoro clip. If it sounds wrong, change `tts.voice`.

When those steps match what you saw, the pilot is done. A later DOM break is a one-file selector fix (see CONTRIBUTING).

## Troubleshooting

- **No saved Google session.** Run `meetings-bot auth` and finish 2FA. Join refuses to start until that profile has cookies.
- **`MeetDomChangedError`.** Meet renamed a control. Re-run with `--headed`, see which step failed, and patch the single module named in the error (`auth/selectors.ts`, `captions/selectors.ts`, `speaker/selectors.ts`, or `agent/chatChannel.ts`). `captions.ariaLabels` covers a renamed captions region without a code change.
- **Ollama is down, or a model returns 410.** The process exits with a sentence that points at `ollama signin` and PLAN § 4. Retired cloud models are not retried.
- **The first reply is slow.** Kokoro compiles on first use. The meeting warms it up before join. A reply that still takes more than 10s is logged as `slow_reply` with brain and TTS times.
- **You wanted to answer that yourself.** Add a phrase under `defer_phrases`, or ask in a way that already matches the list (budget, approval, schedule, estimate). The bot will hand it back in one sentence.
- **No audio in the call.** TTS failure posts the full answer in Meet chat and stays on chat for the rest of the meeting. Edge TTS needs `afconvert`. Kokoro only speaks English voices (`af_heart` and the other `a*` / `b*` English ids).

## Known limitations

- Captions and Kokoro speech are English-only.
- Edge TTS uses an unofficial Microsoft endpoint. Only `tts.voice` is exposed; rate and pitch stay at the service default.
- Google can change Meet's DOM at any time. Selectors are isolated so one module is the fix.
- The bot never speaks unless a wake event fired, never repeats a line verbatim, never invents a project fact, and never commits on your behalf. Those are the meeting rules, not optional polish.
- v1 does not join Teams or Zoom, does not edit the project, and does not record video.

## Develop

```bash
npm test
npm run build
npx tsc --noEmit
```

Live Kokoro and Ollama checks stay skipped unless `MEETINGS_BOT_LIVE=1`. `MOCK_BRAIN=1` keeps echo on the fixture deterministic.
