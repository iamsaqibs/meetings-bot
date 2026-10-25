import { createHash } from "node:crypto";

export type GateKind = "defer" | "rate_limit" | "reply";

/**
 * Deferral wins over the participation ceiling, and the ceiling wins over a normal reply.
 * A deferred question still gets the exact FR-8 sentence; a capped meeting stays silent.
 */
export function decideGate(input: {
  defer: boolean;
  repliesUsed: number;
  maxReplies: number;
  talkSeconds: number;
  maxTalkSeconds: number;
}): GateKind {
  if (input.defer) return "defer";
  if (input.repliesUsed >= input.maxReplies || input.talkSeconds >= input.maxTalkSeconds) return "rate_limit";
  return "reply";
}

export function replyHash(text: string): string {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalized).digest("hex");
}

/** Hard rule 3: these tells mean the question is recorded for the notes. */
export function followupFromReply(reply: string, question: string): string | null {
  const lower = reply.toLowerCase();
  if (lower.includes("i don't have that in the project") || lower.includes("i can check after the call")) {
    return question;
  }
  return null;
}
