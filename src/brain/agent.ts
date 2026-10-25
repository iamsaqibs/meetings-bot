import type { AppConfig } from "../config/schema.js";
import type { Brief } from "../context/brief.js";
import { describeReadResult, readProjectFile } from "../context/reader.js";
import { logger } from "../logging/logger.js";
import type { TranscriptLine } from "../transcript/types.js";
import { DEFER_LINE } from "../agent/deferPhrases.js";
import { chat, type ChatMessage, type ToolCall } from "./ollama.js";

const BEHAVIOR_POLICY = `Behavior policy:
1. Never speaks unless a valid wake event occurred this turn.
2. Never repeats itself verbatim within one meeting.
3. Never invents project facts — if not in the brief or readable files: "I don't have that in the project — I can check the repo after the call" (and it genuinely adds it to the notes follow-ups).
4. No political/personal opinions; no commitments on Saqib's behalf (FR-8).
5. Total participation ceiling (config, default: 15 wake replies or 10 minutes of talk time per meeting).`;

const READ_FILE_TOOL = {
  type: "function",
  function: {
    name: "read_file",
    description:
      "Read a text file inside the project directory. Paths outside the project root are refused. Use this when the brief does not contain the fact you need.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the project root" },
      },
      required: ["path"],
    },
  },
};

export interface GenerateReplyInput {
  question: string;
  transcriptExcerpt: TranscriptLine[];
  brief: Brief;
  extraContext?: string;
  config: AppConfig;
}

export interface GenerateReplyResult {
  text: string;
  usedFiles: string[];
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function trimToWordCap(text: string, maxWords: number): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (!trimmed) return "";
  const words = trimmed.split(" ");
  if (words.length <= maxWords) return trimmed;
  const clipped = words.slice(0, maxWords).join(" ");
  const boundary = Math.max(clipped.lastIndexOf("."), clipped.lastIndexOf("!"), clipped.lastIndexOf("?"));
  if (boundary > 0) return clipped.slice(0, boundary + 1).trim();
  return clipped;
}

export function buildSystemPrompt(input: GenerateReplyInput): string {
  const policyAndPersona = [
    "You are Saqib's meeting assistant. You are in the call as a second participant. Speak only the answer to the latest question addressed to you.",
    BEHAVIOR_POLICY,
    `Questions about commitments, estimates, approval, schedule, or what Saqib would prefer get this deferral and nothing more: "${DEFER_LINE}"`,
    `Answer in at most ${input.config.limits.max_reply_words} words of plain spoken prose. No markdown, no bullet lists, no headings, and no code fences. The answer will be read aloud.`,
  ].join("\n\n");

  const budget = input.config.ollama.max_context_tokens;
  const reserved = estimateTokens(policyAndPersona) + estimateTokens(input.question) + estimateTokens(input.extraContext ?? "") + 32;
  let remaining = Math.max(0, budget - reserved);

  const visible = input.transcriptExcerpt.filter((line) => !line.is_self);
  const kept: TranscriptLine[] = [];
  let transcriptTokens = 0;
  for (const line of [...visible].reverse()) {
    const rendered = renderLine(line);
    const cost = estimateTokens(rendered);
    if (kept.length > 0 && transcriptTokens + cost > remaining) break;
    kept.push(line);
    transcriptTokens += cost;
  }
  kept.reverse();
  remaining = Math.max(0, remaining - transcriptTokens);

  let seed = input.brief.seedText;
  const seedBudgetChars = remaining * 4;
  if (seed.length > seedBudgetChars) {
    seed = `${seed.slice(0, Math.max(0, seedBudgetChars))}\n(brief truncated for context window)`;
  }

  const transcript =
    kept.length === 0 ? "(no transcript yet)" : kept.map((line) => renderLine(line)).join("\n");

  return [
    policyAndPersona,
    `Project: ${input.brief.projectDir}`,
    "Project brief:",
    seed || "(empty brief)",
    "Transcript excerpt:",
    transcript,
  ].join("\n\n");
}

export async function generateReply(input: GenerateReplyInput): Promise<GenerateReplyResult> {
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(input) },
    { role: "user", content: userTurn(input) },
  ];
  const usedFiles: string[] = [];
  const opts = {
    baseUrl: input.config.ollama.base_url,
    model: input.config.ollama.model,
    temperature: input.config.ollama.temperature,
    tools: [READ_FILE_TOOL],
  };

  for (let round = 0; round < 3; round += 1) {
    const assistant = await chat(messages, opts);
    messages.push(assistant);
    const calls = assistant.tool_calls ?? [];
    if (calls.length === 0) {
      return { text: trimToWordCap(assistant.content ?? "", input.config.limits.max_reply_words), usedFiles };
    }
    for (const call of calls) {
      const outcome = await runReadFile(input.brief.projectDir, call);
      if (outcome.usedFile) usedFiles.push(outcome.usedFile);
      messages.push({ role: "tool", tool_call_id: call.id, content: outcome.text });
    }
  }

  const final = await chat(messages, { ...opts, tools: undefined });
  return {
    text: trimToWordCap(final.content ?? "", input.config.limits.max_reply_words),
    usedFiles: [...new Set(usedFiles)],
  };
}

function userTurn(input: GenerateReplyInput): string {
  const extra = input.extraContext?.trim();
  if (!extra) return input.question;
  return `${input.question}\n\n${extra}`;
}

function renderLine(line: TranscriptLine): string {
  return `[${line.ts}] ${line.speaker}: ${line.text}`;
}

async function runReadFile(
  projectDir: string,
  call: ToolCall,
): Promise<{ text: string; usedFile?: string }> {
  const requested = parsePath(call.function.arguments);
  if (isOutsideAttempt(requested)) {
    logger.warn({ path: requested }, "stripped a read_file path outside the project");
  }
  const result = await readProjectFile(projectDir, requested);
  if (!result.ok) {
    logger.warn({ path: requested, reason: result.reason }, "read_file refused");
  }
  return {
    text: describeReadResult(result),
    ...(result.ok ? { usedFile: result.path } : {}),
  };
}

function parsePath(args: string): string {
  try {
    const parsed = JSON.parse(args) as { path?: unknown };
    if (typeof parsed.path === "string") return parsed.path;
  } catch {
    // The model sometimes streams a bare path instead of JSON. The reader still refuses escapes.
  }
  return args.trim();
}

function isOutsideAttempt(requested: string): boolean {
  return requested.startsWith("~") || requested.startsWith("/") || requested.includes("..");
}
