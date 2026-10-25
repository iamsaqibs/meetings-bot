import type { TtsProvider } from "./provider.js";

export class KokoroProvider implements TtsProvider {
  readonly providerId = "kokoro";

  async synthesize(_text: string): Promise<{ pcm: Int16Array; sampleRate: number }> {
    throw new Error("not implemented");
  }
}
