import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createTurnState, handleCaption, type TurnNote } from "../agent/orchestrator.js";
import type { GenerateReplyResult } from "../brain/agent.js";
import { loadConfig, parseConfig } from "../config/load.js";
import { PLACEHOLDER_WAKE_NAME, type AppConfig } from "../config/schema.js";
import type { Brief } from "../context/brief.js";
import type { TranscriptLine } from "../transcript/types.js";
import { TranscriptStore } from "../transcript/store.js";
import type { TtsAudio } from "../tts/provider.js";

const silence: TtsAudio = { pcm: new Int16Array([0, 0]), sampleRate: 24_000 };

/** Browser-free meeting: replay a transcript through the wake gate and a canned or injected brain. */
export async function dryRun(options: {
  transcriptPath: string;
  config?: AppConfig;
  write?: (line: string) => void;
  generateReply?: (question: string) => Promise<GenerateReplyResult>;
}): Promise<string[]> {
  const write = options.write ?? console.log;
  const config = options.config ?? dryConfig();
  const notes: TurnNote[] = [];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mb-dry-"));
  const store = new TranscriptStore(path.join(home, "transcript.jsonl"));
  const state = createTurnState({
    config,
    brief: fakeBrief(),
    store,
    coalesceMs: 0,
  });
  const generate = options.generateReply ?? (async (question: string) => ({ text: `Noted. ${question.split("\n")[0] ?? question}`, usedFiles: [] }));
  try {
    for (const line of readTranscript(options.transcriptPath)) {
      await handleCaption(state, line, {
        generateReply: (input) => generate(input.question),
        synthesize: async () => silence,
        speak: async () => 0.2,
        postChat: async () => undefined,
        note: (entry) => notes.push(entry),
      });
    }
  } finally {
    store.close();
  }
  const timeline = notes.map((entry) => `${entry.at} ${entry.kind} ${entry.detail}`);
  for (const row of timeline) write(row);
  return timeline;
}

function readTranscript(transcriptPath: string): TranscriptLine[] {
  return fs
    .readFileSync(transcriptPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => JSON.parse(line) as TranscriptLine);
}

function fakeBrief(): Brief {
  return {
    projectDir: process.cwd(),
    hash: "dry-run",
    tree: ".",
    seedText: "dry run",
    totalBytes: 8,
    generatedAt: new Date().toISOString(),
  };
}

function dryConfig(): AppConfig {
  const loaded = loadConfig();
  if (!loaded.wake_names.some((name) => name === PLACEHOLDER_WAKE_NAME)) return loaded;
  return parseConfig({
    wake_names: ["assistant", "saqib's assistant"],
    bot_name: "Saqib's Assistant",
    ollama: { model: "gpt-oss:120b-cloud" },
  });
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const file = process.argv[2] ?? "tests/fixtures/transcripts/meeting.jsonl";
  await dryRun({ transcriptPath: file });
}
