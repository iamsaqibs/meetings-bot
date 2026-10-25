import type { AppConfig } from "../config/schema.js";

/** Rehearsal is where wake and voice get tuned: always allow one clarify, and allow longer answers. */
export function applyRehearse(config: AppConfig): AppConfig {
  return {
    ...config,
    wake: { ...config.wake, allow_clarify: true },
    limits: { ...config.limits, max_reply_words: config.limits.max_reply_words * 2 },
  };
}
