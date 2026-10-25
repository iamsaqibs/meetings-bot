export interface TtsAudio {
  pcm: Int16Array;
  sampleRate: number;
}

export interface TtsProvider {
  readonly providerId: string;
  synthesize(text: string): Promise<TtsAudio>;
}
