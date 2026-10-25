import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_JOIN_PACE_MS,
  MeetDomChangedError,
  controlToDisable,
  desktopUserAgent,
  findJoinLabel,
  isNavigationError,
  joinMeeting,
  launchPlan,
  retryNavigation,
  selectChromeTarget,
  snapshotShowsLeave,
  snapshotShowsSignedIn,
  type Clock,
  type MeetPage,
  type PageSnapshot,
} from "../src/auth/joiner.js";
import { assertProfile, profileDir, profileExists } from "../src/auth/session.js";
import {
  CAMERA_ON_LABEL,
  LEFT_MEETING_TEXT,
  MIC_ON_LABEL,
} from "../src/auth/selectors.js";
import { pageShowsLeave } from "../src/lifecycle/leave.js";

const envSnapshot = { ...process.env };

afterEach(() => {
  process.env = { ...envSnapshot };
});

function home(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mb-profile-"));
  process.env.MEETINGS_BOT_HOME = dir;
  return dir;
}

function clock(): Clock & { at: number } {
  const state = { at: 0, now: () => state.at, wait: async (ms: number) => { state.at += ms; } };
  return state;
}

function snap(partial: Partial<PageSnapshot>): PageSnapshot {
  return {
    url: "https://meet.google.com/abc-defg-hij",
    buttons: [],
    bodyText: "",
    inCall: false,
    left: false,
    hasAvatar: false,
    ...partial,
  };
}

class ScriptedPage implements MeetPage {
  readonly clicks: string[] = [];
  private seen = 0;

  constructor(private readonly mode: "now" | "ask" | "muted" | "broken" | "stuck") {}

  async goto(): Promise<void> {}

  async snapshot(): Promise<PageSnapshot> {
    this.seen += 1;
    if (this.mode === "broken") return snap({});
    if (this.clicks.includes("Join now") || (this.mode === "ask" && this.clicks.includes("Ask to join") && this.seen > 4)) {
      return snap({ buttons: [{ label: "Leave call" }], inCall: true });
    }
    if (this.mode === "stuck" && this.clicks.includes("Ask to join")) return snap({});
    if (this.mode === "muted") return snap({ buttons: [{ label: "Join now" }] });
    const join = this.mode === "ask" || this.mode === "stuck" ? "Ask to join" : "Join now";
    return snap({
      buttons: [{ label: CAMERA_ON_LABEL }, { label: MIC_ON_LABEL }, { label: join }],
    });
  }

  async clickButton(label: string): Promise<void> {
    this.clicks.push(label);
  }
}

describe("profile and launch plan", () => {
  it("treats an empty Cookies file as signed out and a non-empty one as a session", () => {
    const dir = home();
    expect(profileExists(path.join(dir, "missing"))).toBe(false);
    const profile = profileDir();
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(path.join(profile, "Cookies"), "");
    expect(profileExists()).toBe(false);
    fs.writeFileSync(path.join(profile, "Cookies"), "session");
    expect(profileExists()).toBe(true);
    expect(() => assertProfile()).not.toThrow();
  });

  it("accepts Chrome's Default/Cookies and refuses to join without a session", () => {
    const dir = home();
    const nested = path.join(dir, "elsewhere");
    fs.mkdirSync(path.join(nested, "Default"), { recursive: true });
    fs.writeFileSync(path.join(nested, "Default", "Cookies"), "abc");
    expect(profileExists(nested)).toBe(true);
    expect(() => assertProfile(path.join(dir, "nope"))).toThrow(/meetings-bot auth/);
  });

  it("launches auth headful and join headless with the audio flags", async () => {
    const auth = launchPlan("auth", { profileDir: "/tmp/profile" });
    const join = launchPlan("join", { profileDir: "/tmp/profile" });
    const headed = launchPlan("join", { profileDir: "/tmp/profile", headed: true });
    expect(auth.headless).toBe(false);
    expect(join.headless).toBe(true);
    expect(headed.headless).toBe(false);
    expect(join.userDataDir).toBe("/tmp/profile");
    expect(join.channel).toBe("chrome");
    expect(selectChromeTarget(() => true, "/tmp/chrome")).toEqual({ channel: "chrome" });
    expect(
      selectChromeTarget((candidate) => candidate === "/tmp/chrome-for-testing", "/tmp/chrome-for-testing"),
    ).toEqual({ executablePath: "/tmp/chrome-for-testing" });
    expect(() => selectChromeTarget(() => false, undefined)).toThrow(/Install the stable Chrome app/);
    expect(isNavigationError(new Error("Execution context was destroyed, most likely because of a navigation."))).toBe(true);
    expect(isNavigationError(new Error("Meet DOM changed"))).toBe(false);
    let calls = 0;
    await expect(
      retryNavigation(
        async () => {
          calls += 1;
          if (calls < 3) throw new Error("Execution context was destroyed, most likely because of a navigation.");
          return "joined";
        },
        async () => undefined,
      ),
    ).resolves.toBe("joined");
    await expect(retryNavigation(async () => {
      throw new Error("profile missing");
    }, async () => undefined)).rejects.toThrow(/profile missing/);
    expect(join.args).toEqual(expect.arrayContaining([
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--disable-features=WebRtcApmInAudioService,ChromeWideEchoCancellation",
      "--autoplay-policy=no-user-gesture-required",
      "--lang=en-US",
    ]));
    expect(desktopUserAgent("Mozilla HeadlessChrome/131")).toBe("Mozilla Chrome/131");
    expect(DEFAULT_JOIN_PACE_MS).toBeGreaterThanOrEqual(2_000);
    expect(DEFAULT_JOIN_PACE_MS).toBeLessThanOrEqual(5_000);
  });
});

describe("join state machine", () => {
  it("turns camera and mic off, pauses, then clicks Join now", async () => {
    const page = new ScriptedPage("now");
    const result = await joinMeeting(page, "https://meet.google.com/abc-defg-hij", {
      displayName: "Saqib's Assistant",
      joinPaceMs: 0,
      clock: clock(),
    });
    expect(result.joined).toBe(true);
    expect(page.clicks).toEqual([CAMERA_ON_LABEL, MIC_ON_LABEL, "Join now"]);
    expect(controlToDisable([{ label: "Turn on camera" }], "camera")).toBeNull();
    expect(findJoinLabel([{ label: "Ask to join" }])).toBe("Ask to join");
  });

  it("leaves an already-muted greenroom alone and waits through Ask to join", async () => {
    const muted = new ScriptedPage("muted");
    await joinMeeting(muted, "https://meet.google.com/abc-defg-hij", {
      displayName: "Saqib's Assistant",
      joinPaceMs: 0,
      clock: clock(),
    });
    expect(muted.clicks).toEqual(["Join now"]);

    const lobby = new ScriptedPage("ask");
    const result = await joinMeeting(lobby, "https://meet.google.com/abc-defg-hij", {
      displayName: "Saqib's Assistant",
      joinPaceMs: 0,
      pollMs: 100,
      clock: clock(),
    });
    expect(lobby.clicks).toContain("Ask to join");
    expect(result.joined).toBe(true);
  });

  it("names auth/selectors.ts when the greenroom never appears, and times out in the lobby", async () => {
    const broken = new ScriptedPage("broken");
    await expect(
      joinMeeting(broken, "https://meet.google.com/abc-defg-hij", {
        displayName: "Saqib's Assistant",
        joinPaceMs: 0,
        greenroomTimeoutMs: 1_000,
        pollMs: 500,
        clock: clock(),
      }),
    ).rejects.toThrow(MeetDomChangedError);
    await expect(
      joinMeeting(new ScriptedPage("broken"), "https://meet.google.com/abc-defg-hij", {
        displayName: "Saqib's Assistant",
        joinPaceMs: 0,
        greenroomTimeoutMs: 1_000,
        pollMs: 500,
        clock: clock(),
      }),
    ).rejects.toThrow(/auth\/selectors\.ts/);
    await expect(
      joinMeeting(new ScriptedPage("broken"), "https://meet.google.com/abc-defg-hij", {
        displayName: "Saqib's Assistant",
        joinPaceMs: 0,
        greenroomTimeoutMs: 1_000,
        pollMs: 500,
        clock: clock(),
      }),
    ).rejects.toThrow(/--headed/);

    await expect(
      joinMeeting(new ScriptedPage("stuck"), "https://meet.google.com/abc-defg-hij", {
        displayName: "Saqib's Assistant",
        joinPaceMs: 0,
        admitTimeoutMs: 1_000,
        pollMs: 500,
        clock: clock(),
      }),
    ).rejects.toThrow(/admitted/);
  });

  it("detects the leave banner and a signed-in account page", () => {
    const left = snap({ bodyText: `Thanks. ${LEFT_MEETING_TEXT}` });
    expect(snapshotShowsLeave(left)).toBe(true);
    expect(pageShowsLeave(left)).toBe(true);
    expect(snapshotShowsLeave(snap({ left: true }))).toBe(true);
    expect(snapshotShowsSignedIn(snap({ hasAvatar: true }))).toBe(true);
    expect(snapshotShowsSignedIn(snap({ url: "https://myaccount.google.com/" }))).toBe(true);
    expect(snapshotShowsSignedIn(snap({ url: "https://accounts.google.com/signin" }))).toBe(false);
  });
});
