import type { AppConfig } from "../config/schema.js";
import type { TranscriptLine, WakeEvent } from "../transcript/types.js";

const REQUEST_FORM =
  /\?|\b(?:what|why|how|when|where|who|can|could|would|please|tell|show|explain|check|find|get|give)\b|\b(?:do you|are you|give me)\b/i;

export interface WakeClassifier {
  classify(input: {
    speaker: string;
    question: string;
    context: string;
  }): Promise<{ addressed: boolean; defer: boolean }>;
}

export interface WakeDetectorOptions {
  config: AppConfig;
  classifier?: WakeClassifier;
}

/**
 * Two-stage wake gate. `feed` is async because an ambiguous lexical hit may
 * call the classifier; definite hits resolve without a model call.
 */
export class WakeDetector {
  private readonly history: TranscriptLine[] = [];
  private speaking = false;
  private clarifyCount = 0;
  private replyCount = 0;
  private answered = false;
  private pending: WakeEvent | null = null;
  private pendingAt = 0;
  private readonly cache = new Map<string, { addressed: boolean; defer: boolean }>();
  private classifierCalls = 0;

  constructor(private readonly options: WakeDetectorOptions) {}

  get repliesUsed(): number {
    return this.replyCount;
  }

  get classifierCallCount(): number {
    return this.classifierCalls;
  }

  setSpeaking(active: boolean): void {
    this.speaking = active;
  }

  async feed(line: TranscriptLine): Promise<WakeEvent | null> {
    this.history.push(line);
    if (this.blocked(line)) return null;

    const preceding = this.history.slice(-3, -1);
    const wakeOnLine = this.hasWake(this.matchText(line));
    const recentWake = preceding.filter(
      (entry) => this.hasWake(this.matchText(entry)) && withinMs(entry, line, 1_500),
    );
    if (!wakeOnLine && recentWake.length === 0) return null;
    if (!hasRequestForm(line.text)) return null;
    const window = [...(wakeOnLine ? preceding : recentWake), line];

    const question = line.text.trim();
    const vocative = window.some((entry) => this.isVocative(this.matchText(entry)));
    const defer = this.lexicalDefer(question) || window.some((entry) => this.lexicalDefer(entry.text));
    const event: WakeEvent = {
      ts: line.ts,
      ...(line.speaker ? { asker: line.speaker } : {}),
      question,
      contextLines: window.map((entry) => ({ ...entry })),
      defer,
    };

    if (!vocative) {
      const verdict = await this.classify(line.speaker, question, window);
      event.defer = defer || verdict.defer;
      if (!verdict.addressed) {
        event.ambiguous = true;
        return event;
      }
    }

    return this.publish(event, Date.parse(line.ts));
  }

  /** At most one clarifying line for the whole meeting. */
  clarifyOnce(event: WakeEvent): string | null {
    if (!this.options.config.wake.allow_clarify) return null;
    if (!event.ambiguous) return null;
    if (this.clarifyCount >= 1) return null;
    this.clarifyCount += 1;
    event.clarifyUsed = true;
    return "Sorry, was that meant for me?";
  }

  canReply(_now = Date.now()): boolean {
    if (!this.pending || this.answered || this.pending.ambiguous) return false;
    return this.replyCount < this.options.config.limits.max_replies;
  }

  markReplied(): void {
    if (!this.pending || this.answered) return;
    this.answered = true;
    this.replyCount += 1;
  }

  private publish(event: WakeEvent, atMs: number): WakeEvent {
    if (this.pending && !this.answered && Number.isFinite(atMs) && atMs - this.pendingAt <= 5_000) {
      const merged: WakeEvent = {
        ...this.pending,
        ts: event.ts,
        question: `${this.pending.question}\n${event.question}`,
        contextLines: [...this.pending.contextLines, ...event.contextLines],
        asker: this.pending.asker ?? event.asker,
        defer: Boolean(this.pending.defer || event.defer),
      };
      this.pending = merged;
      this.pendingAt = atMs;
      return merged;
    }
    this.pending = event;
    this.pendingAt = Number.isFinite(atMs) ? atMs : Date.now();
    this.answered = false;
    return event;
  }

  private blocked(line: TranscriptLine): boolean {
    if (this.speaking || line.is_self) return true;
    return namesMatch(line.speaker, this.options.config.bot_name);
  }

  private hasWake(text: string): boolean {
    const haystack = words(text);
    return this.options.config.wake_names.some((wake) => phraseIn(haystack, words(wake)));
  }

  private isVocative(text: string): boolean {
    const loose = text.toLowerCase().replace(/[’]/g, "'");
    return this.options.config.wake_names.some((wake) => {
      const needle = words(wake).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(
        `(?:^|\\b(?:hey|hi|yo|ok|okay)\\s+)${needle}\\b|\\b${needle}\\s*,`,
        "i",
      );
      return pattern.test(loose);
    });
  }

  private matchText(line: TranscriptLine): string {
    if (!this.options.config.wake_names.some((wake) => namesMatch(line.speaker, wake))) return line.text;
    const stripped = line.text.replace(
      new RegExp(`^\\s*${escapeRegExp(line.speaker)}\\s*[,:]?\\s*`, "i"),
      "",
    );
    return stripped;
  }

  private lexicalDefer(text: string): boolean {
    const haystack = words(text);
    return this.options.config.defer_phrases.some((phrase) => haystack.includes(words(phrase)));
  }

  private async classify(
    speaker: string,
    question: string,
    window: TranscriptLine[],
  ): Promise<{ addressed: boolean; defer: boolean }> {
    const key = `${words(question)}|${words(speaker)}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const classifier = this.options.classifier;
    if (!classifier) {
      const verdict = { addressed: false, defer: this.lexicalDefer(question) };
      this.cache.set(key, verdict);
      return verdict;
    }
    this.classifierCalls += 1;
    const verdict = await classifier.classify({
      speaker,
      question,
      context: window.map((line) => `${line.speaker}: ${line.text}`).join("\n"),
    });
    this.cache.set(key, verdict);
    return verdict;
  }
}

export function hasRequestForm(text: string): boolean {
  return REQUEST_FORM.test(text);
}

function words(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function phraseIn(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)${escaped}(?:$|\\s)`, "i").test(haystack);
}

function namesMatch(left: string, right: string): boolean {
  return words(left) === words(right);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function withinMs(earlier: TranscriptLine, later: TranscriptLine, ms: number): boolean {
  const delta = Date.parse(later.ts) - Date.parse(earlier.ts);
  return Number.isFinite(delta) && delta >= 0 && delta <= ms;
}
