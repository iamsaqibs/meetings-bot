import fs from "node:fs";
import path from "node:path";
import type { TranscriptLine } from "../transcript/types.js";
import type { NoteQa, NotesDraft } from "./types.js";

export function noteSlug(question: string | undefined, date: string): string {
  const words = (question ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5);
  return words.length > 0 ? words.join("-") : date;
}

export function renderNotes(input: {
  nnn: string;
  date: string;
  slug: string;
  draft: NotesDraft;
  qa: NoteQa[];
  partial: boolean;
}): string {
  const marker = input.partial ? " (partial — meeting ended unexpectedly)" : "";
  const decisions = input.draft.decisions.length > 0 ? input.draft.decisions.map((item) => `- ${item}`).join("\n") : "- None recorded.";
  const actions =
    input.draft.actions.length > 0
      ? input.draft.actions.map((action) => `- ${action.text} (owner: ${action.owner})`).join("\n")
      : "- None recorded.";
  const followups =
    input.draft.followups.length > 0 ? input.draft.followups.map((item) => `- ${item}`).join("\n") : "- None recorded.";
  const qa =
    input.qa.length > 0
      ? input.qa
          .map((item) => {
            const asker = item.asker ?? "unknown";
            const via = item.channel === "chat" ? "via chat" : "via audio";
            return `- ${item.ts} ${asker}: ${item.question} → ${item.answer} (${via})`;
          })
          .join("\n")
      : "- None recorded.";
  return [
    `# ${input.nnn} — ${input.date} — ${input.slug}${marker}`,
    "",
    "## Summary",
    "",
    input.draft.summary || "No summary.",
    "",
    "## Decisions",
    "",
    decisions,
    "",
    "## Action items",
    "",
    actions,
    "",
    "## Q&A",
    "",
    qa,
    "",
    "## Follow-ups",
    "",
    followups,
    "",
  ].join("\n");
}

export function ensureRawTranscript(transcriptPath: string, lines: TranscriptLine[]): void {
  const expected = lines.map((line) => JSON.stringify(line)).join("\n") + (lines.length > 0 ? "\n" : "");
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  if (fs.existsSync(transcriptPath)) {
    const current = fs.readFileSync(transcriptPath, "utf8");
    const currentCount = current.split(/\r?\n/).filter((line) => line.length > 0).length;
    if (currentCount >= lines.length && current.length > 0) return;
  }
  fs.writeFileSync(transcriptPath, expected);
}

export function writeNotesFile(input: {
  projectDir: string;
  nnn: string;
  when: Date;
  slugQuestion?: string;
  draft: NotesDraft;
  qa: NoteQa[];
  lines: TranscriptLine[];
  transcriptPath: string;
  partial: boolean;
}): { notesPath: string; transcriptPath: string } {
  const date = input.when.toISOString().slice(0, 10);
  const slug = noteSlug(input.slugQuestion, date);
  const notesDir = path.join(input.projectDir, "meeting-notes");
  fs.mkdirSync(notesDir, { recursive: true });
  ensureRawTranscript(input.transcriptPath, input.lines);
  const notesPath = path.join(notesDir, `${input.nnn}-${date}-${slug}.md`);
  fs.writeFileSync(
    notesPath,
    renderNotes({ nnn: input.nnn, date, slug, draft: input.draft, qa: input.qa, partial: input.partial }),
  );
  return { notesPath, transcriptPath: input.transcriptPath };
}
