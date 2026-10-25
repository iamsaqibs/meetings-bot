import { float32ToPcm16 } from "./audio.js";
import { TtsError } from "./errors.js";
import type { TtsAudio, TtsProvider } from "./provider.js";
import { splitSentences } from "./sentences.js";

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

interface KokoroAudio {
  audio: Float32Array;
  sampling_rate: number;
}

interface KokoroRuntime {
  generate(text: string, options: { voice: string }): Promise<KokoroAudio>;
}

let cached: Promise<KokoroRuntime> | null = null;

/**
 * kokoro-js evaluates the espeak phonemizer as soon as the module loads.
 * Import it on the first synthesis so tests and CLI startup do not boot it.
 */
async function loadKokoro(): Promise<KokoroRuntime> {
  cached ??= import("kokoro-js").then(async (mod) => {
    const tts = await mod.KokoroTTS.from_pretrained(MODEL_ID, { dtype: "q8", device: "cpu" });
    return tts as unknown as KokoroRuntime;
  });
  return cached;
}

export function assertEnglishVoice(voice: string): void {
  if (/^[ab][fm]_/.test(voice)) return;
  throw new TtsError(
    `Kokoro voice ${JSON.stringify(voice)} is not English. kokoro-js phonemization is English-only; use a voice like af_heart.`,
  );
}

export class KokoroProvider implements TtsProvider {
  readonly providerId = "kokoro";

  constructor(private readonly voice: string) {
    assertEnglishVoice(voice);
  }

  async synthesize(text: string): Promise<TtsAudio> {
    const chunks: TtsAudio[] = [];
    for await (const chunk of this.synthesizeStream(text)) chunks.push(chunk);
    return concatAudio(chunks);
  }

  async *synthesizeStream(text: string): AsyncGenerator<TtsAudio> {
    assertEnglishVoice(this.voice);
    const model = await loadKokoro();
    for (const sentence of splitSentences(text)) {
      const audio = await model.generate(sentence, { voice: this.voice });
      yield { pcm: float32ToPcm16(audio.audio), sampleRate: audio.sampling_rate };
    }
  }
}

function concatAudio(chunks: TtsAudio[]): TtsAudio {
  const first = chunks[0];
  if (!first) return { pcm: new Int16Array(), sampleRate: 24000 };
  const rate = first.sampleRate;
  const length = chunks.reduce((sum, chunk) => sum + chunk.pcm.length, 0);
  const pcm = new Int16Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    pcm.set(chunk.pcm, offset);
    offset += chunk.pcm.length;
  }
  return { pcm, sampleRate: rate };
}
