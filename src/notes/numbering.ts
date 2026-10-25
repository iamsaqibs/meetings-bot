import fs from "node:fs";

/** Next `NNN` from `NNN-*.md` already in the notes directory. Missing or odd names are ignored. */
export function nextNoteNumber(notesDir: string): string {
  let max = 0;
  let names: string[] = [];
  try {
    names = fs.readdirSync(notesDir);
  } catch {
    names = [];
  }
  for (const name of names) {
    const match = /^(\d{3})-.*\.md$/.exec(name);
    const digits = match?.[1];
    if (!digits) continue;
    max = Math.max(max, Number(digits));
  }
  return String(max + 1).padStart(3, "0");
}
