import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSystemPrompt, generateReply, trimToWordCap } from "../src/brain/agent.js";
import {
  accumulateDeltas,
  BrainConfigError,
  chat,
  deltasFromSse,
  ensureBrainReachable,
  setRetryDelayMs,
  type Delta,
} from "../src/brain/ollama.js";
import { parseConfig } from "../src/config/load.js";
import type { Brief } from "../src/context/brief.js";
import type { TranscriptLine } from "../src/transcript/types.js";

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "ollama-sse.txt");
const live = process.env.MEETINGS_BOT_LIVE === "1";

afterEach(() => {
  setRetryDelayMs(1000);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function sseResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}

async function collect(chunks: string[]): Promise<Delta[]> {
  async function* iterate(): AsyncGenerator<string> {
    for (const chunk of chunks) yield chunk;
  }
  const deltas: Delta[] = [];
  for await (const delta of deltasFromSse(iterate())) deltas.push(delta);
  return deltas;
}

function config() {
  return parseConfig({
    wake_names: ["assistant"],
    bot_name: "Saqib's Assistant",
    ollama: { model: "gpt-oss:120b-cloud", max_context_tokens: 24000 },
  });
}

function brief(projectDir: string): Brief {
  return {
    projectDir,
    hash: "abc123abc123abcd",
    tree: `${path.basename(projectDir)}/\n└── README.md`,
    seedText: "# Sample\n",
    totalBytes: 9,
    generatedAt: "2026-10-25T00:00:00.000Z",
  };
}

describe("ollama sse", () => {
  it("accumulates content and chunked tool-call arguments from the fixture", async () => {
    const raw = fs.readFileSync(fixturePath, "utf8");
    const halves = [raw.slice(0, 80), raw.slice(80)];
    const message = accumulateDeltas(await collect(halves));
    expect(message.content).toBe("Checking the project.");
    expect(message.tool_calls).toEqual([
      {
        id: "call_readme",
        type: "function",
        function: { name: "read_file", arguments: '{"path":"README.md"}' },
      },
    ]);
  });

  it("retries a 503 twice and then returns the stream", async () => {
    setRetryDelayMs(0);
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls < 3) return new Response("unavailable", { status: 503 });
        return sseResponse('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n');
      }),
    );
    const message = await chat([{ role: "user", content: "hi" }], {
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "gpt-oss:120b-cloud",
    });
    expect(calls).toBe(3);
    expect(message.content).toBe("ok");
  });

  it("classifies 401 as a config error and retries network failures", async () => {
    setRetryDelayMs(0);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unauthorized", { status: 401 })));
    await expect(
      chat([{ role: "user", content: "hi" }], { baseUrl: "http://127.0.0.1:11434/v1", model: "missing" }),
    ).rejects.toThrow(BrainConfigError);
    await expect(
      chat([{ role: "user", content: "hi" }], { baseUrl: "http://127.0.0.1:11434/v1", model: "missing" }),
    ).rejects.toThrow(/ollama signin/);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(
      chat([{ role: "user", content: "hi" }], { baseUrl: "http://127.0.0.1:11434/v1", model: "missing" }),
    ).rejects.toThrow(/after 2 retries/);
  });

  it("mentions ollama signin when the daemon is unreachable or has no models", async () => {
    const cfg = config();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(ensureBrainReachable(cfg)).rejects.toThrow(/ollama signin/);

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));
    await expect(ensureBrainReachable(cfg)).rejects.toThrow(/ollama signin/);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("gone", { status: 404 })));
    await expect(ensureBrainReachable(cfg)).rejects.toThrow(/PLAN § 4/);

    const retired = vi.fn(async () => new Response("qwen was retired", { status: 410 }));
    vi.stubGlobal("fetch", retired);
    await expect(
      chat([{ role: "user", content: "hi" }], { baseUrl: "http://127.0.0.1:11434/v1", model: "qwen3.5:cloud" }),
    ).rejects.toThrow(/Cloud models retire/);
    expect(retired).toHaveBeenCalledOnce();
  });
});

describe("generateReply", () => {
  it("trims to the last whole sentence under the word cap", () => {
    const sentences = Array.from({ length: 12 }, (_, index) => `Sentence ${index} ends here.`);
    const text = sentences.join(" ");
    const trimmed = trimToWordCap(text, 18);
    expect(trimmed.endsWith(".")).toBe(true);
    expect(trimmed.split(" ").length).toBeLessThanOrEqual(18);
    expect(text.startsWith(trimmed)).toBe(true);
    expect(trimmed).not.toMatch(/Sentence 4$/);
  });

  it("drops self lines and old transcript lines that do not fit the window", () => {
    const line = (text: string, isSelf: boolean): TranscriptLine => ({
      ts: "2026-10-25T13:05:22.105Z",
      speaker: isSelf ? "Saqib's Assistant" : "Aadil",
      text,
      is_self: isSelf,
      source: isSelf ? "tts" : "caption",
    });
    const prompt = buildSystemPrompt({
      question: "what is the auth flow?",
      transcriptExcerpt: [
        line("OLD_LINE_SHOULD_DROP", false),
        line("SECRET_SELF", true),
        line("NEWEST_KEEP", false),
      ],
      brief: brief("/tmp/sample"),
      config: parseConfig({
        wake_names: ["assistant"],
        bot_name: "Saqib's Assistant",
        ollama: { model: "gpt-oss:120b-cloud", max_context_tokens: 40 },
      }),
    });
    expect(prompt).toContain("You are Saqib's Assistant.");
    expect(prompt).toContain("Never invents project facts");
    expect(prompt).toContain("That's better answered by Saqib himself — over to you.");
    expect(prompt).toContain("NEWEST_KEEP");
    expect(prompt).not.toContain("OLD_LINE_SHOULD_DROP");
    expect(prompt).not.toContain("SECRET_SELF");
  });

  it("runs one read_file round and trims the spoken answer", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mb-brain-"));
    fs.writeFileSync(path.join(dir, "README.md"), "hello from readme\n");
    const long = Array.from({ length: 40 }, (_, index) => `Sentence ${index} ends here.`).join(" ");
    const toolSse = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"path\\":\\"README.md\\"}"}}]}}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const answerSse = `data: ${JSON.stringify({ choices: [{ delta: { content: long } }] })}\n\ndata: [DONE]\n`;
    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(String(init?.body ?? ""));
        return sseResponse(bodies.length === 1 ? toolSse : answerSse);
      }),
    );
    const result = await generateReply({
      question: "what is this project about?",
      transcriptExcerpt: [],
      brief: brief(dir),
      config: parseConfig({
        wake_names: ["assistant"],
        bot_name: "Saqib's Assistant",
        ollama: { model: "gpt-oss:120b-cloud" },
        limits: { max_reply_words: 18 },
      }),
    });
    expect(result.usedFiles).toEqual(["README.md"]);
    expect(bodies[1]).toContain("hello from readme");
    expect(result.text.endsWith(".")).toBe(true);
    expect(result.text.split(" ").length).toBeLessThanOrEqual(18);
  });
});

describe("live ollama", () => {
  it.skipIf(!live)("reaches the daemon and streams a short reply", async () => {
    const cfg = config();
    await ensureBrainReachable(cfg);
    const listed = (await fetch(`${cfg.ollama.base_url.replace(/\/$/, "")}/models`).then((res) =>
      res.json(),
    )) as { data?: { id?: string }[] };
    const ids = (listed.data ?? []).flatMap((entry) => (entry.id ? [entry.id] : []));
    const model = ids.find((id) => id.includes("flash")) ?? ids[0] ?? cfg.ollama.model;
    const message = await chat(
      [
        { role: "system", content: "Reply with exactly: pong" },
        { role: "user", content: "ping" },
      ],
      { baseUrl: cfg.ollama.base_url, model, temperature: 0, maxTokens: 200 },
    );
    expect((message.content ?? "").length).toBeGreaterThan(0);
  });
});
