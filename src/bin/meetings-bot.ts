#!/usr/bin/env node
import { Command } from "commander";

const program = new Command();

program
  .name("meetings-bot")
  .description("Shadow assistant that joins Google Meet calls alongside you.")
  .version("0.1.0");

program
  .command("join")
  .description("Join a Google Meet as the shadow assistant")
  .requiredOption("--meeting <url>", "Google Meet URL")
  .requiredOption("--project <dir>", "Project directory to ground answers in")
  .option("--name <name>", "Override the bot display name")
  .option("--headed", "Show the Chromium window")
  .option("--model <tag>", "Override the Ollama model")
  .action(() => {
    throw new Error("not implemented");
  });

program
  .command("auth")
  .description("One-time headful Google sign-in into the persistent profile")
  .option("--profile <dir>", "Chromium profile directory")
  .action(() => {
    throw new Error("not implemented");
  });

program
  .command("rehearse")
  .description("Join a test meeting to tune wake detection and voice")
  .requiredOption("--meeting <url>", "Google Meet URL")
  .requiredOption("--project <dir>", "Project directory to ground answers in")
  .option("--name <name>", "Override the bot display name")
  .option("--headed", "Show the Chromium window")
  .option("--model <tag>", "Override the Ollama model")
  .action(() => {
    throw new Error("not implemented");
  });

program
  .command("echo")
  .description("Replay a transcript through wake detection and the brain")
  .argument("<transcript>", "Path to a transcript JSONL file")
  .option("--fast", "Skip the LLM gate and brain; lexical wake only")
  .option("--project <dir>", "Project directory to ground answers in")
  .option("--model <tag>", "Override the Ollama model")
  .action(() => {
    throw new Error("not implemented");
  });

program
  .command("config")
  .description("Open the config file in $EDITOR and validate it")
  .action(() => {
    throw new Error("not implemented");
  });

program.parse();
