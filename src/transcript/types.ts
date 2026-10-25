export type TranscriptSource = "caption" | "tts" | "chat" | "system";

export interface TranscriptLine {
  ts: string;
  speaker: string;
  text: string;
  is_self: boolean;
  source: TranscriptSource;
}

export interface WakeEvent {
  ts: string;
  asker?: string;
  question: string;
  contextLines: TranscriptLine[];
  clarifyUsed?: boolean;
}
