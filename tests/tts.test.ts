import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.js";
import { SpeakLock } from "../src/speaker/injector.js";
import { float32ToPcm16, pcm16ToFloat32, resamplePcm16 } from "../src/tts/audio.js";
import { assertEnglishVoice } from "../src/tts/kokoro.js";
import { parseWav } from "../src/tts/edge.js";
import { createTtsProvider, TtsError } from "../src/tts/provider.js";
import { splitSentences } from "../src/tts/sentences.js";

const base = {
  wake_names: ["assistant"],
  bot_name: "Saqib's Assistant",
  ollama: { model: "glm-5.3-flash:cloud" },
};

describe("tts", () => {
  it("splits four sentences and keeps a comma clause intact", () => {
    const four = splitSentences("One. Two? Three! Four.");
    expect(four).toEqual(["One.", "Two?", "Three!", "Four."]);
    expect(splitSentences("I can check the repo after the call, if you want.")).toEqual([
      "I can check the repo after the call, if you want.",
    ]);
  });

  it("converts and resamples PCM", () => {
    const pcm = float32ToPcm16(new Float32Array([0, 1, -1]));
    expect(pcm[0]).toBe(0);
    expect(pcm[1]).toBe(32767);
    expect(pcm[2]).toBe(-32768);
    const back = pcm16ToFloat32(pcm);
    expect(back[1]).toBeCloseTo(32767 / 32768, 5);

    const up = resamplePcm16(Int16Array.from([0, 32767]), 24_000, 48_000, 1);
    expect(up.length).toBe(4);
    const clipped = resamplePcm16(Int16Array.from([32767]), 24_000, 24_000, 4);
    expect(clipped[0]).toBe(1);
  });

  it("dispatches the factory and refuses an unknown provider", () => {
    expect(createTtsProvider(parseConfig({ ...base, tts: { provider: "kokoro" } })).providerId).toBe("kokoro");
    expect(createTtsProvider(parseConfig({ ...base, tts: { provider: "edge" } })).providerId).toBe("edge");
    expect(() =>
      createTtsProvider(parseConfig({ ...base, tts: { provider: "kokoro", voice: "jf_alpha" } })),
    ).toThrow(TtsError);
    expect(() => assertEnglishVoice("jf_alpha")).toThrow(/English/);
    const broken = parseConfig(base);
    (broken.tts as { provider: string }).provider = "nope";
    expect(() => createTtsProvider(broken)).toThrow(/Unknown TTS provider/);
  });

  it("reads a 16-bit WAV", () => {
    const wav = wavWith([0, 1000, -1000], 16_000);
    const audio = parseWav(wav);
    expect(audio.sampleRate).toBe(16_000);
    expect(Array.from(audio.pcm)).toEqual([0, 1000, -1000]);
  });

  it("queues overlapping speech", async () => {
    const lock = new SpeakLock();
    const order: string[] = [];
    const first = lock.run(async () => {
      order.push("start-a");
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("end-a");
    });
    const second = lock.run(async () => {
      order.push("start-b");
      order.push("end-b");
    });
    await Promise.all([first, second]);
    expect(order).toEqual(["start-a", "end-a", "start-b", "end-b"]);
  });

  it.skipIf(process.env.MEETINGS_BOT_LIVE !== "1")("synthesizes a short Kokoro clip", async () => {
    const provider = createTtsProvider(parseConfig({ ...base, tts: { provider: "kokoro", voice: "af_heart" } }));
    const chunks = [];
    for await (const chunk of provider.synthesizeStream("Hello. This is a test.")) chunks.push(chunk);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]?.pcm.length).toBeGreaterThan(0);
  });
});

function wavWith(samples: number[], sampleRate: number): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => data.writeInt16LE(sample, index * 2));
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
