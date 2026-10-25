#!/usr/bin/env node
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { runMeeting } from "../agent/orchestrator.js";
import { runAuth } from "../auth/joiner.js";
import { editConfig } from "../config/load.js";
import { replayEcho } from "../echo/replay.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

interface JoinFlags {
  meeting: string;
  project: string;
  name?: string;
  headed?: boolean;
  model?: string;
}

export function createProgram(): Command {
  const program = new Command();
  program
    .name("meetings-bot")
    .description("Shadow assistant that joins Google Meet calls alongside you.")
    .version(pkg.version);

  program
    .command("join")
    .description("Join a Google Meet as the shadow assistant")
    .requiredOption("--meeting <url>", "Google Meet URL")
    .requiredOption("--project <dir>", "Project directory to ground answers in")
    .option("--name <name>", "Override the bot display name")
    .option("--headed", "Show the Chromium window")
    .option("--model <tag>", "Override the Ollama model")
    .action((opts: JoinFlags) => guard(() => finishMeeting(opts, false)));

  program
    .command("auth")
    .description("One-time headful Google sign-in into the persistent profile")
    .option("--profile <dir>", "Chromium profile directory")
    .action((opts: { profile?: string }) => guard(() => runAuth(opts)));

  program
    .command("rehearse")
    .description("Join a test meeting to tune wake detection and voice")
    .requiredOption("--meeting <url>", "Google Meet URL")
    .requiredOption("--project <dir>", "Project directory to ground answers in")
    .option("--name <name>", "Override the bot display name")
    .option("--headed", "Show the Chromium window")
    .option("--model <tag>", "Override the Ollama model")
    .action((opts: JoinFlags) => guard(() => finishMeeting(opts, true)));

  program
    .command("echo")
    .description("Replay a transcript through wake detection and the brain")
    .argument("<transcript>", "Path to a transcript JSONL file")
    .option("--fast", "Replay timestamps ten times faster")
    .option("--project <dir>", "Project directory to ground answers in")
    .option("--model <tag>", "Override the Ollama model")
    .action((transcript: string, opts: { fast?: boolean; project?: string; model?: string }) =>
      guard(() =>
        replayEcho({
          transcriptPath: transcript,
          fast: Boolean(opts.fast),
          mockBrain: process.env.MOCK_BRAIN === "1",
          projectDir: opts.project,
          model: opts.model,
        }),
      ),
    );

  program
    .command("config")
    .description("Open the config file in $EDITOR and validate it")
    .action(() =>
      guard(async () => {
        const code = await editConfig();
        process.exit(code);
      }),
    );

  return program;
}

async function finishMeeting(opts: JoinFlags, rehearse: boolean): Promise<void> {
  const result = await runMeeting({
    meeting: opts.meeting,
    project: opts.project,
    headed: Boolean(opts.headed),
    rehearse,
    name: opts.name,
    model: opts.model,
  });
  console.log(`Transcript: ${result.transcriptPath}`);
  if (result.notesPath) console.log(`Notes: ${result.notesPath}`);
  process.exitCode = result.exitCode;
}

async function guard(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

if (isCliEntry()) createProgram().parse();

function isCliEntry(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return fs.realpathSync(invoked) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
