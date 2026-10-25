import fs from "node:fs";
import { createRequire } from "node:module";
import type { PuppeteerExtra } from "puppeteer-extra";
import type { Browser, Page } from "puppeteer";

const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-extra") as PuppeteerExtra;
const bundledPuppeteer = require("puppeteer") as { executablePath: () => string };
const StealthPlugin = require("puppeteer-extra-plugin-stealth") as () => {
  _isPuppeteerExtraPlugin: boolean;
};
import { logger } from "../logging/logger.js";
import {
  ACCOUNT_AVATAR_HINT,
  ADMIT_WAIT_LOG,
  CAMERA_ON_LABEL,
  IN_CALL_LABELS,
  JOIN_LABELS,
  LEFT_MEETING_TEXT,
  MIC_ON_LABEL,
  SIGN_IN_URL,
  SIGNED_IN_URL_HINTS,
  type JoinLabel,
} from "./selectors.js";
import { assertProfile, profileDir } from "./session.js";

puppeteer.use(StealthPlugin());

export const JOIN_BROWSER_ARGS = [
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  "--disable-features=WebRtcApmInAudioService,ChromeWideEchoCancellation",
  "--autoplay-policy=no-user-gesture-required",
  "--no-first-run",
  "--no-default-browser-check",
  "--lang=en-US",
] as const;

export const DEFAULT_JOIN_PACE_MS = 3_000;

const DESKTOP_CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export class MeetDomChangedError extends Error {
  readonly moduleName = "auth/selectors.ts";

  constructor(step: string) {
    super(
      `Meet DOM changed during ${step}. Patch auth/selectors.ts. Run with --headed and inspect.`,
    );
    this.name = "MeetDomChangedError";
  }
}

export interface DomButton {
  label: string;
}

export interface PageSnapshot {
  url: string;
  buttons: DomButton[];
  bodyText: string;
  inCall: boolean;
  left: boolean;
  hasAvatar: boolean;
}

export interface Clock {
  now(): number;
  wait(ms: number): Promise<void>;
}

export interface MeetPage {
  goto(url: string): Promise<void>;
  snapshot(): Promise<PageSnapshot>;
  clickButton(label: string): Promise<void>;
}

export interface JoinOptions {
  displayName: string;
  joinPaceMs?: number;
  admitTimeoutMs?: number;
  greenroomTimeoutMs?: number;
  pollMs?: number;
  clock?: Clock;
}

export interface JoinResult {
  joined: true;
  admittedAt: string;
}

const realClock: Clock = {
  now: () => Date.now(),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export function desktopUserAgent(userAgent: string): string {
  return userAgent.replaceAll("HeadlessChrome", "Chrome");
}

const STABLE_CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** Prefer installed Google Chrome. Fall back to Puppeteer's Chrome for Testing. */
export function selectChromeTarget(
  exists: (path: string) => boolean,
  bundledPath: string | undefined,
  home = "",
): { channel: "chrome" } | { executablePath: string } {
  const candidates = [
    STABLE_CHROME_PATH,
    ...(home ? [`${home}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`] : []),
  ];
  if (candidates.some((candidate) => exists(candidate))) return { channel: "chrome" };
  if (bundledPath && exists(bundledPath)) return { executablePath: bundledPath };
  throw new Error(
    "Google Chrome is not installed. Install the stable Chrome app from https://www.google.com/chrome/ and run `meetings-bot auth` again.",
  );
}

export function launchPlan(mode: "auth" | "join", opts: { profileDir: string; headed?: boolean }) {
  const headed = mode === "auth" || opts.headed === true;
  return {
    headless: !headed,
    userDataDir: opts.profileDir,
    channel: "chrome" as const,
    args: mode === "join" ? [...JOIN_BROWSER_ARGS] : ["--lang=en-US", "--no-first-run"],
  };
}

export function controlToDisable(buttons: DomButton[], kind: "camera" | "microphone"): string | null {
  const onLabel = kind === "camera" ? CAMERA_ON_LABEL : MIC_ON_LABEL;
  return buttons.some((button) => button.label === onLabel) ? onLabel : null;
}

export function findJoinLabel(buttons: DomButton[]): JoinLabel | null {
  for (const label of JOIN_LABELS) {
    if (buttons.some((button) => button.label === label || button.label.includes(label))) return label;
  }
  return null;
}

export function snapshotShowsLeave(snapshot: PageSnapshot): boolean {
  return snapshot.left || snapshot.bodyText.includes(LEFT_MEETING_TEXT);
}

export function snapshotShowsSignedIn(snapshot: PageSnapshot): boolean {
  if (snapshot.hasAvatar) return true;
  return SIGNED_IN_URL_HINTS.some((hint) => snapshot.url.includes(hint));
}

/** Meet redirects while the page is still being read. Those errors are not a failed join. */
export function isNavigationError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /Execution context was destroyed|Cannot find context|Execution context is not available|Navigating frame was detached|frame was detached|Target closed|Session closed|net::ERR_ABORTED/i.test(
    message,
  );
}

export async function retryNavigation<T>(
  run: () => Promise<T>,
  wait: (ms: number) => Promise<void> = (ms) => realClock.wait(ms),
  attempts = 5,
): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await run();
    } catch (err) {
      last = err;
      if (!isNavigationError(err) || attempt === attempts - 1) throw err;
      await wait(300);
    }
  }
  throw last;
}

export async function joinMeeting(page: MeetPage, meetingUrl: string, opts: JoinOptions): Promise<JoinResult> {
  const clock = opts.clock ?? realClock;
  const pollMs = opts.pollMs ?? 1_000;
  logger.info({ meetingUrl, displayName: opts.displayName }, "navigated");
  await page.goto(meetingUrl);

  const greenroom = await waitFor(
    page,
    clock,
    (snapshot) => findJoinLabel(snapshot.buttons) !== null || snapshot.inCall,
    opts.greenroomTimeoutMs ?? 30_000,
    pollMs,
    "greenroom",
  );
  if (greenroom.inCall) {
    logger.info("in-call");
    return { joined: true, admittedAt: new Date(clock.now()).toISOString() };
  }

  logger.info("greenroom");
  const camera = controlToDisable(greenroom.buttons, "camera");
  if (camera) await page.clickButton(camera);
  const mic = controlToDisable(greenroom.buttons, "microphone");
  if (mic) await page.clickButton(mic);

  const pace = opts.joinPaceMs ?? DEFAULT_JOIN_PACE_MS;
  logger.info({ paceMs: pace }, "human-paced join");
  await clock.wait(pace);

  const ready = await page.snapshot();
  const joinLabel = findJoinLabel(ready.buttons);
  if (!joinLabel) throw new MeetDomChangedError("greenroom join button");
  await page.clickButton(joinLabel);

  if (joinLabel === "Ask to join") {
    logger.info(ADMIT_WAIT_LOG);
    logger.info("requested");
  }

  const inCall = await waitFor(
    page,
    clock,
    (snapshot) => snapshot.inCall,
    opts.admitTimeoutMs ?? 120_000,
    pollMs,
    joinLabel === "Ask to join" ? "admission" : "in-call UI",
  );
  if (!inCall.inCall) throw new MeetDomChangedError("in-call UI");
  logger.info({ admittedAt: new Date(clock.now()).toISOString() }, "admitted");
  logger.info("in-call");
  return { joined: true, admittedAt: new Date(clock.now()).toISOString() };
}

export async function launchBrowser(
  mode: "auth" | "join",
  opts: { profile?: string; headed?: boolean },
): Promise<Browser> {
  const dir = mode === "join" ? assertProfile(opts.profile) : profileDir(opts.profile);
  const plan = launchPlan(mode, { profileDir: dir, headed: opts.headed });
  let bundledPath: string | undefined;
  try {
    bundledPath = bundledPuppeteer.executablePath();
  } catch {
    bundledPath = undefined;
  }
  const target = selectChromeTarget(fs.existsSync, bundledPath, process.env.HOME);
  if ("executablePath" in target) {
    logger.warn(
      "Google Chrome is not installed. Opening Chrome for Testing instead. Install Google Chrome if the sign-in page blocks this browser.",
    );
  }
  const browser = await puppeteer.launch({
    headless: plan.headless,
    userDataDir: plan.userDataDir,
    args: plan.args,
    ...target,
  });
  const page = await firstPage(browser);
  const current = await page.browser().userAgent().catch(() => DESKTOP_CHROME_UA);
  await page.setUserAgent(desktopUserAgent(current));
  return browser;
}

export async function runAuth(opts: { profile?: string } = {}): Promise<void> {
  const dir = profileDir(opts.profile);
  logger.info({ profile: dir }, "opening headful sign-in");
  const browser = await launchBrowser("auth", opts);
  try {
    const page = await firstPage(browser);
    await page.goto(SIGN_IN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    console.log("waiting for sign-in complete…");
    const signedIn = await pollPuppeteer(page, 5 * 60_000, snapshotShowsSignedIn);
    if (!signedIn) {
      throw new Error("Sign-in was not detected. Finish 2FA in the Chrome window, then run `meetings-bot auth` again.");
    }
  } finally {
    await browser.close();
  }

  const check = await launchBrowser("join", { profile: dir });
  try {
    const page = await firstPage(check);
    await page.goto("https://myaccount.google.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
    const survived = await pollPuppeteer(page, 20_000, snapshotShowsSignedIn);
    if (!survived) {
      throw new Error("The Google session did not survive a headless reopen. Run `meetings-bot auth` again.");
    }
    console.log(`Signed in. Session saved in ${dir}`);
  } finally {
    await check.close();
  }
}

export async function runJoin(opts: {
  meeting: string;
  project: string;
  profile?: string;
  headed?: boolean;
  displayName: string;
}): Promise<void> {
  assertProfile(opts.profile);
  const browser = await launchBrowser("join", { profile: opts.profile, headed: opts.headed });
  let closed = false;
  const close = async (code: number): Promise<void> => {
    if (closed) return;
    closed = true;
    await browser.close().catch(() => undefined);
    process.exit(code);
  };
  process.once("SIGINT", () => {
    void close(0);
  });
  process.once("SIGTERM", () => {
    void close(0);
  });
  try {
    const page = await firstPage(browser);
    const result = await joinMeeting(adaptPage(page), opts.meeting, { displayName: opts.displayName });
    logger.info({ ...result, project: opts.project }, "joined");
    await new Promise(() => undefined);
  } catch (err) {
    await browser.close().catch(() => undefined);
    throw err;
  }
}

export function adaptPage(page: Page): MeetPage {
  return {
    async goto(url: string): Promise<void> {
      try {
        await retryNavigation(() => page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }));
      } catch (err) {
        if (!isNavigationError(err)) throw err;
        let landed = "";
        try {
          landed = page.url();
        } catch {
          landed = "";
        }
        if (landed.includes("meet.google.com")) return;
        throw new Error(
          "Meet navigated away while opening the call. Re-run with --headed, stay in the Meet, and admit Jarvis from the lobby.",
          { cause: err },
        );
      }
    },
    snapshot: () => readSnapshot(page),
    async clickButton(label: string): Promise<void> {
      const clicked = await retryNavigation(() => page.evaluate(clickScript(label)));
      if (clicked !== true) throw new MeetDomChangedError(`button ${label}`);
    },
  };
}

function clickScript(label: string): string {
  return `(() => {
    const wanted = ${JSON.stringify(label)};
    const nodes = Array.from(document.querySelectorAll("button, [role='button']"));
    const match = nodes.find((node) => {
      const text = (node.getAttribute("aria-label") || node.innerText || "").trim();
      return text === wanted || text.includes(wanted);
    });
    if (!match) return false;
    match.click();
    return true;
  })()`;
}

async function readSnapshot(page: Page): Promise<PageSnapshot> {
  return retryNavigation(() => readSnapshotOnce(page));
}

async function readSnapshotOnce(page: Page): Promise<PageSnapshot> {
  const bag = {
    inCallLabels: [...IN_CALL_LABELS],
    leftText: LEFT_MEETING_TEXT,
    avatarHint: ACCOUNT_AVATAR_HINT,
  };
  const snapshot = (await page.evaluate(`(() => {
    const selectors = ${JSON.stringify(bag)};
    const buttons = Array.from(document.querySelectorAll("button, [role='button']")).map((node) => ({
      label: (node.getAttribute("aria-label") || node.innerText || "").trim(),
    }));
    const bodyText = (document.body && document.body.innerText ? document.body.innerText : "").slice(0, 4000);
    const inCall = selectors.inCallLabels.some((label) =>
      buttons.some((button) => button.label.includes(label)) || bodyText.includes(label));
    const avatar = document.querySelector('[aria-label*="' + selectors.avatarHint + '"]');
    return {
      url: location.href,
      buttons,
      bodyText,
      inCall,
      left: bodyText.includes(selectors.leftText),
      hasAvatar: Boolean(avatar) || bodyText.includes(selectors.avatarHint),
    };
  })()`)) as PageSnapshot;
  return snapshot;
}

export async function joinPage(browser: Browser): Promise<Page> {
  return firstPage(browser);
}

export async function readPageSnapshot(page: Page): Promise<PageSnapshot> {
  return readSnapshot(page);
}

async function firstPage(browser: Browser): Promise<Page> {
  const pages = await browser.pages();
  const existing = pages[0];
  if (existing) return existing;
  return browser.newPage();
}

async function pollPuppeteer(
  page: Page,
  timeoutMs: number,
  pred: (snapshot: PageSnapshot) => boolean,
): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const snapshot = await readSnapshot(page);
    if (pred(snapshot)) return true;
    await realClock.wait(1_000);
  }
  return false;
}

async function waitFor(
  page: MeetPage,
  clock: Clock,
  pred: (snapshot: PageSnapshot) => boolean,
  timeoutMs: number,
  pollMs: number,
  step: string,
): Promise<PageSnapshot> {
  const started = clock.now();
  let latest: PageSnapshot | undefined;
  while (clock.now() - started <= timeoutMs) {
    try {
      latest = await page.snapshot();
    } catch (err) {
      if (!isNavigationError(err)) throw err;
      await clock.wait(pollMs);
      continue;
    }
    if (pred(latest)) return latest;
    if (snapshotShowsLeave(latest)) {
      throw new Error(`The meeting ended while ${step}.`);
    }
    await clock.wait(pollMs);
  }
  if (step === "admission") {
    throw new Error(
      `${ADMIT_WAIT_LOG} Timed out after ${timeoutMs}ms. Admit the bot from your Meet window, or re-run with --headed.`,
    );
  }
  throw new MeetDomChangedError(step);
}
