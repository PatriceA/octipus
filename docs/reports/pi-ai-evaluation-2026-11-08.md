# pi-ai as a provider substrate for Octipus: evaluation

Date: 2026-11-08. Subject: `@earendil-works/pi-ai` **1.5.0** (npm, published 2026-11-02, MIT), from `earendil-works/pi` `packages/ai`. I read the published `dist/` tarball (`.d.ts` and `.js`; it ships no TypeScript sources) and `packages/ai/CHANGELOG.md` from `main`. None of its code was run. Paths below are relative to the package's `dist/` unless they start with `src/`. 

**Short answer:** adapt it only for OpenAI Responses (and Bedrock later, if wanted), behind a flag and pinned to an exact version. Keep Anthropic, Ollama and the OpenAI-compatible providers native. Do not replace the provider layer.

## 1. What Octipus relies on

`ModelProvider` (`src/models/providers/interface.ts`) is small: `complete`, `stream`, optional `embed`/`ocr`/`decide`, plus `checkHealth`. The real contract is in `CompletionOptions`, `CompletionResult` and `StreamChunk` (`src/models/litellm-client.ts:18-174`):

- **Usage** (`providers/usage.ts`). `inputTokens` is the grand total; `cacheReadTokens` and `cacheCreationTokens` are subsets of it. Anthropic's exclusive counters are folded in. Also `reasoningTokens`, `reportedCost`, and an `available`/`estimated` flag.
- **Replay** through `providerRaw`. Gemini `thought_signature`; raw Anthropic content blocks (`providerRaw.anthropicContent`, `custom/anthropic-compat-provider.ts:220,333`), including signed thinking (`signed-reasoning.ts`) and the `server_tool_use`/`tool_search_tool_result` blocks of tool search (`tool-search.ts:39-50`).
- **Prompt caching.**
  - Anthropic: `cache_control` breakpoints on the static system tier, the last tool and the history. The TTL is chosen per tier: one hour on the prefix and five minutes on the history for human-paced turns (`prompt-cache.ts` `cacheTtlsFor`). `historyCache:false` drops the history breakpoint.
  - OpenAI: `prompt_cache_key` names a prefix family, partitioned by request rate (`prompt-cache-key.ts`). `prompt_cache_retention`/`prompt_cache_options`, with a retry that drops them when a model rejects them (`openai-provider.ts:60-105`).
- **Tool search**: `deferredTools` sets `defer_loading` on the first-party Anthropic API (`anthropic-provider.ts` `buildNativeBody`).
- **Streaming**: flat `StreamChunk`s (`content`, `toolCallDelta{id,name,arguments}`, `finishReason`, `usage`, `providerRaw`, `reasoningContent`).
- **Errors**: everything goes through `classifyError()` to a `ClassifiedError` with a `FailoverReason` (`core/errors/classification.ts`). The circuit breaker counts only transport reasons (`providers/index.ts` `TRANSPORT_REASONS`).
- **Keys and endpoints**: a per-request `apiKey` and `endpoint`, personal model rows, and sponsor checks (`instrumented.ts:80-110`).
- **Protection levels**: `assertMayLeave` and pseudonymization run in `instrumented.ts`, before any provider is called.
- **Cost ledger**: `cost-tracker.ts` with Octipus's own `pricing.ts`, plus funding and workspace attribution.
- **Ollama**: native `/api/chat` with a pinned `num_ctx`, `think:false` and JSON mode (`ollama-provider.ts:114-170, 323-460`).
- **Other options**: `toolChoice:'required'`, `responseFormat`, `stopSequences`, `topP`, `signal`.

What Octipus lacks today: the OpenAI provider is Chat Completions only, with no Responses API and so no encrypted reasoning replay. There is no Bedrock provider. Gemini goes through Google's OpenAI-compatible endpoint (`gemini-provider.ts:19`).

## 2. What pi-ai is

- **APIs**: 10 wire APIs (`types.d.ts:20`): openai-completions, openai-responses, azure-openai-responses, openai-codex-responses, anthropic-messages, bedrock-converse-stream, google-generative-ai, google-vertex, mistral-conversations and pi-messages.
- **Providers**: 42 known providers (`types.d.ts:26`). Ollama is not one of them. It is reached only as a generic openai-completions model (`README.md:98, 1277-1303`), with no `num_ctx` anywhere in `dist/`.
- **Messages.** `system | user | assistant | toolResult`. A system message can carry `sections`, `toolsAdded` and `toolsRemoved` deltas (`types.d.ts:381-400`).
  - Assistant content is limited to `text | thinking | toolCall`. Thinking carries `thinkingSignature` and `redacted`; tool calls carry `thoughtSignature`, `namespace` and `argumentsError` (`types.d.ts:247-283`).
  - Nothing in this model holds unknown provider blocks. Anthropic `content_block_start` handles text, thinking, redacted_thinking and tool_use only (`api/anthropic-messages.js:507-540`). `server_tool_use` and `tool_search_tool_result` are not parsed.
- **Reasoning replay.** Responses sends `store:false` with `include:["reasoning.encrypted_content"]` (`api/openai-responses.js:264,295`). Gemini signatures are handled in `api/google-shared.js:80-198`. On a model switch, thinking is dropped (`api/transform-messages`).
- **Caching** is one knob, `cacheRetention: none|short|long`, plus `sessionId` (`types.d.ts:138-144`).
  - Anthropic: the same `cacheControl` goes on the system, the last tool and the last user message. `long` adds `ttl:"1h"` to all three (`api/anthropic-messages.js:33-42, 917-934, 1205-1225, 1313`). Mixed TTLs and a history-off option are not offered.
  - Responses: `prompt_cache_key` is the `sessionId`, clamped; it also sends `prompt_cache_retention` and `prompt_cache_options` (`api/openai-responses.js:261-263`).
  - Bedrock: `cachePoint`, with `ONE_HOUR` for long retention (`api/bedrock-converse-stream.js:743, 936`).
  - Gemini: implicit caching only; `cacheWrite` is always 0 (`api/google-generative-ai.js:171-174`).
  - Proxy compat flags: `cacheControlFormat:"anthropic"`, `supportsLongCacheRetention`, `sendSessionAffinityHeaders`, `maxTokensField`, `thinkingFormat` and others (`providers/compat-schema.d.ts:63-180`).
- **Usage**: `input` (excludes cache), `output`, `cacheRead`, `cacheWrite`, `cacheWrite1h`, `reasoning`, `totalTokens`, and catalog-priced `cost` with `totalFromProvider` (`types.d.ts:285-312`). Responses computes `input = input_tokens − cached − cacheWrite` (`api/openai-responses-shared.js:494-498`).
- **Catalog**: a generated model list (`models.generated.js`, `providers/*.models.js`, about 1.1 MB of data) with `contextWindow`, `maxTokens`, `reasoning`, `thinkingLevelMap`, `promptCache` and `cost` per model (`types.d.ts:640-680`).
- **Streaming**: an event stream of `start`, then `text|thinking|toolcall _start/_delta/_end`, ending in `done` or `error` (`types.d.ts:569-640`). Streamed tool JSON is now parsed in linear time (`utils/streaming-json.d.ts`), so the O(n²) patch DeepSeek Harness carried appears obsolete in 1.5.0.
- **Errors are not thrown.** A failed request ends as an `AssistantMessage` with `stopReason:"error"|"aborted"` and an `errorMessage` string (`types.d.ts:420-445`). The status code is not a field.
  - Helpers: `isContextOverflow()` (regex per provider, `utils/overflow.d.ts`), `isRetryableAssistantError()` and `retryAssistantCall()` (`utils/retry.js:142-178`), and `normalizeProviderError()` (`utils/error-body.d.ts`).
  - Missing auth throws synchronously.
- **Transport hooks**: `signal`, `apiKey`, `fetch`, `env`, `headers`, `timeoutMs`, `maxRetries`, and per-model `baseUrl`. `onPayload` can rewrite the request body and `onResponse` sees the status (`types.d.ts:45-106`).
- **Not first-class in the 1.5.0 types**: `stopSequences`, `topP` (only via `samplingParams`, OpenAI-compatible APIs only), `responseFormat`/`json_schema`, and `toolChoice:"required"`. The simple `ToolChoice` is `"auto"|"none"`; the per-API option types allow `"any"` and OpenAI's own choices (`api/anthropic-messages.d.ts:58`). Any of these can be forced through `onPayload`.
- **Footprint and stability.**
  - Pinned direct dependencies: `openai@7.19.0` (Octipus uses `^7.34.0`, so expect a second copy), `@anthropic-ai/sdk@0.129.0`, `@google/genai@2.21.0`, `@aws-sdk/client-bedrock-runtime@3.1127.0`, `pi-schema` and `pi-telemetry`. Unpacked sizes: pi-ai 4.4 MB; with those four SDKs, about 44 MB before transitive dependencies.
  - Node ≥ 22.19 and ESM, which fits Octipus (Node ≥ 24.22.1, ESM). No install scripts.
  - 62 published versions since 2026-05-07 (0.74.0), and 1.0.0 on 2026-10-01. Since 1.0.0, five of the nine releases carry a "Breaking Changes" section: 1.0.3, 1.1.0, 1.3.0, 1.4.0 and 1.5.0. Unreleased adds more.
  - Unreleased also turns on Anthropic's `message-threads-2026-08-12` beta by default whenever a `sessionId` is passed (`CHANGELOG.md:3-12`).

## 3. Requirement mapping

| Octipus requirement | pi-ai 1.5.0 | Evidence / note |
|---|---|---|
| Usage incl. cache read/write | **Yes**, different convention | `Usage` excludes cache from `input`; map `inputTokens = input + cacheRead + cacheWrite` |
| Reasoning tokens, provider-billed cost | Yes | `Usage.reasoning`, `cost.totalFromProvider` |
| Signed Anthropic thinking replay | Yes | `thinkingSignature`, `redacted` |
| OpenAI encrypted reasoning replay | **Yes** (Octipus has none) | `openai-responses.js:264,295` |
| Gemini thought signatures | Yes | `google-shared.js:80-198` |
| Raw Anthropic blocks, incl. tool-search blocks | **No** | Content model is text, thinking or toolCall only |
| Tool search with `deferredTools` | **No** | Only pi's own placeholder deferred tool (`anthropic-messages.js:125-137`) |
| Anthropic TTL per tier, `historyCache:false` | **No** | One TTL on every breakpoint; history breakpoint always placed |
| OpenAI `prompt_cache_key` = prefix family | Partial | Key is `sessionId`; passing Octipus's family key as `sessionId` works on Responses, but on Anthropic (Unreleased) the same field opts into the threads beta |
| `prompt_cache_retention` / `_options` | Yes | Catalog flags instead of Octipus's retry-on-400 |
| Bedrock `cachePoint` | Yes (Octipus has no Bedrock) | `bedrock-converse-stream.js:743,936` |
| LiteLLM / proxy compat | Yes | `cacheControlFormat`, `maxTokensField`, … |
| Streaming chunk shape | Yes, needs a mapper | Events map 1:1 to `content` / `toolCallDelta` / `finishReason` |
| Abort signal | Yes | `signal`; ends as `stopReason:"aborted"` |
| Error classification | Partial | Error is a string on a message; status only via `onResponse`; overflow by regex |
| Per-request `apiKey` / endpoint | Yes | `apiKey`, `fetch`, `env`, model `baseUrl` |
| Protection levels, cost ledger, personal keys | N/A | Stay in `instrumented.ts`, which wraps any provider |
| Ollama native `/api/chat`, `num_ctx` | **No** | Not in `dist/` |
| `toolChoice:'required'`, `json_schema`, stop, topP | Partial | Per-API options or `onPayload` only |
| Model catalog, capability flags | Yes | `Model.promptCache`, `thinkingLevelMap`, `compat` |
| Test double | Yes | `providers/faux` |

## 4. Integration options

**(a) One `PiAiProvider` behind `ModelProvider`, for selected APIs. About 1–2 weeks.**
- Register it like the custom providers: `supportsModel()` returns false, and model rows opt in by provider column.
- Requests: translate `AgentMessage[]` into a pi `Context`. Store the whole pi `AssistantMessage` in `providerRaw.piAssistant`, so reasoning and signatures replay byte for byte.
- Responses: map pi events to `StreamChunk` and pi `Usage` through the convention above.
- Errors: capture the status with `onResponse`, then build a `ClassifiedError` from status, `errorMessage` and `isContextOverflow()`.
- Use `onPayload` for `json_schema`, stop sequences and `tool_choice`.
- Set `maxRetries: 0`, because Octipus's rate limiter and breaker already retry.
- Use Octipus's own `pricing.ts`. Take `cost.total` only when `totalFromProvider` is true.
- Good targets: OpenAI Responses first, then Bedrock. Gemini gains little over today's path (implicit caching either way).

**(b) Full replacement. About 6–10 weeks, with net losses.** Anthropic tool search, per-tier TTLs, `historyCache`, raw-block replay and native Ollama `num_ctx` would all have to be rebuilt on top of `onPayload`, or given up. Every pi breaking release would then touch every model call. Not justified.

**(c) Don't adopt; port the ideas. About 1–2 weeks for a hand-written Responses provider.** Write `openai-responses-provider.ts` on the `openai` SDK Octipus already has: `store:false`, `include:["reasoning.encrypted_content"]`, reasoning items kept in `providerRaw`, and the existing cache-key and retention logic. This adds no dependencies, but Octipus then maintains Responses quirks itself, such as Azure dropping `encrypted_content` (`openai-responses-shared.js:466-482`).

**Risks**

| Risk | Applies to | Mitigation |
|---|---|---|
| Fast-moving API: breaking changes in 5 of 9 releases since 1.0 | a, b | Exact pin; a contract test over the faux provider and recorded fixtures; upgrade deliberately |
| Beta behaviour turned on by default (Anthropic message threads) | a, b | Don't route Anthropic through pi; `disableContinuation` if ever needed |
| Second error taxonomy (string errors) | a, b | One mapping function to `ClassifiedError`, tested against fixtures per status code |
| Second `openai` copy and about 44 MB of SDKs | a, b | Accept, or wait for the lazy Bedrock entry (Unreleased) to keep the AWS SDK off the hot path |
| Losing tool search, per-tier TTL, raw blocks, `num_ctx` | b | Keep those providers native, i.e. (a) and not (b) |
| Catalog lag for new models | a, b | Pass an explicit `Model` built from the Octipus model row; don't rely on `getModel()` |

## 5. Recommendation

Do **not** replace the provider layer. The evidence is clear: the four features that make Octipus's Anthropic path cheap (tool-search deferral, per-tier TTLs, `historyCache:false`, raw-block replay) and native Ollama `num_ctx` have no place in pi-ai's message model.

For the gap that is real (OpenAI Responses with encrypted reasoning, later Bedrock), run a **time-boxed option (a) spike against option (c)**. Adopt pi-ai for Responses only if it wins clearly; otherwise hand-port.

**First step (about 3 days).**
1. Add `src/models/providers/pi-ai-provider.ts`, serving only `openai-responses`, with `@earendil-works/pi-ai` pinned to `1.5.0` exactly.
2. Opt one or two OpenAI model rows into it by provider column, leaving every other row on the current Chat Completions provider.
3. Set `sessionId` to the existing `promptCacheKey(...)` family key, use `cacheRetention:"long"` only where `cachePolicy:'session'`, and set `maxRetries:0`.
4. Write unit tests for usage folding, error mapping and replay round-trips, using `providers/faux` and recorded payloads. No live calls in CI.

**Measure for two weeks** on the fixed session mix from the cache review (short chats, a long tool loop, a plan-mode toggle, an overnight heartbeat), comparing the pi path with the Chat Completions path on the same model:

- cache hit ratio, `cacheReadTokens / inputTokens`, and `cacheCreationTokens` per session, from `cost_log`;
- time to first token, p50 and p95, and total latency;
- error rate by `FailoverReason`, plus any `UNKNOWN` classifications, which would show gaps in the error mapping;
- reasoning tokens and cost per completed turn, and the reasoning-replay 400 rate across multi-turn tool loops.

**Decision rule.** Keep pi-ai for Responses only if all four hold:
- the cache hit ratio and cost per turn are at least as good as the hand path;
- the TTFT p95 is no worse than +10%;
- `UNKNOWN` errors stay under 1%;
- the mapping code stays under about 400 lines.

If any of these fails, or a pi upgrade breaks the contract tests during the spike, write option (c) and keep pi as a reference to read, not a dependency.
