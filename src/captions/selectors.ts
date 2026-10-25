/** Caption DOM strings. This is the only captions module that may contain them. */

export const DEFAULT_CAPTION_LABELS = ["Captions"] as const;

export const JSNAME_SELECTORS = ["tgaKEf", "YSxPC"] as const;

export const CAPTION_KEY = "c";

export const CC_BUTTON_LABELS = ["Turn on captions", "Turn off captions"] as const;

export const CAPTION_ROW_HINTS = {
  avatar: "img",
  self: "data-self-name",
  live: "aria-live",
  region: "region",
} as const;

/** Material icon ligatures are snake_case. Real names are not. */
export function isIconAlt(alt: string): boolean {
  return /^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(alt.trim());
}

export const SPEAKER_SPAN_MAX = 32;
