import { z } from "zod";

/** Marker values written into the first-run template. A load warns while any remain. */
export const PLACEHOLDER_WAKE_NAME = "CHANGE ME — wake name";
export const PLACEHOLDER_BOT_NAME = "CHANGE ME — your assistant's name";
export const PLACEHOLDER_MODEL = "CHANGE ME — ollama model";

export const CONFIG_DEFAULTS = {
  ollama: {
    base_url: "http://localhost:11434/v1",
    temperature: 0.3,
    max_context_tokens: 24000,
  },
  tts: {
    provider: "kokoro" as const,
    voice: "af_heart",
    gain: 1,
  },
  limits: {
    max_reply_words: 150,
    max_replies: 15,
    max_talk_seconds: 600,
  },
  wake: {
    allow_clarify: true,
    finalize_ms: 1500,
  },
  defer_phrases: [
    "estimate",
    "approval",
    "would saqib prefer",
    "saqib's schedule",
    "budget",
    "sign-off",
    "timeline commitment",
  ],
  meet: {
    idle_timeout_minutes: 8,
  },
  captions: {
    ariaLabels: ["Captions"],
  },
};

const ollamaSchema = z.object({
  base_url: z.string().min(1),
  model: z.string().min(1),
  temperature: z.number(),
  max_context_tokens: z.number().int().positive(),
});

const ttsSchema = z.object({
  provider: z.enum(["kokoro", "edge"]),
  voice: z.string().min(1),
  gain: z.number(),
});

const limitsSchema = z.object({
  max_reply_words: z.number().int().positive(),
  max_replies: z.number().int().positive(),
  max_talk_seconds: z.number().int().positive(),
});

const wakeSchema = z.object({
  allow_clarify: z.boolean(),
  finalize_ms: z.number().int().positive(),
});

const meetSchema = z.object({
  idle_timeout_minutes: z.number().positive(),
});

const captionsSchema = z.object({
  ariaLabels: z.array(z.string().min(1)).min(1),
});

export const AppConfigSchema = z.object({
  wake_names: z.array(z.string().min(1)).min(1),
  bot_name: z.string().min(1),
  ollama: ollamaSchema,
  tts: ttsSchema,
  limits: limitsSchema,
  wake: wakeSchema,
  defer_phrases: z.array(z.string()),
  meet: meetSchema,
  captions: captionsSchema,
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

export const CONFIG_TEMPLATE = `# meetings-bot configuration
# Runtime home: ~/.meetings-bot/ (override with $MEETINGS_BOT_HOME).
# The Chromium profile, brief cache, and logs live here — never inside a repo.
# Required fields are marked CHANGE ME. Every other field has a default.

# Phrases matched against caption text (case-insensitive). At least one. Required.
wake_names:
  - "${PLACEHOLDER_WAKE_NAME}"

# Display name of the dedicated Google account. Required.
# Meet shows this name; it is also how the bot recognizes its own captions.
bot_name: "${PLACEHOLDER_BOT_NAME}"

ollama:
  # OpenAI-compatible endpoint of the local Ollama daemon.
  base_url: "http://localhost:11434/v1"
  # Tool-capable cloud model. Required. See PLAN § 4 if a model has been retired.
  model: "${PLACEHOLDER_MODEL}"
  temperature: 0.3
  # Sliding-window cap for the in-meeting transcript (FR-4).
  max_context_tokens: 24000

tts:
  # kokoro (local, default) or edge (unofficial Microsoft neural voices).
  provider: "kokoro"
  # Kokoro voice id (af_heart) or an Edge voice such as en-US-AndrewMultilingualNeural.
  voice: "af_heart"
  # Programmatic boost. Raise it if Chrome AGC makes the bot too quiet.
  gain: 1.0

limits:
  max_reply_words: 150
  max_replies: 15
  max_talk_seconds: 600

wake:
  # At most one clarifying question per ambiguity when this is true.
  allow_clarify: true
  # How long caption text must stay unchanged before a line is finalized.
  finalize_ms: 1500

# Commitment / preference phrasing that triggers a deferral (FR-8).
defer_phrases:
  - "estimate"
  - "approval"
  - "would saqib prefer"
  - "saqib's schedule"
  - "budget"
  - "sign-off"
  - "timeline commitment"

meet:
  # No finalized captions for this many minutes → treat the meeting as ended.
  idle_timeout_minutes: 8

captions:
  # Tried in order. Add a localized label here if Meet is not en-US. No code change.
  ariaLabels:
    - "Captions"
`;
