import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { ZodError, type ZodIssue } from "zod";
import { logger } from "../logging/logger.js";
import {
  AppConfigSchema,
  CONFIG_DEFAULTS,
  CONFIG_TEMPLATE,
  PLACEHOLDER_BOT_NAME,
  PLACEHOLDER_MODEL,
  PLACEHOLDER_WAKE_NAME,
  type AppConfig,
} from "./schema.js";

export interface CliConfigFlags {
  model?: string;
  name?: string;
}

export class ConfigValidationError extends Error {
  readonly issues: ZodIssue[];

  constructor(message: string, issues: ZodIssue[]) {
    super(message);
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

export function meetingsBotHome(): string {
  const override = process.env.MEETINGS_BOT_HOME;
  if (override && override.trim().length > 0) return path.resolve(override);
  return path.join(os.homedir(), ".meetings-bot");
}

export function defaultConfigPath(): string {
  return path.join(meetingsBotHome(), "config.yaml");
}

/** Create profile/, cache/, or logs/ on first use. Callers decide when. */
export function ensureRuntimeDir(kind: "profile" | "cache" | "logs"): string {
  const dir = path.join(meetingsBotHome(), kind);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Arrays in the override replace the default. Nested objects merge field-by-field. */
export function deepMerge(base: unknown, override: unknown): unknown {
  if (Array.isArray(override)) return override.slice();
  if (isRecord(base) && isRecord(override)) {
    const out: Record<string, unknown> = { ...base };
    for (const key of Object.keys(override)) {
      const next = override[key];
      if (next === undefined) continue;
      out[key] = key in base ? deepMerge(base[key], next) : next;
    }
    return out;
  }
  return override;
}

export function mergeDefaults(partial: unknown): unknown {
  const overlay = partial === undefined || partial === null ? {} : partial;
  return deepMerge(structuredClone(CONFIG_DEFAULTS), overlay);
}

export function formatConfigIssues(error: ZodError, raw?: unknown): string {
  const lines = error.issues.map((issue) => {
    const field = issue.path.length > 0 ? issue.path.map(String).join(".") : "<root>";
    return `  - ${field}: ${describeIssue(issue, raw)}`;
  });
  return ["config invalid:", ...lines].join("\n");
}

function valueAt(root: unknown, segments: readonly PropertyKey[]): unknown {
  let current = root;
  for (const segment of segments) {
    if (typeof current !== "object" || current === null) return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = (current as Record<PropertyKey, unknown>)[segment];
  }
  return current;
}

function describeIssue(issue: ZodIssue, raw: unknown): string {
  const expected = "expected" in issue && issue.expected !== undefined ? String(issue.expected) : undefined;
  const values =
    "values" in issue && Array.isArray(issue.values) ? issue.values.map((value) => String(value)) : undefined;
  const actual = "input" in issue ? issue.input : valueAt(raw, issue.path);
  const received = actual === undefined ? "undefined" : JSON.stringify(actual);
  const parts = [issue.message];
  if (values && values.length > 0) parts.push(`expected ${values.join(" | ")}`);
  else if (expected) parts.push(`expected ${expected}`);
  parts.push(`received ${received}`);
  return parts.join("; ");
}

export function parseConfig(raw: unknown): AppConfig {
  const merged = mergeDefaults(raw);
  const result = AppConfigSchema.safeParse(merged);
  if (!result.success) {
    throw new ConfigValidationError(formatConfigIssues(result.error, merged), result.error.issues);
  }
  return result.data;
}

export function placeholderWarnings(config: AppConfig): string[] {
  const warnings: string[] = [];
  if (config.wake_names.some((name) => name === PLACEHOLDER_WAKE_NAME)) {
    warnings.push(`wake_names still contains the placeholder ${JSON.stringify(PLACEHOLDER_WAKE_NAME)}`);
  }
  if (config.bot_name === PLACEHOLDER_BOT_NAME) {
    warnings.push(`bot_name is still the placeholder ${JSON.stringify(PLACEHOLDER_BOT_NAME)}`);
  }
  if (config.ollama.model === PLACEHOLDER_MODEL) {
    warnings.push(`ollama.model is still the placeholder ${JSON.stringify(PLACEHOLDER_MODEL)}`);
  }
  return warnings;
}

function warnPlaceholders(config: AppConfig): void {
  for (const warning of placeholderWarnings(config)) {
    logger.warn(warning);
  }
}

/**
 * Read config from disk. Missing files get the commented template exactly once.
 * Validation failure prints every field problem and exits 1.
 */
export function loadConfig(filePath?: string): AppConfig {
  const file = filePath ? path.resolve(filePath) : defaultConfigPath();
  ensureConfigFile(file);
  let parsed: unknown;
  try {
    parsed = parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`config invalid:\n  - <root>: could not parse YAML; received ${JSON.stringify(message)}`);
    process.exit(1);
  }
  try {
    const config = parseConfig(parsed);
    warnPlaceholders(config);
    return config;
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

/** Write the template if absent. Returns true when a file was created. */
export function ensureConfigFile(file: string): boolean {
  if (fs.existsSync(file)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, CONFIG_TEMPLATE, "utf8");
  return true;
}

export function mergeCliFlags(config: AppConfig, flags: CliConfigFlags): AppConfig {
  const model = flags.model?.trim();
  const name = flags.name?.trim();
  if (!model && !name) return config;
  return {
    ...config,
    ...(name ? { bot_name: name } : {}),
    ...(model ? { ollama: { ...config.ollama, model } } : {}),
  };
}

function resolveEditor(): string | undefined {
  const editor = process.env.EDITOR?.trim() || process.env.VISUAL?.trim();
  return editor && editor.length > 0 ? editor : undefined;
}

function runEditor(editor: string, file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(editor, [file], { stdio: "inherit", shell: true });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

/**
 * Open the config in $EDITOR (then $VISUAL, then vi). With no editor and no TTY,
 * print the path instead of launching vi. Validate after the editor returns.
 */
export async function editConfig(): Promise<number> {
  const file = defaultConfigPath();
  ensureConfigFile(file);
  const editor = resolveEditor();
  const interactive = Boolean(process.stdin.isTTY);
  if (!editor && !interactive) {
    console.log(
      `No $EDITOR or $VISUAL is set and this is not a terminal. Edit the config yourself: ${file}`,
    );
  } else {
    const bin = editor ?? "vi";
    try {
      const code = await runEditor(bin, file);
      if (code !== 0) {
        console.error(`Editor exited ${code}. Config file left at ${file}`);
        return code;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Could not open ${bin}: ${message}. Config file: ${file}`);
      return 1;
    }
  }

  const config = loadConfig(file);
  if (placeholderWarnings(config).length > 0) {
    console.log(`✓ config valid (placeholders remain — edit ${file})`);
  } else {
    console.log("✓ config valid");
  }
  return 0;
}
