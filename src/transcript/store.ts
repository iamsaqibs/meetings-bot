import fs from "node:fs";
import path from "node:path";
import type { TranscriptLine } from "./types.js";

/** Append-only JSONL. One fsync per line so a crash keeps every finalized caption. */
export class TranscriptStore {
  private fd: number | null = null;
  private readonly buffered: TranscriptLine[] = [];

  constructor(private readonly filePath: string) {}

  append(line: TranscriptLine): void {
    const fd = this.open();
    fs.writeSync(fd, `${JSON.stringify(line)}\n`, null, "utf8");
    fs.fsyncSync(fd);
    this.buffered.push(line);
  }

  lines(): TranscriptLine[] {
    return [...this.buffered];
  }

  lastNonSelf(n: number): TranscriptLine[] {
    return this.buffered.filter((line) => !line.is_self).slice(-n);
  }

  close(): void {
    if (this.fd === null) return;
    fs.closeSync(this.fd);
    this.fd = null;
  }

  private open(): number {
    if (this.fd !== null) return this.fd;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.fd = fs.openSync(this.filePath, "a");
    return this.fd;
  }
}
