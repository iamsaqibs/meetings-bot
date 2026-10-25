import fs from "node:fs";
import path from "node:path";
import { meetingsBotHome } from "../config/load.js";

const COOKIE_CANDIDATES = ["Cookies", path.join("Default", "Cookies")];

export function profileDir(explicit?: string): string {
  if (explicit && explicit.trim().length > 0) return path.resolve(explicit);
  return path.join(meetingsBotHome(), "profile");
}

/** Chrome stores the session in a Cookies database. Either layout counts. */
export function profileExists(dir = profileDir()): boolean {
  return COOKIE_CANDIDATES.some((relative) => {
    try {
      return fs.statSync(path.join(dir, relative)).size > 0;
    } catch {
      return false;
    }
  });
}

export function assertProfile(explicit?: string): string {
  const dir = profileDir(explicit);
  if (!profileExists(dir)) {
    throw new Error(
      `No saved Google session at ${dir}. Run \`meetings-bot auth\` and sign in to the dedicated account before joining.`,
    );
  }
  return dir;
}
