/** Meet and Google account DOM strings. This is the only auth module that may contain them. */

export const SIGN_IN_URL = "https://accounts.google.com/signin";

export const CAMERA_ON_LABEL = "Turn off camera";
export const MIC_ON_LABEL = "Turn off microphone";

export const JOIN_LABELS = ["Join now", "Ask to join"] as const;
export type JoinLabel = (typeof JOIN_LABELS)[number];

export const IN_CALL_LABELS = ["Leave call", "Show everyone"];

export const LEFT_MEETING_TEXT = "You left the meeting";

export const ACCOUNT_AVATAR_HINT = "Google Account";
export const SIGNED_IN_URL_HINTS = ["myaccount.google.com", "mail.google.com"];

export const ADMIT_WAIT_LOG = "waiting to be admitted by Saqib…";
