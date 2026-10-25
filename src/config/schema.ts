import { z } from "zod";

export const AppConfigSchema = z.object({
  wake_names: z.array(z.string()).min(1),
  bot_name: z.string().min(1),
  ollama: z.object({
    base_url: z.string(),
    model: z.string().min(1),
    temperature: z.number(),
    max_context_tokens: z.number().int().positive(),
  }),
  tts: z.object({
    provider: z.enum(["kokoro", "edge"]),
    voice: z.string(),
    gain: z.number(),
  }),
  limits: z.object({
    max_reply_words: z.number().int().positive(),
    max_replies: z.number().int().positive(),
    max_talk_seconds: z.number().int().positive(),
  }),
  wake: z.object({
    allow_clarify: z.boolean(),
    finalize_ms: z.number().int().positive(),
  }),
  defer_phrases: z.array(z.string()),
  meet: z.object({
    idle_timeout_minutes: z.number().positive(),
  }),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
