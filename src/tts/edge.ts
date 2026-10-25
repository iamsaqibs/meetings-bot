import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { TtsError } from "./errors.js";
import type { TtsAudio, TtsProvider } from "./provider.js";
import { splitSentences } from "./sentences.js";

const require = createRequire(import.meta.url);
const { MsEdgeTTS, OUTPUT_FORMAT } = require("msedge-tts") as {
  MsEdgeTTS: new (options?: { synthesisTimeoutMs?: number; connectionTimeoutMs?: number }) => {
    setMetadata(voice: string, format: string): Promise<void>;
    toStream(text: string): { audioStream: AsyncIterable<Buffer | Uint8Array> };
    close(): void;
  };
  OUTPUT_FORMAT: { AUDIO_24KHZ_48KBITRATE_MONO_MP3: string };
};

const execFileAsync = promisify(execFile);
const EDGE_TIMEOUT_MS = 3_000;

/**
 * Edge TTS is an unofficial Microsoft cloud API (PLAN § 1).
 * msedge-tts returns MP3; macOS afconvert turns that into 16-bit PCM.
 * Only config.tts.voice is exposed — rate and pitch stay at the provider default.
 */
export class EdgeProvider implements TtsProvider {
  readonly providerId = "edge";

  constructor(private readonly voice: string) {}

  async synthesize(text: string): Promise<TtsAudio> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await withTimeout(this.render(text), EDGE_TIMEOUT_MS);
      } catch (err) {
        lastError = err;
      }
    }
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new TtsError(`Edge TTS failed after one retry: ${detail}`, { cause: lastError });
  }

  async *synthesizeStream(text: string): AsyncGenerator<TtsAudio> {
    for (const sentence of splitSentences(text)) yield await this.synthesize(sentence);
  }

  private async render(text: string): Promise<TtsAudio> {
    const client = new MsEdgeTTS({ synthesisTimeoutMs: EDGE_TIMEOUT_MS, connectionTimeoutMs: EDGE_TIMEOUT_MS });
    try {
      await client.setMetadata(this.voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      const { audioStream } = client.toStream(text);
      const chunks: Buffer[] = [];
      for await (const chunk of audioStream) chunks.push(Buffer.from(chunk));
      return mp3ToPcm(Buffer.concat(chunks));
    } finally {
      client.close();
    }
  }
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TtsError(`Edge TTS timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function mp3ToPcm(mp3: Buffer): Promise<TtsAudio> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mb-edge-"));
  const input = path.join(dir, "in.mp3");
  const output = path.join(dir, "out.wav");
  fs.writeFileSync(input, mp3);
  try {
    await execFileAsync("afconvert", ["-f", "WAVE", "-d", "LEI16", input, output]);
  } catch (err) {
    throw new TtsError(
      "Edge TTS returned MP3 and afconvert could not decode it. afconvert ships with macOS.",
      { cause: err },
    );
  }
  return parseWav(fs.readFileSync(output));
}

export function parseWav(wav: Buffer): TtsAudio {
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new TtsError("decoded Edge audio was not a WAV file");
  }
  let offset = 12;
  let sampleRate = 24_000;
  let data: Buffer | null = null;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "fmt " && start + 16 <= wav.length) sampleRate = wav.readUInt32LE(start + 4);
    if (id === "data") {
      data = wav.subarray(start, start + size);
      break;
    }
    offset = start + size + (size % 2);
  }
  if (!data) throw new TtsError("decoded Edge WAV had no data chunk");
  const pcm = new Int16Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / 2));
  return { pcm: pcm.slice(), sampleRate };
}
