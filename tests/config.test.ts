import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureRuntimeDir,
  loadConfig,
  meetingsBotHome,
  mergeCliFlags,
  parseConfig,
} from "../src/config/load.js";
import { PLACEHOLDER_BOT_NAME } from "../src/config/schema.js";

const envSnapshot = { ...process.env };

afterEach(() => {
  process.env = { ...envSnapshot };
  vi.restoreAllMocks();
});

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meetings-bot-"));
  process.env.MEETINGS_BOT_HOME = dir;
  return dir;
}

const validPartial = {
  wake_names: ["assistant", "saqib's assistant"],
  bot_name: "Saqib's Assistant",
  ollama: { model: "gpt-oss:120b-cloud" },
};

describe("config", () => {
  it("names every invalid field path, including expected and received", () => {
    expect(() => parseConfig({ tts: { provider: "nope" } })).toThrowError(/wake_names/);
    try {
      parseConfig({
        wake_names: ["assistant"],
        bot_name: "Saqib's Assistant",
        ollama: { model: "gpt-oss:120b-cloud" },
        tts: { provider: "nope" },
      });
      throw new Error("expected parseConfig to throw");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toMatch(/tts\.provider/);
      expect(message).toMatch(/expected/);
      expect(message).toMatch(/kokoro/);
      expect(message).toMatch(/received "nope"/);
    }
  });

  it("exits 1 from loadConfig when the file is invalid", () => {
    const home = tempHome();
    const file = path.join(home, "config.yaml");
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(file, "tts:\n  provider: nope\n", "utf8");
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? "undefined"}`);
    }) as typeof process.exit);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => loadConfig(file)).toThrow(/exit:1/);
    expect(exit).toHaveBeenCalledWith(1);
    expect(error.mock.calls.map((call) => String(call[0])).join("\n")).toMatch(/wake_names/);
  });

  it("merges defaults over a partial file and replaces arrays", () => {
    const config = parseConfig({
      ...validPartial,
      limits: { max_replies: 2 },
      defer_phrases: ["budget"],
    });
    expect(config.limits.max_replies).toBe(2);
    expect(config.limits.max_reply_words).toBe(150);
    expect(config.limits.max_talk_seconds).toBe(600);
    expect(config.ollama.base_url).toBe("http://localhost:11434/v1");
    expect(config.ollama.temperature).toBe(0.3);
    expect(config.ollama.max_context_tokens).toBe(24000);
    expect(config.tts).toEqual({ provider: "kokoro", voice: "af_heart", gain: 1 });
    expect(config.wake).toEqual({ allow_clarify: true, finalize_ms: 1500 });
    expect(config.meet.idle_timeout_minutes).toBe(8);
    expect(config.defer_phrases).toEqual(["budget"]);
  });

  it("writes the template once and refuses to clobber edits", () => {
    const home = tempHome();
    const file = path.join(home, "config.yaml");
    const first = loadConfig();
    expect(first.bot_name).toBe(PLACEHOLDER_BOT_NAME);
    const created = fs.readFileSync(file, "utf8");
    expect(created).toMatch(/CHANGE ME — your assistant's name/);
    const edited = created.replace(PLACEHOLDER_BOT_NAME, "Saqib's Assistant");
    fs.writeFileSync(file, edited, "utf8");
    loadConfig();
    expect(fs.readFileSync(file, "utf8")).toBe(edited);
  });

  it("overrides model and bot name from CLI flags", () => {
    const config = parseConfig(validPartial);
    const patched = mergeCliFlags(config, { model: "glm-5.3-flash:cloud", name: "Room Assistant" });
    expect(patched.ollama.model).toBe("glm-5.3-flash:cloud");
    expect(patched.bot_name).toBe("Room Assistant");
    expect(patched.ollama.base_url).toBe(config.ollama.base_url);
    expect(mergeCliFlags(config, {})).toBe(config);
  });

  it("honors MEETINGS_BOT_HOME and creates runtime dirs lazily", () => {
    const home = tempHome();
    expect(meetingsBotHome()).toBe(path.resolve(home));
    expect(fs.existsSync(path.join(home, "profile"))).toBe(false);
    loadConfig();
    expect(fs.existsSync(path.join(home, "config.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(home, "profile"))).toBe(false);
    expect(ensureRuntimeDir("profile")).toBe(path.join(home, "profile"));
    expect(fs.statSync(path.join(home, "profile")).isDirectory()).toBe(true);
  });
});
