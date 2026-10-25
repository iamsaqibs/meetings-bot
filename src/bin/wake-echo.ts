import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { loadConfig, parseConfig } from "../config/load.js";
import { PLACEHOLDER_WAKE_NAME } from "../config/schema.js";
import type { AppConfig } from "../config/schema.js";
import type { TranscriptLine, WakeEvent } from "../transcript/types.js";
import { WakeDetector } from "../wake/detector.js";

const DEFER_LINE = "That's better answered by Saqib himself — over to you.";

export async function echoTranscript(
  transcriptPath: string,
  write: (line: string) => void = console.log,
  config: AppConfig = echoConfig(),
): Promise<WakeEvent[]> {
  const detector = new WakeDetector({ config });
  const events: WakeEvent[] = [];
  for (const line of readTranscript(transcriptPath)) {
    const event = await detector.feed(line);
    if (!event || event.ambiguous) continue;
    const reply = event.defer ? DEFER_LINE : `I heard you. ${event.question.split("\n")[0] ?? event.question}`;
    write(JSON.stringify({ event, reply }));
    events.push(event);
    detector.markReplied();
  }
  return events;
}

function readTranscript(transcriptPath: string): TranscriptLine[] {
  return fs
    .readFileSync(transcriptPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => JSON.parse(line) as TranscriptLine);
}

function echoConfig(): AppConfig {
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
  const file = process.argv[2];
  if (!file) {
    console.error("usage: tsx src/bin/wake-echo.ts <transcript.jsonl>");
    process.exit(1);
  }
  await echoTranscript(file);
}
