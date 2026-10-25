# Task 05 — Auth (one-time headful login) + headless joiner (M1, highest-risk task)

Google Meet automation start-to-finish. Read `REQUIREMENTS.md` FR-1, risk table, `PLAN.md`
§ 0 (login reality check: automated headless logins are blocked — that's why this task is
split) and § 6 (task table row 05).

## Spec

### `auth/session.ts` — persistent-profile management

1. Profile lives at `~/.meetings-bot/profile` (Task 01's home; `--profile` flag overrides).
2. `profileExists()` — heuristic: `Cookies` file present and >0 bytes.

### `auth/joiner.ts` — `launchBrowser(mode)` + `joinMeeting(page, meetingUrl, options)`

1. **`meetings-bot auth [--profile <dir>]`** — launches **headful** real-Chrome
   (`executablePath` from system Chrome via puppeteer's `launch({ headless: false })` on the
   dedicated profile; `puppeteer-extra` + stealth plugin active), navigates
   `accounts.google.com/signin`, and hands the session to the human: they log in to the
   **dedicated** account and clear any 2FA. Prints "waiting for sign-in complete…", polls the
   page for the account to be signed in (avatar present on the accounts/myaccount page),
   saves nothing beyond the profile dir (cookies are the profile). Verify-after: re-open the
   same profile headless and confirm the session survives.
   This command is the mitigation for the risk "Google flags the automated account" — the
   bot itself NEVER does headless logins (REQUIREMENTS security note).
2. **`join --meeting <url> --project <dir>` wiring (browser parts here; loop wiring is Task 08)**:
   - Launch headless (`headless: true`) on the persistent profile, stealth plugin, args:
     `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream` (auto-grant + fake
     device so permission prompts and mic absence never block join — Task 07 replaces the
     audio source properly),
     `--disable-features=WebRtcApmInAudioService,ChromeWideEchoCancellation`
     (AGC/ECC mangles injected audio, per PLAN § 0.3),
     `--autoplay-policy=no-user-gesture-required`, `--no-first-run`, `--no-default-browser-check`,
     `--lang=en-US`, and a UA that keeps desktop Chrome semantics (headless UA string minus
     "HeadlessChrome" is standard for Meet).
   - Navigate → detect the join surface: pre-join card ("Ask to join"/"Join now"/greenroom).
     Human-paced join: ~2–5s deliberate delay before clicking "Join now" (risk mitigation —
     never machine-speed click).
   - Camera off, mic muted **before** clicking join: toggle both greenroom controls if their
     state shows on (aria-labels localized en-US: "camera"/"microphone" toggle buttons —
     encapsulate every such string in `auth/selectors.ts`, the ONLY file with Meet DOM strings
     outside captions/speaker).
   - Lobby handling (FR-1): after "Ask to join", wait for admission — poll participant count /
     self-entry into the participant list — timeout 120s with clear state logging ("waiting to
     be admitted by Saqib…"). 30s join budget per FR-1 applies from admit to in-call UI.
   - In-call readiness event: emit `{ joined: true, admittedAt }` for the orchestrator.
3. **Meeting-end primitives** (used by Task 09, implemented here where the DOM knowledge is):
   `isLeaveDetected(page)` — "You left the meeting" banner / in-call surfaces gone; expose
   via `lifecycle/leave.ts` interface stub.
4. Every step logs state transitions (navigated → greenroom → requested → admitted → in-call)
   via pino; on any DOM step that stops matching, throw a typed `MeetDomChangedError` with
   instructions: "run with --headed and inspect". REQUIREMENTS: `--headed` flag exists for
   exactly this debugging.

## Verification (manual, has to be done by the owner — put exact steps in README section "Manual verification")

1. `meetings-bot auth` → sign into the dedicated account (once).
2. Owner starts a Meet alone (`meetings-bot rehearse` arrives in Task 10; for now create a
   Meet URL, open it in your own browser, keep it, then run):
   `meetings-bot join --meeting <url> --project . --headed`
   → bot appears as the named account, camera off, mic muted, and sits in the lobby until you
   admit it.
3. Kill with Ctrl+C — browser closes, no crash, exit code 0.

## Tests (vitest)

- Pure parts only (arg parsing, profile-exists check, state machine unit tests with a fake
  page object). Browser reality is verified manually above — say so in the task README.

## Acceptance criteria

- [ ] tsc/test green; `join` refuses to run when `profileExists()` is false with remediation
      text pointing to `meetings-bot auth` (fail fast, never silently launches an anonymous browser)
- [ ] Manual verification above recorded passing

## Out of scope

Captions (Task 06), audio (Task 07), the meeting loop (Task 08).