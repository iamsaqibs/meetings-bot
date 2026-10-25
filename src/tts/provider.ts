import type { AppConfig } from "../config/schema.js";
import { EdgeProvider } from "./edge.js";
import { TtsError } from "./errors.js";
import { KokoroProvider } from "./kokoro.js";

export { TtsError };

export interface TtsAudio {
  pcm: Int16Array;
  sampleRate: number;
}

export interface TtsProvider {
  readonly providerId: string;
  synthesize(text: string): Promise<TtsAudio>;
  synthesizeStream(text: string): AsyncGenerator<TtsAudio>;
}

export function createTtsProvider(config: AppConfig): TtsProvider {
  switch (config.tts.provider) {
    case "kokoro":
      return new KokoroProvider(config.tts.voice);
    case "edge":
      return new EdgeProvider(config.tts.voice);
    default: {
      const unknown: never = config.tts.provider;
      throw new TtsError(`Unknown TTS provider ${String(unknown)}`);
    }
  }
}

export async function warmupTts(provider: TtsProvider): Promise<void> {
  await provider.synthesize("Hello.");
}
