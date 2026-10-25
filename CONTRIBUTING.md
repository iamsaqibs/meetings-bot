# Contributing

Meet's DOM strings live in one module each. If a control moves, patch that file and re-run with `--headed`.

| What changed | Edit only |
|---|---|
| Green room, join, leave banner | `src/auth/selectors.ts` |
| Captions | `src/captions/selectors.ts` |
| Microphone mute while speaking | `src/speaker/selectors.ts` |
| In-meeting chat fallback | `src/agent/chatChannel.ts` |

Behavior is specified in [REQUIREMENTS.md](REQUIREMENTS.md). The locked stack and file layout are in [PLAN.md](PLAN.md). Build steps are in [tasks/README.md](tasks/README.md).

Runtime state stays in `~/.meetings-bot/` (or `$MEETINGS_BOT_HOME`). Do not commit that directory, `dist/`, or logs.
