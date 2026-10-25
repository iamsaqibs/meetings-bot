import path from "node:path";
import type { Browser, Page } from "puppeteer";
import { adaptPage, joinMeeting, joinPage, launchBrowser, readPageSnapshot } from "../auth/joiner.js";
import {
  generateReply as defaultGenerateReply,
  type GenerateReplyInput,
  type GenerateReplyResult,
} from "../brain/agent.js";
import { ensureBrainReachable } from "../brain/ollama.js";
import { attachCaptions, type CaptionController } from "../captions/source.js";
import type { AppConfig } from "../config/schema.js";
import { loadConfig, mergeCliFlags } from "../config/load.js";
import type { Brief } from "../context/brief.js";
import { loadBrief } from "../context/brief.js";
import { startLeaveWatch, type LeaveSignals } from "../lifecycle/leave.js";
import { nextNoteNumber } from "../notes/numbering.js";
import { summarizeMeeting } from "../notes/summarizer.js";
import { writeNotesFile } from "../notes/writer.js";
import { exitCodeFor, installMeetingSignals } from "../lifecycle/signals.js";
import { logger } from "../logging/logger.js";
import { installAudioBridge, speakSequence } from "../speaker/injector.js";
import type { TranscriptLine, WakeEvent } from "../transcript/types.js";
import { TranscriptStore } from "../transcript/store.js";
import { playbackSeconds } from "../tts/audio.js";
import { TtsError } from "../tts/errors.js";
import { createTtsProvider, warmupTts, type TtsAudio, type TtsProvider } from "../tts/provider.js";
import { splitSentences } from "../tts/sentences.js";
import { WakeDetector } from "../wake/detector.js";
import { postMeetChat } from "./chatChannel.js";
import { DEFER_LINE } from "./deferPhrases.js";
import { decideGate, followupFromReply, replyHash } from "./gates.js";
import { applyRehearse } from "./rehearse.js";

const SLOW_REPLY_MS = 10_000;
const COALESCE_MS = 400;

export interface SpeechPorts {
  generateReply: (input: GenerateReplyInput) => Promise<GenerateReplyResult>;
  synthesize: (sentence: string) => Promise<TtsAudio>;
  speak: (chunks: TtsAudio[]) => Promise<number>;
  postChat: (text: string) => Promise<void>;
  now?: () => number;
  note?: (entry: TurnNote) => void;
}

export interface TurnNote {
  kind: "reply" | "defer" | "skip" | "clarify" | "degrade" | "slow_reply" | "gate";
  detail: string;
  at: string;
}

export interface QaRecord {
  ts: string;
  asker?: string;
  question: string;
  answer: string;
  channel: "audio" | "chat";
}

export interface MeetingStats {
  replies: number;
  talkSeconds: number;
  chatFallbacks: number;
  skippedRepeats: number;
  slowReplies: number;
}

export interface TurnState {
  config: AppConfig;
  brief: Brief;
  detector: WakeDetector;
  store: TranscriptStore;
  talkSeconds: number;
  followups: string[];
  hashes: Set<string>;
  chatOnly: boolean;
  qa: QaRecord[];
  rehearse: boolean;
  coalesceMs: number;
  lastActivityAt: number;
  stats: MeetingStats;
  openWake: WakeEvent | null;
  flushing: Promise<void> | null;
  feedTail: Promise<void>;
}

export interface MeetingResult {
  transcriptPath: string;
  notesPath?: string;
  stats: MeetingStats;
  followups: string[];
  qa: QaRecord[];
  exitCode: number;
  partial: boolean;
}

export function createTurnState(input: {
  config: AppConfig;
  brief: Brief;
  store: TranscriptStore;
  rehearse?: boolean;
  coalesceMs?: number;
  chatOnly?: boolean;
  detector?: WakeDetector;
}): TurnState {
  return {
    config: input.config,
    brief: input.brief,
    detector: input.detector ?? new WakeDetector({ config: input.config }),
    store: input.store,
    talkSeconds: 0,
    followups: [],
    hashes: new Set(),
    chatOnly: input.chatOnly ?? false,
    qa: [],
    rehearse: input.rehearse ?? false,
    coalesceMs: input.coalesceMs ?? COALESCE_MS,
    lastActivityAt: Date.now(),
    stats: { replies: 0, talkSeconds: 0, chatFallbacks: 0, skippedRepeats: 0, slowReplies: 0 },
    openWake: null,
    flushing: null,
    feedTail: Promise.resolve(),
  };
}

/** Feed one caption. Near-simultaneous wakes collapse into the open question before a reply starts. */
export function handleCaption(state: TurnState, line: TranscriptLine, ports: SpeechPorts): Promise<void> {
  const ingested = state.feedTail.then(() => ingest(state, line));
  state.feedTail = ingested.then(
    () => undefined,
    () => undefined,
  );
  return ingested.then(async (event) => {
    if (!event) return;
    if (state.coalesceMs <= 0) {
      await flushWake(state, ports);
      return;
    }
    await ensureFlush(state, ports);
  });
}

async function ingest(state: TurnState, line: TranscriptLine): Promise<WakeEvent | null> {
  state.store.append(line);
  state.lastActivityAt = Date.now();
  const event = await state.detector.feed(line);
  if (state.rehearse) {
    logger.info(
      {
        speaker: line.speaker,
        text: line.text,
        fired: Boolean(event),
        ambiguous: event?.ambiguous ?? false,
        defer: event?.defer ?? false,
      },
      "wake-gate",
    );
  }
  if (event) state.openWake = event;
  return event;
}

function ensureFlush(state: TurnState, ports: SpeechPorts): Promise<void> {
  state.flushing ??= wait(state.coalesceMs)
    .then(() => flushWake(state, ports))
    .finally(() => {
      state.flushing = null;
    });
  return state.flushing;
}

async function flushWake(state: TurnState, ports: SpeechPorts): Promise<void> {
  const event = state.openWake;
  state.openWake = null;
  if (!event) return;
  await produceReply(state, event, ports);
}

async function produceReply(state: TurnState, event: WakeEvent, ports: SpeechPorts): Promise<void> {
  if (event.ambiguous) {
    const clarify = state.detector.clarifyOnce(event);
    const blocked = decideGate(gateInput(state, false)) === "rate_limit";
    if (clarify && !blocked) await deliver(state, ports, event, clarify, "clarify");
    else {
      note(ports, { kind: "gate", detail: blocked ? "rate_limit" : "ambiguous", at: event.ts });
      logger.info({ question: event.question }, "wake stayed silent");
    }
    state.detector.markReplied();
    return;
  }

  const gate = decideGate(gateInput(state, Boolean(event.defer)));
  switch (gate) {
    case "rate_limit":
      note(ports, { kind: "skip", detail: "rate_limit", at: event.ts });
      logger.info(
        { replies: state.detector.repliesUsed, talkSeconds: state.talkSeconds },
        "rate limit reached; staying silent",
      );
      return;
    case "defer":
      await deliver(state, ports, event, DEFER_LINE, "defer");
      state.detector.markReplied();
      return;
    case "reply":
      await answerFromBrain(state, event, ports);
      state.detector.markReplied();
      return;
    default: {
      const unexpected: never = gate;
      throw new Error(`Unhandled gate ${String(unexpected)}`);
    }
  }
}

async function answerFromBrain(state: TurnState, event: WakeEvent, ports: SpeechPorts): Promise<void> {
  const now = ports.now ?? Date.now;
  const started = now();
  const input: GenerateReplyInput = {
    question: event.question,
    transcriptExcerpt: state.store.lastNonSelf(80),
    brief: state.brief,
    config: state.config,
  };
  let result = await ports.generateReply(input);
  let brainMs = now() - started;
  rememberFollowup(state, result.text, event.question);
  rememberFiles(state, result.usedFiles, now());
  let text = result.text.trim();
  let hash = replyHash(text);
  if (state.hashes.has(hash)) {
    const rephraseStarted = now();
    result = await ports.generateReply({
      ...input,
      extraContext: "Rephrase this so it is not a verbatim repeat of an earlier reply in this meeting.",
    });
    brainMs += now() - rephraseStarted;
    rememberFollowup(state, result.text, event.question);
    rememberFiles(state, result.usedFiles, now());
    const rehashed = replyHash(result.text);
    if (state.hashes.has(rehashed)) {
      state.stats.skippedRepeats += 1;
      logger.warn({ hash: rehashed }, "skipped a verbatim repeat");
      note(ports, { kind: "skip", detail: "verbatim repeat", at: event.ts });
      return;
    }
    text = result.text.trim();
    hash = rehashed;
  }
  if (!text) {
    logger.warn({ question: event.question }, "empty reply skipped");
    return;
  }
  state.hashes.add(hash);
  const ttsStarted = now();
  await deliver(state, ports, event, text, "reply");
  const ttsMs = now() - ttsStarted;
  const wakeToFirstSoundMs = now() - started;
  logger.info({ wakeToFirstSoundMs, brainMs, ttsMs }, "wake→first-sound");
  if (wakeToFirstSoundMs > SLOW_REPLY_MS) {
    state.stats.slowReplies += 1;
    logger.warn({ wakeToFirstSoundMs, brainMs, ttsMs }, "slow_reply");
    note(ports, {
      kind: "slow_reply",
      detail: `${wakeToFirstSoundMs}ms brain=${brainMs} tts=${ttsMs}`,
      at: event.ts,
    });
  }
}

async function deliver(
  state: TurnState,
  ports: SpeechPorts,
  event: WakeEvent,
  text: string,
  kind: "reply" | "defer" | "clarify",
): Promise<void> {
  const channel = await speakOrChat(state, ports, text, event.ts);
  state.qa.push({
    ts: event.ts,
    ...(event.asker ? { asker: event.asker } : {}),
    question: event.question,
    answer: text,
    channel,
  });
  if (kind !== "clarify") state.stats.replies += 1;
  note(ports, { kind, detail: text, at: event.ts });
}

async function speakOrChat(
  state: TurnState,
  ports: SpeechPorts,
  text: string,
  at: string,
): Promise<"audio" | "chat"> {
  if (state.chatOnly) return postFallback(state, ports, text, at, "TTS is in chat-only mode");
  state.detector.setSpeaking(true);
  try {
    const chunks: TtsAudio[] = [];
    for (const sentence of splitSentences(text)) chunks.push(await ports.synthesize(sentence));
    const seconds = await ports.speak(chunks);
    state.talkSeconds += seconds;
    state.stats.talkSeconds = state.talkSeconds;
    appendSelf(state, text, "tts", at);
    return "audio";
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return postFallback(state, ports, text, at, detail);
  } finally {
    state.detector.setSpeaking(false);
  }
}

async function postFallback(
  state: TurnState,
  ports: SpeechPorts,
  text: string,
  at: string,
  detail: string,
): Promise<"chat"> {
  state.chatOnly = true;
  state.stats.chatFallbacks += 1;
  logger.warn({ detail }, "TTS failed; posting the full reply to Meet chat");
  await ports.postChat(text);
  appendSelf(state, text, "chat", at);
  note(ports, { kind: "degrade", detail: text, at });
  return "chat";
}

function rememberFollowup(state: TurnState, reply: string, question: string): void {
  const followup = followupFromReply(reply, question);
  if (followup && !state.followups.includes(followup)) state.followups.push(followup);
}

function rememberFiles(state: TurnState, files: string[], atMs: number): void {
  if (files.length === 0) return;
  logger.info({ usedFiles: files }, "read files");
  state.store.append({
    ts: new Date(atMs).toISOString(),
    speaker: state.config.bot_name,
    text: `read files: ${files.join(", ")}`,
    is_self: true,
    source: "system",
  });
}

function appendSelf(state: TurnState, text: string, source: "tts" | "chat", at: string): void {
  state.store.append({
    ts: at,
    speaker: state.config.bot_name,
    text,
    is_self: true,
    source,
  });
}

function gateInput(state: TurnState, defer: boolean): Parameters<typeof decideGate>[0] {
  return {
    defer,
    repliesUsed: state.detector.repliesUsed,
    maxReplies: state.config.limits.max_replies,
    talkSeconds: state.talkSeconds,
    maxTalkSeconds: state.config.limits.max_talk_seconds,
  };
}

function note(ports: SpeechPorts, entry: TurnNote): void {
  ports.note?.(entry);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface MeetingRunOptions {
  meeting: string;
  project: string;
  headed?: boolean;
  rehearse?: boolean;
  name?: string;
  model?: string;
}

/** Join, listen, answer, and write notes when the call ends. */
export async function runMeeting(options: MeetingRunOptions): Promise<MeetingResult> {
  let config = mergeCliFlags(loadConfig(), { name: options.name, model: options.model });
  if (options.rehearse) config = applyRehearse(config);
  const brief = await loadBrief(options.project);
  await ensureBrainReachable(config);

  let provider: TtsProvider | null = null;
  let chatOnly = false;
  try {
    provider = createTtsProvider(config);
    await warmupTts(provider);
  } catch (err) {
    chatOnly = true;
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn({ detail }, "TTS warmup failed; replies will go to Meet chat");
  }

  const notesDir = path.join(options.project, "meeting-notes");
  const nnn = nextNoteNumber(notesDir);
  const transcriptPath = path.join(notesDir, ".raw", `${nnn}-transcript.jsonl`);
  const store = new TranscriptStore(transcriptPath);
  const state = createTurnState({
    config,
    brief,
    store,
    rehearse: Boolean(options.rehearse),
    chatOnly,
  });
  const browser = await launchBrowser("join", { headed: options.headed });
  const page = await joinPage(browser);
  return driveMeeting(options, state, browser, page, provider, transcriptPath, nnn);
}

async function driveMeeting(
  options: MeetingRunOptions,
  state: TurnState,
  browser: Browser,
  page: Page,
  provider: TtsProvider | null,
  transcriptPath: string,
  nnn: string,
): Promise<MeetingResult> {
  let stop: "clean" | "interrupt" | "crash" = "clean";
  let ended = false;
  const restore = installMeetingSignals({
    onInterrupt: () => {
      stop = "interrupt";
      ended = true;
    },
    onCrash: (err) => {
      stop = "crash";
      ended = true;
      logger.error({ err }, "uncaught error; stopping the meeting");
    },
  });
  let captions: CaptionController | null = null;
  let failure: unknown;
  const ports = livePorts(page, provider, state);
  const idleTimeoutMs = state.config.meet.idle_timeout_minutes * 60_000;
  const watch = startLeaveWatch({
    idleTimeoutMs,
    readSignals: () => readLeave(browser, page, state),
    onLeave: (reason) => {
      stop = reason === "browser" ? "crash" : "clean";
      ended = true;
    },
  });
  try {
    await installAudioBridge(page);
    await joinMeeting(adaptPage(page), options.meeting, { displayName: state.config.bot_name });
    captions = await attachCaptions(page, state.config, (line) => {
      void handleCaption(state, line, ports).catch((err: unknown) => {
        logger.error({ err }, "caption turn failed");
      });
    });
    while (!ended) await wait(200);
  } catch (err) {
    failure = err;
    stop = "crash";
  } finally {
    watch.stop();
    restore();
    await captions?.stop().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }

  const partial = stop !== "clean";
  let notesPath: string | undefined;
  try {
    notesPath = await persistNotes(options.project, nnn, state, transcriptPath, partial);
  } catch (err) {
    logger.error({ err }, "Notes could not be written. The raw transcript is still on disk.");
    if (!failure) failure = err;
  } finally {
    state.store.close();
  }
  if (failure instanceof Error) throw failure;
  return {
    transcriptPath,
    ...(notesPath ? { notesPath } : {}),
    stats: { ...state.stats, talkSeconds: state.talkSeconds },
    followups: [...state.followups],
    qa: [...state.qa],
    exitCode: exitCodeFor(stop),
    partial,
  };
}

async function persistNotes(
  project: string,
  nnn: string,
  state: TurnState,
  transcriptPath: string,
  partial: boolean,
): Promise<string> {
  const lines = state.store.lines();
  const draft = await summarizeMeeting({
    lines,
    followups: state.followups,
    config: state.config,
    botName: state.config.bot_name,
  });
  const written = writeNotesFile({
    projectDir: project,
    nnn,
    when: new Date(),
    slugQuestion: state.qa[0]?.question,
    draft,
    qa: state.qa,
    lines,
    transcriptPath,
    partial,
  });
  logger.info({ notesPath: written.notesPath, partial }, "notes written");
  return written.notesPath;
}

function livePorts(page: Page, provider: TtsProvider | null, state: TurnState): SpeechPorts {
  return {
    generateReply: defaultGenerateReply,
    async synthesize(sentence: string): Promise<TtsAudio> {
      if (!provider) throw new TtsError("TTS is unavailable. The reply will be posted in Meet chat.");
      return provider.synthesize(sentence);
    },
    async speak(chunks: TtsAudio[]): Promise<number> {
      await speakSequence(page, chunks, state.config.tts.gain, {
        setSpeaking: (active) => state.detector.setSpeaking(active),
      });
      return playbackSeconds(chunks);
    },
    postChat: (text) => postMeetChat(page, text),
  };
}

async function readLeave(browser: Browser, page: Page, state: TurnState): Promise<LeaveSignals> {
  if (!browser.connected) {
    return { banner: false, captionsIdleMs: Number.POSITIVE_INFINITY, browserClosed: true };
  }
  try {
    const snapshot = await readPageSnapshot(page);
    return {
      banner: snapshot.left,
      captionsIdleMs: Date.now() - state.lastActivityAt,
      browserClosed: false,
    };
  } catch {
    return { banner: false, captionsIdleMs: Date.now() - state.lastActivityAt, browserClosed: true };
  }
}
