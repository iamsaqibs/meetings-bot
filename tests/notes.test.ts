import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.js";
import { exitCodeFor } from "../src/lifecycle/signals.js";
import { startLeaveWatch } from "../src/lifecycle/leave.js";
import { nextNoteNumber } from "../src/notes/numbering.js";
import { summarizeMeeting } from "../src/notes/summarizer.js";
import { writeNotesFile } from "../src/notes/writer.js";
import type { TranscriptLine } from "../src/transcript/types.js";

const config = parseConfig({
  wake_names: ["assistant"],
  bot_name: "Saqib's Assistant",
  ollama: { model: "glm-5.3-flash:cloud" },
});

describe("notes", () => {
  it("numbers 001 and 003 as 004 and ignores bad names", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mb-notes-"));
    expect(nextNoteNumber(dir)).toBe("001");
    fs.writeFileSync(path.join(dir, "001-2026-10-25-alpha.md"), "# a");
    fs.writeFileSync(path.join(dir, "003-2026-10-25-beta.md"), "# b");
    fs.writeFileSync(path.join(dir, "notes.md"), "# no");
    fs.writeFileSync(path.join(dir, "12-short.md"), "# no");
    expect(nextNoteNumber(dir)).toBe("004");
    expect(nextNoteNumber(path.join(dir, "missing"))).toBe("001");
  });

  it("retries once when the summary is not JSON", async () => {
    const replies = ["not json", JSON.stringify({
      summary: "Auth was discussed.",
      decisions: ["Keep the cookie session."],
      actions: [{ text: "Write the notes", owner: "unknown" }],
      followups: ["model follow"],
    })];
    const draft = await summarizeMeeting({
      lines: [caption("I can check after the call.")],
      followups: ["orchestrator follow"],
      config,
      botName: "Saqib's Assistant",
      chat: async () => ({ role: "assistant", content: replies.shift() ?? "" }),
    });
    expect(replies).toEqual([]);
    expect(draft.summary).toMatch(/Auth/);
    expect(draft.actions.find((action) => action.text === "Write the notes")?.owner).toBe("unattributed");
    expect(draft.actions.find((action) => /after the call/i.test(action.text))?.owner).toBe("Saqib's Assistant");
    expect(draft.followups).toEqual(expect.arrayContaining(["model follow", "orchestrator follow"]));
  });

  it("writes every section, a chat marker, and merged follow-ups", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mb-write-"));
    const transcriptPath = path.join(dir, "meeting-notes", ".raw", "004-transcript.jsonl");
    const written = writeNotesFile({
      projectDir: dir,
      nnn: "004",
      when: new Date("2026-10-25T13:00:00.000Z"),
      slugQuestion: "Hey assistant, what's the auth flow?",
      draft: {
        summary: "Auth was discussed.",
        decisions: ["Keep the cookie session."],
        actions: [{ text: "Check the repo", owner: "Saqib's Assistant" }],
        followups: ["orchestrator follow"],
      },
      qa: [
        {
          ts: "2026-10-25T13:00:20.000Z",
          asker: "Aadil",
          question: "Hey assistant, what's the auth flow?",
          answer: "Cookie based.",
          channel: "chat",
        },
      ],
      lines: [caption("hello")],
      transcriptPath,
      partial: false,
    });
    const body = fs.readFileSync(written.notesPath, "utf8");
    expect(body).toMatch(/## Summary/);
    expect(body).toMatch(/## Decisions/);
    expect(body).toMatch(/## Action items/);
    expect(body).toMatch(/## Q&A/);
    expect(body).toMatch(/owner: Saqib's Assistant/);
    expect(body).toMatch(/via chat/);
    expect(body).toMatch(/orchestrator follow/);
    expect(fs.readFileSync(transcriptPath, "utf8")).toMatch(/hello/);
  });

  it("marks notes when the meeting loop throws", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mb-partial-"));
    let partial = false;
    try {
      await Promise.reject(new Error("caption loop failed"));
    } catch {
      partial = true;
    }
    const written = writeNotesFile({
      projectDir: dir,
      nnn: "001",
      when: new Date("2026-10-25T13:00:00.000Z"),
      draft: { summary: "Stopped early.", decisions: [], actions: [], followups: [] },
      qa: [],
      lines: [],
      transcriptPath: path.join(dir, "meeting-notes", ".raw", "001-transcript.jsonl"),
      partial,
    });
    expect(fs.readFileSync(written.notesPath, "utf8")).toContain("(partial — meeting ended unexpectedly)");
  });
});

describe("leave", () => {
  it("ends on caption idle without a banner", async () => {
    const reasons: string[] = [];
    const watch = startLeaveWatch({
      idleTimeoutMs: 1_000,
      pollMs: 15,
      readSignals: () => ({ banner: false, captionsIdleMs: 1_000, browserClosed: false }),
      onLeave: (reason) => reasons.push(reason),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    watch.stop();
    expect(reasons).toEqual(["idle"]);
    expect(exitCodeFor("interrupt")).toBe(130);
    expect(exitCodeFor("clean")).toBe(0);
  });
});

function caption(text: string): TranscriptLine {
  return {
    ts: "2026-10-25T13:00:20.000Z",
    speaker: "Aadil",
    text,
    is_self: false,
    source: "caption",
  };
}
