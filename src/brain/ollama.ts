export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  arguments?: string;
}

export interface Delta {
  content?: string;
  toolCalls?: ToolCallDelta[];
}

export interface ChatOptions {
  baseUrl: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  tools?: unknown[];
  signal?: AbortSignal;
}

export class BrainConfigError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "BrainConfigError";
    this.status = status;
  }
}

interface ToolAccumulator {
  id: string;
  name: string;
  arguments: string;
}

let retryDelayMs = 1000;

export function setRetryDelayMs(ms: number): void {
  retryDelayMs = ms;
}

export function endpoint(baseUrl: string, suffix: string): string {
  return `${baseUrl.replace(/\/$/, "")}/${suffix}`;
}

export async function* deltasFromSse(chunks: AsyncIterable<string>): AsyncGenerator<Delta> {
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const delta = deltaFromSseLine(line);
      if (delta === "done") return;
      if (delta) yield delta;
    }
  }
  if (buffer.trim().length > 0) {
    const delta = deltaFromSseLine(buffer);
    if (delta && delta !== "done") yield delta;
  }
}

export function deltaFromSseLine(line: string): Delta | "done" | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const data = trimmed.slice(5).trim();
  if (data === "[DONE]") return "done";
  if (!data) return null;
  const parsed = JSON.parse(data) as unknown;
  return deltaFromPayload(parsed);
}

export function accumulateDeltas(deltas: Delta[]): ChatMessage {
  let content = "";
  const tools = new Map<number, ToolAccumulator>();
  for (const delta of deltas) {
    if (delta.content) content += delta.content;
    for (const call of delta.toolCalls ?? []) {
      const prev = tools.get(call.index) ?? { id: "", name: "", arguments: "" };
      tools.set(call.index, {
        id: call.id ?? prev.id,
        name: call.name ?? prev.name,
        arguments: prev.arguments + (call.arguments ?? ""),
      });
    }
  }
  const toolCalls = [...tools.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call]) => ({
      id: call.id,
      type: "function" as const,
      function: { name: call.name, arguments: call.arguments },
    }));
  const message: ChatMessage = { role: "assistant", content };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return message;
}

export async function* chatStream(
  messages: ChatMessage[],
  opts: ChatOptions,
): AsyncGenerator<Delta> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(endpoint(opts.baseUrl, "chat/completions"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: opts.model,
          messages,
          temperature: opts.temperature,
          stream: true,
          tools: opts.tools,
          max_tokens: opts.maxTokens,
        }),
        signal: opts.signal,
      });
      if (response.status === 401 || response.status === 404 || response.status === 410) {
        throw configError(response.status, opts.model, await safeText(response));
      }
      if (response.status >= 500) {
        lastError = new Error(`Ollama returned ${response.status}`);
        if (attempt < 2) {
          await delay(retryDelayMs);
          continue;
        }
        break;
      }
      if (!response.ok) {
        throw new Error(`Ollama request failed (${response.status}): ${await safeText(response)}`);
      }
      if (!response.body) throw new Error("Ollama response had no body");
      let yielded = false;
      try {
        for await (const delta of deltasFromSse(streamText(response.body))) {
          yielded = true;
          yield delta;
        }
        return;
      } catch (err) {
        if (yielded || err instanceof BrainConfigError || !isRetriableNetwork(err)) throw err;
        lastError = err;
        if (attempt < 2) await delay(retryDelayMs);
        continue;
      }
    } catch (err) {
      if (err instanceof BrainConfigError) throw err;
      if (!isRetriableNetwork(err)) throw err;
      lastError = err;
      if (attempt < 2) await delay(retryDelayMs);
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Ollama request failed after 2 retries: ${detail}`);
}

export async function chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatMessage> {
  const deltas: Delta[] = [];
  for await (const delta of chatStream(messages, opts)) deltas.push(delta);
  return accumulateDeltas(deltas);
}

export async function ensureBrainReachable(config: {
  ollama: { base_url: string; model: string };
}): Promise<void> {
  const url = endpoint(config.ollama.base_url, "models");
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(2000) });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new BrainConfigError(
      `Cannot reach Ollama at ${url} (${detail}). Start the daemon and run \`ollama signin\`.`,
    );
  }
  if (response.status === 401 || response.status === 404 || response.status === 410) {
    throw configError(response.status, config.ollama.model, await safeText(response));
  }
  if (!response.ok) {
    throw new BrainConfigError(
      `Ollama at ${url} returned ${response.status}. Run \`ollama signin\` and confirm ollama.model (cloud models retire — see PLAN § 4).`,
      response.status,
    );
  }
  let body: { data?: unknown };
  try {
    body = (await response.json()) as { data?: unknown };
  } catch {
    throw new BrainConfigError(
      `Ollama at ${url} did not return a model list. Run \`ollama signin\` and confirm ollama.model (cloud models retire — see PLAN § 4).`,
    );
  }
  if (!Array.isArray(body.data) || body.data.length === 0) {
    throw new BrainConfigError(
      `Ollama at ${url} returned no models. Run \`ollama signin\` and confirm ollama.model (cloud models retire — see PLAN § 4).`,
    );
  }
}

function configError(status: number, model: string, body: string): BrainConfigError {
  if (status === 401) {
    return new BrainConfigError(
      `Ollama rejected the request (401). Run \`ollama signin\`. ${body}`.trim(),
      status,
    );
  }
  return new BrainConfigError(
    `Ollama returned ${status} for model ${JSON.stringify(model)}. Cloud models retire — see PLAN § 4 and update ollama.model. ${body}`.trim(),
    status,
  );
}

function deltaFromPayload(payload: unknown): Delta | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as {
    choices?: { delta?: unknown; message?: unknown }[];
    message?: unknown;
  };
  const choice = record.choices?.[0];
  const message = choice?.delta ?? choice?.message ?? record.message;
  if (!message || typeof message !== "object") return null;
  const delta = message as {
    content?: unknown;
    tool_calls?: {
      index?: number;
      id?: string;
      function?: { name?: string; arguments?: string };
    }[];
  };
  const out: Delta = {};
  if (typeof delta.content === "string" && delta.content.length > 0) out.content = delta.content;
  if (Array.isArray(delta.tool_calls)) {
    out.toolCalls = delta.tool_calls.map((call, position) => ({
      index: call.index ?? position,
      ...(call.id ? { id: call.id } : {}),
      ...(call.function?.name ? { name: call.function.name } : {}),
      ...(call.function?.arguments !== undefined ? { arguments: call.function.arguments } : {}),
    }));
  }
  if (!out.content && !out.toolCalls) return null;
  return out;
}

async function* streamText(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        const tail = decoder.decode();
        if (tail) yield tail;
        return;
      }
      yield decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

function isRetriableNetwork(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError") return false;
  return err.name === "TypeError" || /fetch failed|ECONNREFUSED|ENOTFOUND|network|socket/i.test(err.message);
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return "";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
