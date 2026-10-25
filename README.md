# meetings-bot

## Status: building — see tasks/

## Manual verification

### Task 05 (owner — not run yet)

1. `meetings-bot auth` → sign into the dedicated account (once).
2. Create a Meet URL, open it in your own browser, keep it, then run:
   `meetings-bot join --meeting <url> --project . --headed`
   The bot appears as the named account, camera off, mic muted, and sits in the lobby until you admit it.
3. Kill with Ctrl+C — browser closes, no crash, exit code 0.
