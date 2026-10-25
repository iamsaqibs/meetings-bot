import type { TtsProvider } from "./provider.js";

export class EdgeProvider implements TtsProvider {
  readonly providerId = "edge";

  async synthesize(_text: string): Promise<{ pcm: Int16Array; sampleRate: number }> {
    throw new Error("not implemented");
  }
}
