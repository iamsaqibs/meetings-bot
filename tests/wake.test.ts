import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { echoTranscript } from "../src/bin/wake-echo.js";
import { parseConfig } from "../src/config/load.js";
import { TranscriptStore } from "../src/transcript/store.js";
import type { TranscriptLine } from "../src/transcript/types.js";
import { WakeDetector, type WakeClassifier } from "../src/wake/detector.js";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "transcripts",
  "meeting.jsonl",
);

afterEach(() => {
  vi.restoreAllMocks();
});

function config(extra: Record<string, unknown> = {}) {
  return parseConfig({
    wake_names: ["assistant", "saqib's assistant"],
    bot_name: "Saqib's Assistant",
    ollama: { model: "gpt-oss:120b-cloud" },
    ...extra,
  });
}

function line(partial: Partial<TranscriptLine> & Pick<TranscriptLine, "text">): TranscriptLine {
  return {
    ts: partial.ts ?? "2026-10-25T13:05:22.105Z",
    speaker: partial.speaker ?? "Aadil",
    text: partial.text,
    is_self: partial.is_self ?? false,
    source: partial.source ?? "caption",
  };
}

describe("TranscriptStore", () => {
  it("fsyncs once per appended line and can skip self lines", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mb-transcript-"));
    const file = path.join(dir, "001-transcript.jsonl");
    const fsync = vi.spyOn(fs, "fsyncSync");
    const before = fsync.mock.calls.length;
    const store = new TranscriptStore(file);
    const self = line({ speaker: "Saqib's Assistant", text: "hello", is_self: true, source: "tts" });
    const first = line({ text: "hey assistant, what's the auth flow?" });
    const second = line({ text: "and the tests?", ts: "2026-10-25T13:05:30.000Z" });
    store.append(self);
    store.append(first);
    store.append(second);
    expect(fsync.mock.calls.length - before).toBe(3);
    expect(store.lines()).toEqual([self, first, second]);
    expect(store.lastNonSelf(1)).toEqual([second]);
    const raw = fs.readFileSync(file, "utf8").trim().split("\n");
    expect(raw).toHaveLength(3);
    expect(JSON.parse(raw[1] ?? "{}")).toMatchObject({ text: first.text, source: "caption" });
    store.close();
  });
});

describe("WakeDetector", () => {
  it("fires on a direct address and on a wake name in the previous line", async () => {
    const detector = new WakeDetector({ config: config() });
    expect(await detector.feed(line({ text: "Let's start with the roadmap." }))).toBeNull();
    const direct = await detector.feed(
      line({ text: "Hey Saqib's Assistant, what's the auth flow?", ts: "2026-10-25T13:05:22.105Z" }),
    );
    expect(direct?.question).toMatch(/auth flow/);
    expect(direct?.asker).toBe("Aadil");
    expect(direct?.ambiguous).toBeUndefined();
    expect(detector.classifierCallCount).toBe(0);

    const named = new WakeDetector({ config: config() });
    expect(
      await named.feed(line({ speaker: "Nora", text: "Saqib's Assistant", ts: "2026-10-25T13:00:30.000Z" })),
    ).toBeNull();
    const follow = await named.feed(
      line({ speaker: "Nora", text: "can you check the readme?", ts: "2026-10-25T13:00:31.000Z" }),
    );
    expect(follow?.question).toMatch(/readme/i);
    expect(follow?.contextLines.map((entry) => entry.text)).toContain("Saqib's Assistant");
  });

  it("does not fire on a bare mention, a question without a wake name, self speech, or a speaker named Assistant", async () => {
    const detector = new WakeDetector({ config: config() });
    expect(
      await detector.feed(line({ text: "I'll ask the assistant later.", ts: "2026-10-25T13:05:22.105Z" })),
    ).toBeNull();
    expect(
      await detector.feed(
        line({ text: "What's the deploy status?", speaker: "Nora", ts: "2026-10-25T13:05:28.000Z" }),
      ),
    ).toBeNull();
    expect(
      await detector.feed(
        line({
          speaker: "Saqib's Assistant",
          text: "Hey assistant, what's the auth flow?",
          is_self: true,
          source: "tts",
        }),
      ),
    ).toBeNull();
    detector.setSpeaking(true);
    expect(await detector.feed(line({ text: "Hey assistant, are you there?" }))).toBeNull();
    detector.setSpeaking(false);
    expect(
      await detector.feed(line({ speaker: "Assistant", text: "I'll take the next ticket." })),
    ).toBeNull();
    expect(
      await detector.feed(
        line({ speaker: "Assistant", text: "Assistant, the build is green.", ts: "2026-10-25T13:06:00.000Z" }),
      ),
    ).toBeNull();
  });

  it("merges two wakes inside 5s and refuses a second reply until a new wake", async () => {
    const detector = new WakeDetector({ config: config() });
    const first = await detector.feed(
      line({ text: "Hey assistant, are you there?", ts: "2026-10-25T13:01:00.000Z" }),
    );
    const second = await detector.feed(
      line({
        speaker: "Nora",
        text: "Assistant, please explain the joiner.",
        ts: "2026-10-25T13:01:03.000Z",
      }),
    );
    expect(first?.question).toMatch(/are you there/);
    expect(second?.question).toMatch(/are you there/);
    expect(second?.question).toMatch(/joiner/);
    expect(detector.canReply(Date.parse("2026-10-25T13:01:03.000Z"))).toBe(true);
    detector.markReplied();
    expect(detector.canReply()).toBe(false);
    expect(await detector.feed(line({ text: "sounds good", ts: "2026-10-25T13:01:04.000Z" }))).toBeNull();
    expect(detector.canReply()).toBe(false);
    const later = await detector.feed(
      line({ text: "Hey assistant, what is our budget?", ts: "2026-10-25T13:01:20.000Z" }),
    );
    expect(later?.defer).toBe(true);
    expect(later?.question).not.toMatch(/are you there/);
    expect(detector.canReply()).toBe(true);
    expect(detector.repliesUsed).toBe(1);
  });

  it("asks for clarification at most once and caches the LLM verdict", async () => {
    const classify = vi.fn<WakeClassifier["classify"]>(async () => ({ addressed: false, defer: false }));
    const detector = new WakeDetector({ config: config(), classifier: { classify } });
    const ambiguous = line({ text: "can the assistant see the repo?", ts: "2026-10-25T13:02:00.000Z" });
    const first = await detector.feed(ambiguous);
    const second = await detector.feed({ ...ambiguous, ts: "2026-10-25T13:03:00.000Z" });
    expect(first?.ambiguous).toBe(true);
    expect(second?.ambiguous).toBe(true);
    expect(classify).toHaveBeenCalledOnce();
    expect(detector.canReply()).toBe(false);
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(detector.clarifyOnce(first!)).toMatch(/meant for me/);
    expect(first?.clarifyUsed).toBe(true);
    expect(detector.clarifyOnce(second!)).toBeNull();

    const direct = new WakeDetector({ config: config(), classifier: { classify } });
    await direct.feed(line({ text: "Hey assistant, what's the auth flow?" }));
    expect(classify).toHaveBeenCalledOnce();
  });

  it("does not clarify when allow_clarify is off", async () => {
    const detector = new WakeDetector({
      config: config({ wake: { allow_clarify: false } }),
      classifier: { classify: async () => ({ addressed: true, defer: false }) },
    });
    const event = await detector.feed(line({ text: "can the assistant see the repo?" }));
    expect(event?.ambiguous).toBeUndefined();
    expect(detector.clarifyOnce({ ...event!, ambiguous: true })).toBeNull();
  });
});

describe("wake echo", () => {
  it("prints at least three real wakes and no bare-mention fires", async () => {
    const printed: string[] = [];
    const events = await echoTranscript(fixture, (line) => printed.push(line), config());
    expect(events.length).toBeGreaterThanOrEqual(3);
    const questions = events.map((event) => event.question).join("\n");
    expect(questions).toMatch(/auth flow/);
    expect(questions).toMatch(/readme/i);
    expect(questions).toMatch(/are you there/);
    expect(questions).not.toMatch(/I'll ask the assistant later/);
    expect(questions).not.toMatch(/deploy status/);
    expect(questions).not.toMatch(/next ticket/);
    expect(printed).toHaveLength(events.length);
    expect(printed.every((row) => JSON.parse(row).reply.length > 0)).toBe(true);
    const deferred = events.find((event) => event.question.includes("budget"));
    expect(deferred?.defer).toBe(true);
    expect(printed.some((row) => JSON.parse(row).reply.includes("Saqib himself"))).toBe(true);
  });
});
