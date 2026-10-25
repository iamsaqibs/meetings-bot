import type { TranscriptLine } from "./types.js";

export class TranscriptStore {
  append(_line: TranscriptLine): void {
    throw new Error("not implemented");
  }
}
