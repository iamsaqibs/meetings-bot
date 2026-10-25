import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTurnState, handleCaption } from "../agent/orchestrator.js";
import { generateReply as defaultGenerateReply, type GenerateReplyResult } from "../brain/agent.js";
import { ensureBrainReachable } from "../brain/ollama.js";
import { loadConfig, mergeCliFlags, parseConfig } from "../config/load.js";
import { PLACEHOLDER_WAKE_NAME, type AppConfig } from "../config/schema.js";
import { loadBrief } from "../context/brief.js";
import type { Brief } from "../context/brief.js";
import type { TranscriptLine } from "../transcript/types.js";
import { TranscriptStore } from "../transcript/store.js";
import type { TtsAudio } from "../tts/provider.js";

const SILENCE: TtsAudio = { pcm: new Int16Array([0, 0]), sampleRate: 24_000 };

/**
 * `--fast` plays the transcript ten times quicker.
 * Each gap is also capped so the committed 80s fixture finishes inside the 2s CI bound;
 * an uncapped ×10 replay of that file would take about 8s.
 */
export function paceDelayMs(deltaMs: number, fast: boolean): number {
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) return 0;
  const scaled = deltaMs / (fast ? 10 : 1);
  return fast ? Math.min(scaled, 100) : scaled;
}

export async function replayEcho(options: {
  transcriptPath: string;
  fast?: boolean;
  mockBrain?: boolean;
  projectDir?: string;
  model?: string;
  config?: AppConfig;
  write?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}): Promise<void> {
  const write = options.write ?? console.log;
  if (!fs.existsSync(options.transcriptPath)) {
    throw new Error(
      `No transcript at ${options.transcriptPath}. Pass a JSONL file such as tests/fixtures/transcripts/meeting.jsonl.`,
    );
  }
  const config = options.config ?? resolveEchoConfig(options.model);
  const mockBrain = options.mockBrain ?? process.env.MOCK_BRAIN === "1";
  const projectDir = options.projectDir ?? process.cwd();
  const brief = mockBrain ? emptyBrief(projectDir) : await loadBrief(projectDir);
  if (!mockBrain) await ensureBrainReachable(config);
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mb-echo-"));
  const store = new TranscriptStore(path.join(home, "transcript.jsonl"));
  const state = createTurnState({ config, brief, store, coalesceMs: 0 });
  const lines = readTranscript(options.transcriptPath);
  let previous = Number.NaN;
  try {
    for (const line of lines) {
      const at = Date.parse(line.ts);
      if (Number.isFinite(previous)) await sleep(paceDelayMs(at - previous, Boolean(options.fast)));
      previous = at;
      await handleCaption(state, line, {
        generateReply: (input) => (mockBrain ? canned(input.question) : defaultGenerateReply({ ...input, brief, config })),
        synthesize: async () => SILENCE,
        speak: async () => 0.2,
        postChat: async () => undefined,
      });
    }
  } finally {
    store.close();
  }
  for (const item of state.qa) {
    write(JSON.stringify({ question: item.question, reply: item.answer, channel: item.channel }));
  }
}

export function resolveEchoConfig(model?: string): AppConfig {
  const loaded = mergeCliFlags(loadConfig(), { model });
  if (!loaded.wake_names.some((name) => name === PLACEHOLDER_WAKE_NAME)) return loaded;
  return parseConfig({
    wake_names: ["assistant", "saqib's assistant"],
    bot_name: "Saqib's Assistant",
    ollama: { model: model ?? "gpt-oss:120b-cloud" },
  });
}

async function canned(question: string): Promise<GenerateReplyResult> {
  const first = question.split("\n")[0] ?? question;
  return { text: `I heard you. ${first}`, usedFiles: [] };
}

function emptyBrief(projectDir: string): Brief {
  return {
    projectDir,
    hash: "echo",
    tree: ".",
    seedText: "",
    totalBytes: 0,
    generatedAt: new Date(0).toISOString(),
  };
}

function readTranscript(transcriptPath: string): TranscriptLine[] {
  return fs
    .readFileSync(transcriptPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => JSON.parse(line) as TranscriptLine);
}
