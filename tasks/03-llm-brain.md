# Task 03 — LLM brain (Ollama cloud client)

Implement FR-4 (brain) and the tool-calling loop part of FR-5. Read `REQUIREMENTS.md`
FR-4/FR-5, PLAN § 1 (brain uses plain fetch — no SDK) and § 2.3 (latency: streaming is
mandatory), and PREREQUISITE for manual testing: `ollama signin` done (see PLAN § 4).

## Spec

### `brain/ollama.ts` — thin client over `POST {base_url}/chat/completions`

1. `chatStream(messages, opts): AsyncGenerator<Delta>` where `Delta = { content?; toolCalls? }` —
   parse the SSE stream (`data:` lines, `[DONE]` sentinel). Handle `message.content` deltas
   and `tool_calls` deltas (accumulate `tool_calls` fragments by index — chunked tool-call
   deltas are common).
2. `chat(messages, opts)` = buffered convenience around the stream.
3. Retries: connection / 5xx → 2 retries with 1s backoff (REQUIREMENTS risk table: "Retry ×2,
   then chat-channel fallback" — the fallback lives in the orchestrator, Task 08, not here).
   On 401/404: a typed `BrainConfigError` with a message pointing at `ollama signin` / config
   `ollama.model` ("cloud models retire — see PLAN § 4").
4. Startup validation helper `ensureBrainReachable(config)`: `GET {base_url}/models`; empty
   model list or connection refused → throw with remediation text. The `join` command calls
   this before opening the browser (fail fast ≤2s).

### `brain/agent.ts` — the grounded reply generator

1. `generateReply({ question, transcriptExcerpt, brief, extraContext, config }): Promise<{ text, usedFiles: string[] }>`.
2. System prompt (FR-4): persona "Saqib's meeting assistant" + **behavior policy verbatim**
   (REQUIREMENTS § 3, all five rules — especially: never invent project facts; defer
   personal/commitment questions per FR-8 wording) + project brief seed text + the current
   transcript excerpt (sliding window capped to `ollama.max_context_tokens` — token-count
   with a cheap heuristic `≈ chars/4`, cap 24k per FR-4).
3. **Tool loop**: expose exactly one tool to the model —
   `read_file(path: string)` wired to Task 02's `readProjectFile`. Max 3 tool rounds per
   reply (latency budget). Every tool result (including refusals) is appended to the
   conversation as-is. `usedFiles` collects successful reads (orchestrator logs them).
4. Output discipline: instruct the model in the system prompt to answer ≤
   `limits.max_reply_words` words in plain spoken prose — no markdown, no lists, nothing
   that would read badly through TTS (REQUIREMENTS FR-6/FR-7). Enforce a hard client-side
   word-trim as a backstop (truncate at the last sentence boundary under the cap).
5. Self-facts guard: if the model asks to read outside the project, the tool refusal from
   Task 02 handles it; additionally strip and log any attempt.

## Tests (vitest)

- SSE parser fed a fixture stream (recorded from a real call, committed as
  `tests/fixtures/ollama-sse.txt`) including a chunked `tool_calls` delta
- retry/backoff on 503 then success (mock fetch)
- config error classification (401 vs network)
- word-cap backstop truncation keeps whole final sentence
- `ensureBrainReachable` error text mentions `ollama signin`
- live integration test: skipped unless `MEETINGS_BOT_LIVE=1` (calls the real daemon once;
  useful during development, off on CI)

## Acceptance criteria

- [ ] `npm test`, `npx tsc --noEmit` green
- [ ] Manual (daemon running): `tsx` one-liner streams a reply for "what is this project about?"
      grounded in this repo's brief, ≤150 words, no markdown

## Out of scope

Wake detection, speaking, the browser. Tool = only `read_file`.