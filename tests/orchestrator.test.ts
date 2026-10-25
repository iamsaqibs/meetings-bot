import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFER_LINE } from "../src/agent/deferPhrases.js";
import { createTurnState, handleCaption, type SpeechPorts, type TurnState } from "../src/agent/orchestrator.js";
import type { GenerateReplyInput, GenerateReplyResult } from "../src/brain/agent.js";
import { parseConfig } from "../src/config/load.js";
import type { Brief } from "../src/context/brief.js";
import type { TranscriptLine } from "../src/transcript/types.js";
import { TranscriptStore } from "../src/transcript/store.js";
import { TtsError } from "../src/tts/errors.js";
import { dryRun } from "../src/bin/dry-run.js";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe("orchestrator gates", () => {
  it("deferral beats rate limit beats reply", async () => {
    const spoken: string[] = [];
    const generated: string[] = [];
    const ports = portsWith(spoken, async (input) => {
      generated.push(input.question);
      return { text: "A real answer.", usedFiles: [] };
    });

    const deferred = state();
    deferred.talkSeconds = 9_999;
    await handleCaption(deferred, line("Hey assistant, what is our budget?"), ports);
    expect(spoken).toEqual([DEFER_LINE]);
    expect(generated).toEqual([]);

    spoken.length = 0;
    const limited = state();
    limited.talkSeconds = limited.config.limits.max_talk_seconds;
    await handleCaption(limited, line("Hey assistant, are you there?"), ports);
    expect(spoken).toEqual([]);
    expect(generated).toEqual([]);

    await handleCaption(state(), line("Hey assistant, are you there?"), ports);
    expect(generated).toEqual(["Hey assistant, are you there?"]);
    expect(spoken).toEqual(["A real answer."]);
  });

  it("posts the full text to chat when TTS fails", async () => {
    const chats: string[] = [];
    const notes: string[] = [];
    const meeting = state();
    await handleCaption(meeting, line("Hey assistant, what's the auth flow?"), {
      ...silentPorts(async () => ({ text: "Cookie based auth.", usedFiles: ["src/auth/session.ts"] })),
      synthesize: async () => {
        throw new TtsError("synth failed");
      },
      postChat: async (text) => {
        chats.push(text);
      },
      note: (entry) => notes.push(`${entry.kind}:${entry.detail}`),
    });
    expect(chats).toEqual(["Cookie based auth."]);
    expect(notes.some((entry) => entry.startsWith("degrade:Cookie based auth."))).toBe(true);
    expect(meeting.stats.chatFallbacks).toBe(1);
    expect(meeting.store.lines().some((entry) => entry.text.startsWith("read files:"))).toBe(true);
  });

  it("rephrases a verbatim repeat once", async () => {
    const spoken: string[] = [];
    const extras: Array<string | undefined> = [];
    const meeting = state();
    await handleCaption(meeting, line("Hey assistant, what's the auth flow?"), portsWith(spoken, async (input) => {
      extras.push(input.extraContext);
      return { text: "Same answer.", usedFiles: [] };
    }));
    await handleCaption(meeting, line("Hey assistant, can you check the readme?"), portsWith(spoken, async (input) => {
      extras.push(input.extraContext);
      return { text: input.extraContext ? "A different wording." : "Same answer.", usedFiles: [] };
    }));
    expect(spoken).toEqual(["Same answer.", "A different wording."]);
    expect(extras.some((extra) => /verbatim/i.test(extra ?? ""))).toBe(true);
  });

  it("stops further replies at the talk-time ceiling", async () => {
    const spoken: string[] = [];
    let calls = 0;
    const meeting = state();
    const ports = portsWith(spoken, async () => {
      calls += 1;
      return { text: "Short answer.", usedFiles: [] };
    });
    ports.speak = async () => meeting.config.limits.max_talk_seconds;
    await handleCaption(meeting, line("Hey assistant, what's the auth flow?"), ports);
    await handleCaption(meeting, line("Hey assistant, are you there?"), ports);
    expect(calls).toBe(1);
    expect(spoken).toEqual(["Short answer."]);
  });

  it("omits self lines from the brain excerpt and records a missing fact", async () => {
    const meeting = state();
    meeting.store.append({
      ts: "2026-10-25T13:00:00.000Z",
      speaker: "Saqib's Assistant",
      text: "SECRET SELF",
      is_self: true,
      source: "tts",
    });
    let excerpt = "";
    await handleCaption(meeting, line("Hey assistant, what's the auth flow?"), silentPorts(async (input) => {
      excerpt = input.transcriptExcerpt.map((entry) => entry.text).join("\n");
      expect(input.transcriptExcerpt.every((entry) => !entry.is_self)).toBe(true);
      return {
        text: "I don't have that in the project — I can check the repo after the call.",
        usedFiles: [],
      };
    }));
    expect(excerpt).not.toContain("SECRET SELF");
    expect(meeting.followups).toEqual(["Hey assistant, what's the auth flow?"]);
  });
});

describe("dry run", () => {
  it("walks the fixture meeting without false wakes", async () => {
    const printed: string[] = [];
    const timeline = await dryRun({
      transcriptPath: path.join("tests", "fixtures", "transcripts", "meeting.jsonl"),
      config: sampleConfig(),
      write: (row) => printed.push(row),
    });
    const text = timeline.join("\n");
    expect(text).toMatch(/auth flow/);
    expect(text).toMatch(/Saqib himself/);
    expect(text).not.toMatch(/deploy status/);
    expect(text).not.toMatch(/next ticket/);
    expect(text).not.toMatch(/ask the assistant later/);
    expect(printed).toEqual(timeline);
  });
});

function sampleConfig() {
  return parseConfig({
    wake_names: ["assistant", "saqib's assistant"],
    bot_name: "Saqib's Assistant",
    ollama: { model: "glm-5.3-flash:cloud" },
  });
}

function state(): TurnState {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mb-orch-"));
  homes.push(home);
  return createTurnState({
    config: sampleConfig(),
    brief: {
      projectDir: home,
      hash: "test",
      tree: ".",
      seedText: "readme",
      totalBytes: 6,
      generatedAt: "2026-10-25T00:00:00.000Z",
    } satisfies Brief,
    store: new TranscriptStore(path.join(home, "transcript.jsonl")),
    coalesceMs: 0,
  });
}

function line(text: string, ts = "2026-10-25T13:00:20.000Z"): TranscriptLine {
  return { ts, speaker: "Aadil", text, is_self: false, source: "caption" };
}

function silentPorts(
  generateReply: (input: GenerateReplyInput) => Promise<GenerateReplyResult>,
): SpeechPorts {
  return {
    generateReply,
    synthesize: async () => ({ pcm: new Int16Array([0]), sampleRate: 16_000 }),
    speak: async () => 1,
    postChat: async () => undefined,
  };
}

function portsWith(
  spoken: string[],
  generateReply: (input: GenerateReplyInput) => Promise<GenerateReplyResult>,
): SpeechPorts {
  return {
    ...silentPorts(generateReply),
    synthesize: async (sentence) => {
      spoken.push(sentence);
      return { pcm: new Int16Array([0]), sampleRate: 16_000 };
    },
  };
}
