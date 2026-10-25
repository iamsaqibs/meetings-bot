import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyRehearse } from "../src/agent/rehearse.js";
import { createProgram } from "../src/bin/meetings-bot.js";
import { parseConfig } from "../src/config/load.js";
import { paceDelayMs, replayEcho } from "../src/echo/replay.js";

const fixture = path.join("tests", "fixtures", "transcripts", "meeting.jsonl");

describe("cli", () => {
  it("threads rehearse into clarify and reply length only", () => {
    const config = parseConfig({
      wake_names: ["assistant"],
      bot_name: "Saqib's Assistant",
      ollama: { model: "glm-5.3-flash:cloud", temperature: 0.3 },
      wake: { allow_clarify: false, finalize_ms: 1500 },
      limits: { max_reply_words: 150, max_replies: 15, max_talk_seconds: 600 },
    });
    const next = applyRehearse(config);
    expect(next.wake.allow_clarify).toBe(true);
    expect(next.limits.max_reply_words).toBe(300);
    expect(next.wake.finalize_ms).toBe(config.wake.finalize_ms);
    expect(next.limits.max_replies).toBe(config.limits.max_replies);
    expect(next.limits.max_talk_seconds).toBe(config.limits.max_talk_seconds);
    expect(next.ollama).toEqual(config.ollama);
    expect(next.bot_name).toBe(config.bot_name);
    expect(next.tts).toEqual(config.tts);
    expect(next.defer_phrases).toEqual(config.defer_phrases);
    expect(next.captions).toEqual(config.captions);
    expect(next.meet).toEqual(config.meet);
  });

  it("replays the fixture quickly with deterministic mock answers and no false wakes", async () => {
    const started = Date.now();
    const first: string[] = [];
    await replayEcho({
      transcriptPath: fixture,
      fast: true,
      mockBrain: true,
      config: sample(),
      write: (line) => first.push(line),
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    const second: string[] = [];
    await replayEcho({
      transcriptPath: fixture,
      fast: true,
      mockBrain: true,
      config: sample(),
      write: (line) => second.push(line),
      sleep: async () => undefined,
    });
    expect(second).toEqual(first);
    const questions = first.map((line) => String(JSON.parse(line).question)).join("\n");
    expect(questions).toMatch(/auth flow/);
    expect(questions).toMatch(/readme/i);
    expect(questions).toMatch(/are you there/);
    expect(questions).not.toMatch(/I'll ask the assistant later/);
    expect(questions).not.toMatch(/deploy status/);
    expect(questions).not.toMatch(/next ticket/);
    expect(first.some((line) => String(JSON.parse(line).reply).includes("Saqib himself"))).toBe(true);
    expect(paceDelayMs(80_000, true)).toBe(100);
    expect(paceDelayMs(1_000, true)).toBe(100);
  });

  it("lists join, auth, rehearse, echo, and config", () => {
    const help = createProgram().helpInformation();
    expect(help).toContain("join");
    expect(help).toContain("auth");
    expect(help).toContain("rehearse");
    expect(help).toContain("echo");
    expect(help).toContain("config");
    expect(createProgram().version()).toBe("1.0.0");
  });
});

function sample() {
  return parseConfig({
    wake_names: ["assistant", "saqib's assistant"],
    bot_name: "Saqib's Assistant",
    ollama: { model: "glm-5.3-flash:cloud" },
  });
}
