import { z } from "zod";
import { chat as defaultChat, type ChatMessage, type ChatOptions } from "../brain/ollama.js";
import type { AppConfig } from "../config/schema.js";
import { logger } from "../logging/logger.js";
import type { TranscriptLine } from "../transcript/types.js";
import type { NotesDraft } from "./types.js";

const notesSchema = z.object({
  summary: z.string(),
  decisions: z.array(z.string()),
  actions: z.array(z.object({ text: z.string(), owner: z.string().optional() })),
  followups: z.array(z.string()),
});

const SYSTEM = `You summarize a meeting for Saqib. Never invent facts that are not in the transcript.
Attribute each decision and action to the speaker who said it. If the owner is unclear, use "unattributed".
Every promise to check something after the call becomes an action whose owner is the bot.
Return only JSON with this shape: {"summary":"","decisions":[],"actions":[{"text":"","owner":""}],"followups":[]}`;

export async function summarizeMeeting(input: {
  lines: TranscriptLine[];
  followups: string[];
  config: AppConfig;
  botName: string;
  chat?: (messages: ChatMessage[], opts: ChatOptions) => Promise<ChatMessage>;
}): Promise<NotesDraft> {
  const complete = input.chat ?? defaultChat;
  const transcript = input.lines.map((line) => `[${line.ts}] ${line.speaker}: ${line.text}`).join("\n");
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content: `Bot name: ${input.botName}\nKnown follow-ups to keep: ${input.followups.join(" | ") || "(none)"}\n\nTranscript:\n${transcript || "(empty)"}`,
    },
  ];
  const opts: ChatOptions = {
    baseUrl: input.config.ollama.base_url,
    model: input.config.ollama.model,
    temperature: 0,
  };
  let last = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await complete(messages, opts);
    last = response.content ?? "";
    const parsed = readDraft(last, input.botName);
    if (parsed) return mergeDraft(parsed, input.followups, input.lines, input.botName);
    messages.push({ role: "assistant", content: last });
    messages.push({
      role: "user",
      content: "That was not valid JSON. Return only the JSON object, with no markdown.",
    });
    logger.warn({ attempt }, "notes summarizer returned invalid JSON; retrying once");
  }
  logger.warn("notes summarizer failed twice; writing the transcript without a model summary");
  return mergeDraft(
    {
      summary: "Summary unavailable because the model did not return valid JSON. The transcript was kept.",
      decisions: [],
      actions: [],
      followups: [],
    },
    input.followups,
    input.lines,
    input.botName,
  );
}

export function readDraft(raw: string, botName: string): NotesDraft | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced?.[1] ?? raw).trim();
  try {
    const value = notesSchema.parse(JSON.parse(body));
    return {
      summary: value.summary.trim(),
      decisions: value.decisions.map((item) => item.trim()).filter(Boolean),
      actions: value.actions
        .map((action) => ({ text: action.text.trim(), owner: normalizeOwner(action.owner, botName) }))
        .filter((action) => action.text.length > 0),
      followups: value.followups.map((item) => item.trim()).filter(Boolean),
    };
  } catch {
    return null;
  }
}

function mergeDraft(draft: NotesDraft, followups: string[], lines: TranscriptLine[], botName: string): NotesDraft {
  const actions = [...draft.actions];
  for (const line of lines) {
    if (!/i can check after the call/i.test(line.text)) continue;
    if (actions.some((action) => action.text === line.text)) continue;
    actions.push({ text: line.text, owner: botName });
  }
  return {
    ...draft,
    actions,
    followups: unique([...draft.followups, ...followups]),
  };
}

function normalizeOwner(owner: string | undefined, botName: string): string {
  const trimmed = owner?.trim() ?? "";
  if (!trimmed || /^(unknown|unattributed|n\/a|none)$/i.test(trimmed)) return "unattributed";
  if (/^bot$/i.test(trimmed)) return botName;
  return trimmed;
}

function unique(items: string[]): string[] {
  return [...new Set(items.filter((item) => item.trim().length > 0))];
}
