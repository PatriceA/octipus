# Pi (earendil-works/pi): code-level architecture study

Checkout: shallow clone at `e49b149` (2026-11-08); every package is at v1.5.0 plus Unreleased changes. Everything here was read in the code, not only in the docs. Path prefixes used below: `ai/` = `packages/ai/src/`, `agent/` = `packages/agent/src/`, `ca/` = `packages/coding-agent/src/`, `cat/` = `packages/ai/catalog/`, `docs/` = `packages/coding-agent/docs/`, `ex/` = `packages/coding-agent/examples/extensions/`.

**TL;DR.** Pi has grown well past "minimal". Its standout engineering is around the prompt cache. The system prompt and the tool loadout live *inside the transcript*: changes are appended as diffs instead of rewriting the head. Thinking-level changes are sent as per-reply markers. The tool list is ordered as a set. Caches are warmed only when the expected savings justify the cost, and cache misses are accounted in dollars. Sessions are an append-only JSONL tree, and the model context is re-projected from that tree on every request.

---

## 1. Architecture & turn flow

**Packages.** The core stack is `pi-ai` (unified LLM API over 10 wire APIs and 43 providers, `ai/types.ts:64-133`), then `pi-agent-core` (a generic loop and the `Agent` class, `agent/agent-loop.ts`, `agent/agent.ts`), then `pi-coding-agent` (`AgentSession`, tools, sessions, extensions, modes; `ca/core/agent-session.ts` is 4,565 lines), with `pi-tui` underneath for rendering. Support packages: `pi-schema` (JSON Schema validation without eval), `pi-mcp`, `pi-codemode` (QuickJS sandbox), `pi-telemetry`. Experimental packages: `pi-durable` (a separate crash-durable harness, `packages/durable/README.md:1-5`) and `chord`, `env`, `apps/p2`/`p3` (prototypes). The coding agent does not use `pi-durable`.

**One user turn, step by step:**
1. `AgentSession.prompt()` (`ca/core/agent-session.ts:2162`) checks extension commands first (`:2268`), then `input` handlers (`:2111`), then expands `/skill:` commands and templates (`:2299`).
2. `_startRun()` (`:1943-1988`) calls `_prepareRun()` (`:1996-2047`), which:
   - runs a pre-prompt compaction check (`:2001`);
   - runs `before_agent_start` with structured `systemPromptOptions` (`:2005`);
   - resizes images (`:2020`);
   - prepends a **system-prompt section patch** when the prompt changed (`:2043-2045`).
3. `agent.prompt()` calls `runAgentLoop` (`agent/agent-loop.ts:111-135`). `declareToolChanges()` inserts a system message that carries the tool delta (`:342-372`).
4. Before every request, `prepareRequest` replaces the context with the **canonical projection of the persisted session tree** (`ca/core/agent-session.ts:848-905`, which also routes virtual models).
5. `streamAssistantResponse` (`agent/agent-loop.ts:390-479`) runs, in order:
   - `transformContext`: the extension `context` hook, then `context_with_system`, then hidden-declaration and forced-prompt projections (`ca/core/extensions/runner.ts:1312-1373`, `ca/core/agent-session.ts:1857-1892`);
   - `convertToLlm` (`ca/core/messages.ts:148-196`);
   - `normalizeContext`;
   - `streamFn`, which starts the cache warmer and then calls `modelRuntime.streamSimple` (`ca/core/sdk.ts:412-423`).
6. Tool calls:
   - If the reply stopped on `"length"`, every call fails without running (`agent/agent-loop.ts:272-279, 488-513`).
   - Otherwise tools run in **parallel by default**. Preflight is sequential (validate, `beforeToolCall`, extension `tool_call`). Execution is concurrent. Results are emitted in source order (`:596-670, 718-787`).
   - `afterToolCall` runs the extension `tool_result` hook and resizes images (`ca/core/agent-session.ts:745-787`).
7. `finishTurn` runs the `turn_end` boundary, where extensions can append entries or ask to continue (`:907-957`). `prepareNextTurn` runs threshold compaction and the prompt diff (`:959-993`). Then steering and follow-up queues are drained (`agent/agent-loop.ts:304-317`).
8. Every `message_end` is persisted (`ca/core/agent-session.ts:1211-1233`). After the run come retries (`:3871-3964`) and overflow recovery, then `agent_before_settle`, then `agent_settled`.

**Event model.**
- `AgentEvent`: `agent_start`/`agent_end`, `turn_start`/`turn_end`, `message_start`/`message_update`/`message_end`, `tool_execution_start`/`tool_execution_update`/`tool_execution_end` (`agent/types.ts:528-551`).
- Stream events: `start`, then text/thinking/toolcall `*_start`/`*_delta`/`*_end`, then `done` or `error` (`ai/types.ts:831-847`).
- Extensions get 41 events (§9).

## 2. Modes

All modes share one `AgentSession`, prompt builder, tool set, cache warmer and `sessionId`. Only I/O and UI capability differ; no mode has its own prompt.

| Mode | Entry | Behaviour |
|---|---|---|
| Interactive (TUI) | `ca/main.ts:1009-1042` | `ctx.mode="tui"`. Trust prompt; `/tree`, `/fork`, `/compact`, `/session`. Catalog refresh after the TUI starts. |
| Print `-p` | `ca/main.ts:1043-1056`, `ca/modes/print-mode.ts` | Prints the final text. `hasUI=false`. Piped stdin forces print (`ca/main.ts:953-960`). |
| JSON `--mode json` | same runner | Header, then a JSONL event stream (`ca/modes/print-mode.ts:115-133`). |
| RPC `--mode rpc` | `ca/modes/rpc/rpc-mode.ts` | Long-lived JSONL protocol with about 33 commands (`ca/modes/rpc/rpc-types.ts`) plus `extension_ui_request`/`extension_ui_response`. `hasUI=true`, but `custom()` is unsupported. Catalog refreshes in the background (`ca/main.ts:997-1004`). |
| SDK | `createAgentSession` (`ca/core/sdk.ts`) | In-process. `SessionManager.inMemory()`; `AgentSessionRuntime` handles new, switch and fork. |

Sessions are persisted in every mode unless `--no-session` is given, which uses an in-memory manager (`ca/main.ts:411-412`). `--session-id` pins the id, and that pinned id becomes the prompt-cache key across processes.

## 3. Provider abstraction (pi-ai)

- **Model collection.** `createModels()` plus provider factories. Each API module is loaded lazily through `*.lazy.ts`, for example `ai/api/anthropic-messages.lazy.ts` and `ai/api/lazy.ts:60-80`.
- **Message types.** Four roles: `SystemMessage | UserMessage | AssistantMessage | ToolResultMessage` (`ai/types.ts:569-667`).
  - `SystemMessage` carries `sections`, `toolsAdded` and `toolsRemoved`. Replaying these deltas gives the current prompt and tools.
  - A branded `TranscriptContext` (`ai/types.ts:802-813`) can only be produced by `normalizeContext` (`ai/utils/transcript.ts:30-34`).
  - `AssistantMessage` records `api`, `provider`, `model`, `responseModel`, `thinkingLevel`, `providerThinkingLevel`, `usage` and `diagnostics`.
- **Cross-provider handoff** (`ai/api/transform-messages.ts:91-256`), applied when the target model differs from the one that produced a message:
  - thinking blocks are **dropped**, because signatures and encrypted reasoning only work with the model that produced them (`:127-138`);
  - text signatures are stripped, and Gemini `thoughtSignature`s are removed (`:140-156`);
  - tool-call ids are normalized per API (`:157-163`; Anthropic `[a-zA-Z0-9_-]{≤64}` at `ai/api/anthropic-messages.ts:1596-1598`; Responses `call|fc_` pairs at `ai/api/openai-responses-shared.ts:201-224`);
  - assistant turns that ended in error or abort are skipped (`:216-224`);
  - orphaned tool calls get a synthetic error result, "No result provided" (`:179-207`);
  - images sent to text-only models become placeholders (`:62-84`).
  - The README's handoff section matches the code.
- **Tools.** Tool parameters are any JSON Schema; TypeBox or pi-schema builders are both accepted (`ai/types.ts:775-784`).
  - `constrainedSampling` controls strict sampling (`json_schema` with `prefer`/`require`, or OpenAI Lark/regex grammars). When Anthropic rejects strict tools, pi resends without them and records a diagnostic (`ai/api/anthropic-messages.ts:916-936`).
  - Streamed arguments are parsed incrementally (`ai/utils/streaming-json.ts:1-33`). Invalid final JSON is recorded in `ToolCall.argumentsError`.
- **Thinking.** Pi levels are `off/minimal/low/medium/high/xhigh/max` (`ai/providers/model-schema.ts:16-17`). Each model maps them through `thinkingLevelMap`; `null` means unsupported (`ai/models.ts:1276-1296`).
  - Default token budgets are 1024/2048/8192/16384 (`ai/api/simple-options.ts:86-89`).
  - Anthropic uses adaptive effort or budget thinking (`ai/api/anthropic-messages.ts:1201-1249, 1536-1570`).
- **Usage and cost.** `Usage` holds `{input, output, cacheRead, cacheWrite, cacheWrite1h?, reasoning?, cost{…, totalFromProvider}}` (`ai/types.ts:467-495`).
  - `calculateCost` applies request-wide price tiers and bills 1-hour cache writes at **2× input** (`ai/models.ts:1251-1272`).
  - OpenRouter's billed cost overrides the total. OpenAI service tiers multiply cost (`ai/api/openai-responses.ts:427-455`).
- **Catalog.** Built from models.dev plus per-provider corrections and family rules (`cat/README.md`, `cat/families/*.ts`). At runtime pi.dev overlays updates every 4 hours (`ca/core/remote-catalog-provider.ts:14-16`). Capability flags such as `supportsMidConvoSystemMessages`, `promptCache` and `supportsExplicitPromptCacheMode` come from the catalog.

## 4. Prompt / session cache handling (most important)

**Common controls** (`ai/types.ts:248-265`):
- `cacheRetention` is `none`, `short` (the default) or `long`. `PI_CACHE_RETENTION=long` switches to long (`ai/api/anthropic-messages.ts:78-86`).
- `sessionId` is the session file's id (`ca/core/sdk.ts:427`).
- `disableContinuation` marks replays such as warm requests, which must not touch the conversation's server-side state.
- Retention `none` also suppresses the session id for cache purposes (`ai/api/anthropic-messages.ts:840-841`).
- Note: the coding agent has **no settings key** for retention; only the environment variable sets it.

**How each provider requests and keeps the cache:**

- **Anthropic** (`anthropic-messages`; also Copilot, Kimi, Fireworks and OpenRouter-Anthropic models)
  - `cache_control: {type:"ephemeral"}` goes on three places:
    - (a) the system text block. With OAuth, pi also prepends a "You are Claude Code…" block, which gets its own breakpoint (`:1485-1510`);
    - (b) the **last tool definition**, unless `supportsCacheControlOnTools` is false (`:1522, 1930`);
    - (c) the **last block of the final user or system message**. A string body is turned into a block so it can carry the marker (`:1792-1818`).
  - That is at most 4 breakpoints, which is Anthropic's limit.
  - TTL: `short` sends no `ttl` (5 minutes); `long` sends `ttl:"1h"` when supported (`:88-102`).
  - No cache key is sent. `x-session-affinity`/`x-session-id` headers go out only when `sendSessionAffinityHeaders` is set, which defaults to OpenRouter only (`:229-249, 1312-1317`).
  - **Message threads** (beta `message-threads-2026-08-12`): requests continue from the previous reply and send only the new messages. A hash of settings, system, tools and the normalized message prefix (cache markers removed) decides whether to continue or open a new thread (`:251-468`).
    - On by default only for direct `api.anthropic.com`; state is a per-process Map capped at 10k sessions (`:272-300`).
    - Warm requests send `disableContinuation` (`ca/core/cache-warmer.ts:336-337`).
- **OpenAI Responses** (OpenAI, Azure, xAI, Meta, Copilot)
  - `prompt_cache_key` = `sessionId` clamped to 64 characters (`ai/api/openai-prompt-cache.ts:1-8`), unless retention is `none` or `promptCacheKeyMode:"disabled"` (`ai/api/openai-responses.ts:361-370`).
  - `prompt_cache_retention:"24h"` when retention is long (`:125-132`).
  - GPT-5.6+ models (any with `cost.cacheWrite>0`) instead get `prompt_cache_options`: `{mode:"explicit"}` when retention is none, `{ttl:"30m"}` when long (`:134-142`; `cat/providers/openai.ts:134-137`).
  - Headers: `session-id` plus `x-client-request-id`, or `x-session-id` for OpenRouter (`:315-324`).
  - Replay is stateless: `store:false` plus `reasoning.encrypted_content`.
- **Codex**
  - `prompt_cache_key` = `sessionId` (`ai/api/openai-codex-responses.ts:284-286, 582`).
  - A per-session WebSocket pool (5-minute idle expiry) sends `previous_response_id` and only the input delta, provided the request body is unchanged apart from `input` and the previous input plus output is a prefix of the new input (`:1446-1498, 931-1000`).
- **Chat Completions** (DeepSeek, Groq, Cerebras, Together, z.ai, Moonshot, OpenRouter, LiteLLM, Ollama/vLLM/llama.cpp)
  - `prompt_cache_key` is sent only for `api.openai.com`, or when retention is long, or with `promptCacheKeyMode:"enabled"` (`ai/api/openai-completions.ts:808-823`).
  - `cacheControlFormat:"anthropic"` adds Anthropic-style markers on the first system/developer message, the last tool, and the last user, assistant or tool text part (`:1068-1182`). It is automatic for OpenRouter `anthropic/*` (`:1642`) and is the switch to set for LiteLLM in front of Anthropic.
  - Session-affinity headers go out only when enabled (default: OpenRouter) (`:761-771`).
- **Gemini / Vertex**: implicit caching only. There is **no explicit `cachedContents`** call and no session hint. `cachedContentTokenCount` becomes `cacheRead`, and `cacheWrite` is always 0 (`ai/api/google-generative-ai.ts:233-240`).
- **Bedrock**
  - A `cachePoint` is placed after the system text and appended to the final user message, with `ttl: ONE_HOUR` for long retention (`ai/api/bedrock-converse-stream.ts:953-971, 1170-1181`).
  - Only Claude models detected by id or name get cache points, or any model when `AWS_BEDROCK_FORCE_CACHE=1` (`:915-939`). No cache point is placed in `toolConfig`.
- **Mistral**: `prompt_cache_key` and an `x-affinity` header, both set to the `sessionId` (`ai/api/mistral-conversations.ts:357-360, 538-545`).
- **DeepSeek**: nothing is sent; the provider caches automatically. `prompt_cache_hit_tokens` is parsed (`ai/api/openai-completions.ts:1528-1529`).
- **xAI**: uses the Responses path (`prompt_cache_key` plus headers), with `supportsLongCacheRetention:false` (`cat/providers/xai.ts:19`). There is no `x-grok-conv-id`.
- **Local servers**: no pi-specific mechanism; they rely on the server's own prefix cache. Two things to know:
  - With long retention, pi may send `prompt_cache_key` and `prompt_cache_retention` to unknown servers unless compat disables them.
  - llama.cpp's own prompt-cache setting is used only by the classifier (`ai/api/llama-cpp-classify.ts:376`).

**How the coding agent keeps the prefix stable:**
1. **No date or time** anywhere in the prompt. `cwd` is its own section near the end. Section order is preamble, tools, rules, docs, addendum, project_context, skills, cwd, then custom sections (`ca/core/system-prompt.ts:150-191`).
2. Volatile values (`PI_PROVIDER`, `PI_MODEL`, `PI_SESSION_ID`, `PI_REASONING_LEVEL`) go into **bash environment variables** rather than the prompt (`ca/core/tools/bash.ts:214-239`, guideline at `:44-47`).
3. **The prompt is stored in the transcript.** The first request persists every section plus `toolsAdded`. Later changes are diffs per named section (`ca/core/system-prompt.ts:216-228`, `ca/core/agent-session.ts:1828-1840`) appended as system messages. Resuming a session therefore *replays* the original head byte for byte; it does not re-render it.
4. Models flagged as accepting mid-conversation system messages (Claude Opus 4.8/5/5.5, Sonnet/Haiku 5.5, newer GPT Responses models, Kimi, DeepSeek, Copilot, OpenRouter; `cat/families/anthropic.ts:27-34`, `cat/families/openai.ts:134-145`) receive each patch in place. Other models get a collapsed head, which costs one miss per change (`ai/utils/transcript.ts:104-120`).
5. **Tool changes are deltas.** The active tools are treated as a set: tools that stay keep their order and new ones are appended (`ca/core/agent-session.ts:1660-1669`, issue #11495).
   - Anthropic: `tool_addition`/`tool_removal` blocks, plus a never-active deferred placeholder tool. The placeholder is declared from the first request so Anthropic's hidden scaffolding for tool changes is already in the cached prefix; otherwise the first change is a full miss, which the code comments say was measured (`ai/api/anthropic-messages.ts:211-223, 1523-1528`).
   - Responses: `additional_tools` items, or synthetic `tool_search_call`/`tool_search_output` pairs (`ai/api/openai-responses-shared.ts:157-265`).
6. **Thinking-level changes do not touch cached top-level parameters.**
   - Anthropic keeps a fixed `output_config.effort:"low"` and inserts a system effort marker before each reply (`ai/api/anthropic-messages.ts:1540-1551, 1827-1841`).
   - Responses uses `configuration_update` items (`ai/api/openai-responses-shared.ts:134-143`).
7. **Other stability measures:**
   - images are resized once, with a cache-safe profile, as they enter history (`ca/core/agent-session.ts:2131-2151`);
   - failed attempts are hidden from model context by a `context_edit` entry, so a retry replays the pre-failure prefix (`:3948-3949`);
   - MCP tools default to `codemode` exposure, so they are never declared to the model (`docs/mcp.md:191-206`).

**What changes the cache:**
- **Compaction.** The summary request uses `cacheRetention:"none"` and a fresh uuid, and it serializes the whole conversation as text inside one user message (`ca/core/compaction/compaction.ts:626-632, 719-729`). That request is always billed in full.
  - Afterwards the head is the compaction's `systemMessage` checkpoint followed by the summary (`ca/core/session-manager.ts:461-464`). System and tool caching survive; the message cache resets.
- **Model switch.** Same `sessionId`, but foreign thinking is dropped, so it is a full miss. Miss accounting deliberately counts it: "Model switches are NOT exempt" (`ca/core/cache-stats.ts:113-118`).
- **Branching (`/tree`).** The shared prefix is unchanged and the branch summary is appended as a user message.
- **Fork/clone.** These mint a new session id (`ca/core/session-manager.ts:1724, 1756`), which changes OpenAI's routing key.
- **Forced prompts.** A `before_agent_start` handler that returns `systemPrompt` replaces the whole head, a miss whenever the text changes. The docs recommend editing `sections` instead (`docs/extensions.md:657`).

**Cache warming** (`ca/core/cache-warmer.ts`; on by default in `"streaming"` mode, `ca/core/settings-defaults.ts:61`):
- The last real request is resent with `maxTokens:1` and `disableContinuation` at 90% of the TTL, keeping at least 10 s of margin (`:28-32, 330-341`).
- Only a request for the selected model whose transcript is still a prefix of the current one is warmed (`ca/core/sdk.ts:359-373, 412-423`).
- Economics (`:380-402`): warm cost = cache read of the prompt plus 1 output token; miss cost = cache write minus cache read; continuation probability p = 1 while the agent runs and 0.15 when idle. Pi warms only when `p·miss − warm ≥ $0.05`.
- Safety caps: 1 hour while streaming, 30 minutes idle.
- Requests that cannot be replayed safely are excluded: Anthropic budget thinking derives its budget from `max_tokens`, so a 1-token replay would change the cache key (`:48-58`).
- An extension can veto through `cache_warming_decision`. Each warm is stored as a `usage` entry with kind `cache_warm`.
- Lifetimes are annotated only for **direct Anthropic** (`promptCache {short:300, long:3600}`, `cat/providers/anthropic.ts:39-43`), so warming is effectively Anthropic-only unless a user sets `promptCache`.

**Miss observability** (`ca/core/cache-stats.ts:56-141`):
- Missed tokens per turn = min(previous prompt, current prompt) − cacheRead, ignored below a 1,024-token noise floor.
- The re-billed cost uses the turn's actual paid rate minus the cache-read rate.
- Accounting resets at compactions and branch summaries.
- `/session` shows "Cache Re-billed" (`ca/modes/interactive/interactive-mode.ts:6850-6915`).
- Optional per-turn notices label the likely cause, such as model switch or idle beyond the TTL (`:4360-4380`).

**Absent:** explicit Gemini caching; cache points in Bedrock `toolConfig`; any second Anthropic breakpoint inside the history (see §12).

## 5. Session storage

- **Format.** One JSONL file per session at `~/.pi/agent/sessions/--<cwd>--/<ts>_<id>.jsonl` (`ca/core/session-manager.ts:590-595`). The header carries version 3 (`:41`); older files migrate v1→v3 on load (`:287-350`).
- **Entries.** Every entry has `id` (8 hex characters) and `parentId`. Types: `message`, `model_change`, `thinking_level_change`, `usage`, `compaction` (with a `systemMessage` checkpoint), `branch_summary`, `context_edit` (non-destructive omit or replace), `custom` (extension state, not in context), `custom_message` (in context), `label`, `session_info` (`:65-180`).
- **Writes.** The file is created only once a user or assistant message exists, then appended to (`:1161-1190`).
- **Context building.**
  - `buildContextEntries` walks from the leaf to the root and applies the latest compaction (`:476-512`).
  - `buildSessionProjection` applies `context_edit` entries (`:544-574`).
- **Branching.** `/tree` moves the leaf and can append a summary of the branch being left; `/fork` and `/clone` copy history into a new file with `parentSession`.
- **Resume.** Interactive: `/resume`. CLI: `-c`, `-r`, `--session`, `--session-id`, `--fork` (`ca/cli/args.ts:111-140`). Import: `/import`.

## 6. Prompt construction

- **Default prompt** (`ca/core/system-prompt.ts:155-168`): a preamble ("You are a coding assistant running inside pi…"); one line per tool for those that have a `promptSnippet`; rules deduplicated from tool guidelines; a docs-pointer section; and `cwd`. That is about 2.4 KB, roughly 600 tokens. The four default tool schemas (`read`, `bash`, `edit`, `write`; `ca/core/settings-manager.ts:85`) add roughly 700 more. These are estimates from string sizes; nothing was run.
- **No variants by model.** The prompt builder takes no model input. `SYSTEM.md` replaces the default and `APPEND_SYSTEM.md` appends to it, in project scope when trusted or global scope (`ca/core/resource-loader.ts:1245-1271`).
- **Context files** (`ca/core/resource-loader.ts:212-302`): one file per directory, chosen in the order `AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md`. Pi loads the global file, then walks every ancestor of cwd up to the **filesystem root**. Linked-worktree duplicates are removed. Context files load **regardless of project trust** (`docs/security.md`).
- **Skills** use progressive disclosure: only name, description and path go into the prompt, as XML (`ca/core/skills.ts:358-388`). The model reads `SKILL.md` with `read` or `bash` when it needs it. `disable-model-invocation` hides a skill so only `/skill:name` can load it.
  - Locations: `~/.pi/agent/skills`, `.pi/skills` (`:457-460`), and `.agents/skills` from cwd up to the git root (`ca/core/package-manager.ts:506-525`).
- **Prompt templates** are Markdown files with frontmatter and `${1:-default}` arguments, exposed as `/name` commands (`docs/prompt-templates.md`).

## 7. Context management

- **Token estimate.** Pi uses the last assistant's reported usage, plus chars/4 for messages after it, counting about 4,800 characters per image (`ca/core/compaction/compaction.ts:196-224, 276-349`). Usage recorded before a later compaction or edit is not trusted (`:227-262`).
- **Trigger.** Compaction runs when `tokens > contextWindow − reserveTokens`, with a 16,384-token reserve (`:267-270`; defaults in `ca/core/settings-defaults.ts:9-13`). It is checked between turns, before prompts, and on overflow or length errors as a compact-then-retry (`ca/core/agent-session.ts:837-846, 3106-3404`).
- **Algorithm.**
  - Walk back from the newest entry until `keepRecentTokens` (20k) is reached, then cut at a user, assistant, custom or bash message, never at a tool result (`ca/core/compaction/compaction.ts:446-501`).
  - If one user turn is larger than the budget, it is split: its prefix gets its own summary (`:929-942`).
  - The summary format is structured (Goal, Constraints, Progress, Decisions, Next Steps, Critical Context) and is updated iteratively from the `<previous-summary>` (`:540-579`).
  - Tool results are cut to 2,000 characters in the summary input (`ca/core/compaction/utils.ts:95-104`).
  - Read and modified files are tracked cumulatively.
- **Verbatim retention.** Everything from `firstKeptEntryId` onward is kept verbatim.
- **Branch summaries** are generated with a token budget, newest messages first (`ca/core/compaction/branch-summarization.ts`).
- **Tool output truncation** limits output to 2,000 lines or 50 KB, whichever comes first (`ca/core/tools/truncate.ts:11-13`). Bash keeps the tail and saves the full output to a temp file (`ca/core/tools/bash.ts:283, 371-380`). Read streams the file.

## 8. Tool system

- **Built-in tools.** `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `powershell` (`ca/core/tools/index.ts:95-105`); the first four are on by default.
- **Definition format.** A TypeBox schema validated by pi-schema, with optional `prepareArguments`, `outputSchema`, `exposure`, `executionMode`, `renderCall`/`renderResult`, `promptSnippet`/`promptGuidelines` and `prepareLoadout` (`ca/core/extensions/types.ts:600-690`). Tools can be overridden or moved to remote execution through `operations` injection.
- **Edit tool.** Takes multiple disjoint `edits[]` per call and requests `strict:"prefer"` sampling (`ca/core/tools/edit.ts:140-152`).
- **Concurrency.** Calls run in parallel; any tool with `executionMode:"sequential"` makes the whole batch sequential (`agent/agent-loop.ts:518-533`). Edits to the same file are serialized by the file-mutation queue (`ca/core/tools/file-mutation-queue.ts:28-40`).
- **Exposure tiers** (`ca/core/extensions/types.ts:522-537`): `direct`, `model-only`, `codemode`, `deferred`, `hidden`.
  - Built-in extensions: `codemode` (a QuickJS script that calls tools; opt-in), `tool_search`, MCP, llama.cpp (`ca/extensions/index.ts:7-14`).
- **What pi deliberately leaves out.** No permission system (root `README.md`, "Permissions & Containerization"), no sub-agents and no plan mode. Extensions fill the gaps:
  - permissions: `tool_call` gates (`ex/permission-gate.ts:10-33`, `ex/protected-paths.ts`);
  - plan mode: `setActiveTools` limited to read-only tools plus a bash allowlist (`ex/plan-mode/index.ts:112, 168`);
  - sub-agents: each one spawns a separate `pi --mode json -p --no-session` process (`ex/subagent/index.ts:389`);
  - sandboxing: route tools into a micro-VM (`ex/gondolin`).

## 9. Extension and package system

- **API surface.** 41 events (`ca/core/extensions/types.ts:1643-1710`):
  - startup and resources: `project_trust`, `resources_discover`, `mcp_servers_change`;
  - session: `session_start`/`shutdown`/`info_changed`/`before_switch`/`before_fork`/`before_compact`/`compact`/`compact_failed`/`before_tree`/`tree`;
  - context and provider: `context`, `context_with_system`, `before_provider_headers`, `before_provider_request` (replace the payload), `after_provider_response`, `provider_stream_event`, `cache_warming_decision`;
  - agent: `before_agent_start` (structured prompt options or forced prompt), `agent_start`/`end`/`before_settle`/`settled`, `turn_start`/`turn_end` (append entries, request continuation), `message_*` (`message_end` can transform);
  - tools: `tool_execution_*`, `tool_call` (block or mutate), `tool_result` (rewrite);
  - other: `model_select`, `thinking_level_select`, `user_bash`, `input`, `ui_prompt_*`.
- **Handler semantics.** Handlers compose by notification, in-place mutation, chained transform or gate (`docs/extensions.md:412-425`).
- **Registration.** `registerTool`, `registerCommand`, `registerShortcut`, `registerFlag`, message/entry/tool renderers, Markdown transformers, `sendMessage`/`sendUserMessage`, `appendEntry`, `exec`, `setActiveTools`, `setModel`/`setThinkingLevel`, `registerProvider`/`unregisterProvider`, `registerMcpServer`, `registerVirtualModel` (a router that picks a physical model per request) (`ca/core/extensions/types.ts:1717-1960`).
- **Compaction override.** `session_before_compact` can return `{compaction}` or `{cancel}` (`:1532-1535`).
- **Discovery.** `~/.pi/agent/extensions/*.ts`, `*/index.ts`, or a `package.json` with a `pi.extensions` field, one level deep; `.pi/extensions` for projects; settings `extensions`/`packages`; `-e` for a single run.
- **Loading.** Through jiti with `moduleCache:false`, which is what makes `/reload` a true hot reload: `session_shutdown`, then a fresh import, then `session_start` (`ca/core/extensions/loader.ts:571-602`).
- **Packages.** Sources are `npm:`, `git:` or local paths. The manifest is `package.json` `pi.{extensions, skills, prompts, themes, changelogPath}`. Host packages are peer dependencies. Settings can filter resources (`docs/packages.md`).
- **Trust.** Project trust gates `.pi/{settings.json, mcp.json, extensions, skills, prompts, themes, SYSTEM.md, APPEND_SYSTEM.md}` (`ca/core/trust-manager.ts:29-38`). Decisions are stored in `~/.pi/agent/trust.json`. Trust is checked only at load time; after that, extensions run in-process with full privileges.
- **Minimal extension** (`ex/hello.ts`):

```ts
const helloTool = defineTool({ name: "hello", label: "Hello", description: "A simple greeting tool",
  parameters: Type.Object({ name: Type.String({ description: "Name to greet" }) }),
  async execute(_id, params) { return { content: [{ type: "text", text: `Hello, ${params.name}!` }], details: { greeted: params.name } }; } });
export default function (pi: ExtensionAPI) { pi.registerTool(helloTool); }
```

## 10. Performance

- **Lazy loading.** Provider API modules and their SDKs load only on the first request (`ai/api/lazy.ts`). Jiti, the codemode runtime, MCP and image libraries are imported on demand (`ca/core/extensions/loader.ts:50-63`).
- **Import budgets.** `scripts/check-entry-graphs.mjs` treats each package entry point as a cost contract: it walks the import graph and fails `npm check` when an entry exceeds its budget. The script notes that one stray barrel import cost about 37 MB.
- **Startup measurement.** `time()` checkpoints and `PI_STARTUP_BENCHMARK` (`ca/main.ts:990-1039`); `profile:tui` and `profile:rpc` scripts.
- **Streaming.** Tool arguments are parsed incrementally in linear time (`ai/utils/streaming-json.ts`). The TUI renders only changed lines, with synchronized output (`packages/tui/README.md`). Rendered Markdown and highlighting are cached.
- **Concurrency.** Tools run in parallel; the request body is zstd-compressed for Codex SSE (`ai/api/openai-codex-responses.ts:395-402`); a session file is not created until the first message; the read tool streams files.

## 11. Top 8 ideas worth adopting

1. **The prompt lives in the transcript, with named sections and diffs.** `ai/types.ts:559-585`, `ai/utils/transcript.ts:57-120`, `ca/core/system-prompt.ts:127-228`, `ca/core/agent-session.ts:1828-1840`. *Why it matters:* AGENTS.md, skill and plugin changes become append-only patches, so the cached prefix survives and the session file records exactly what the model saw.
2. **Tool loadout as transcript deltas, with in-place delivery on capable APIs.** `agent/agent-loop.ts:342-372`, `ai/api/anthropic-messages.ts:211-223, 1523-1534`, `ai/api/openai-responses-shared.ts:157-265`, `ca/core/agent-session.ts:1660-1669`. *Why:* dynamic MCP and plugin tools stop causing full cache misses.
3. **Per-reply effort markers.** `ai/api/anthropic-messages.ts:1540-1551, 1827-1841`; `ai/api/openai-responses-shared.ts:134-143`. *Why:* routers and users can change reasoning effort on every turn with no cache penalty.
4. **Cache warming driven by expected savings.** `ca/core/cache-warmer.ts:380-402`, `ca/core/sdk.ts:359-423`. *Why:* long tool runs and human pauses stop expiring 5-minute caches, and money is spent only when the expected value is positive.
5. **Cache-miss accounting in dollars.** `ca/core/cache-stats.ts:56-141`, together with `cacheWrite1h` and `ai/models.ts:1262-1268`. *Why:* cache regressions show up per turn as dollar amounts.
6. **Append-only JSONL tree, `context_edit` entries, and per-request canonical projection.** `ca/core/session-manager.ts:439-584`, `ca/core/agent-session.ts:848-875`. *Why:* branching and non-destructive omission of failed attempts, with one source of truth shared by UI, RPC and SDK.
7. **One cross-provider transcript plus declarative `compat` flags.** `ai/api/transform-messages.ts:91-256`, `ai/api/openai-completions.ts:1600-1740`. *Why:* handoff between models works, and LiteLLM, Ollama and vLLM quirks (`cacheControlFormat`, `sessionAffinityFormat`, `thinkingFormat`, `maxTokensField`) are configuration rather than code.
8. **Tool exposure tiers plus codemode and tool_search.** `ca/core/extensions/types.ts:522-537`, `docs/mcp.md:191-206`. *Why:* hundreds of plugin tools without a bloated or unstable declared tool list.

Also worth borrowing: Anthropic threads with prefix hashing, the strict-tools fallback, failing tool calls from truncated replies, exposing session metadata through environment variables, and a fake provider that simulates caching for tests (`ai/providers/faux.ts`).

## 12. Weaknesses and gaps

- **Compaction is uncached.** The summary request serializes the conversation as text and is billed in full (`ca/core/compaction/compaction.ts:626-632, 719-729`). It cannot reuse the warm prefix.
- **Token estimates are heuristic.** chars/4 between usage reports (`:276-349`).
- **Gemini has no explicit caching**, and warming is effectively Anthropic-only (`cat/providers/anthropic.ts:39-43`).
- **Only one Anthropic breakpoint covers the history** (`ai/api/anthropic-messages.ts:1792-1818`). My inference, not tested: a turn that adds more than about 20 blocks, such as a wide parallel tool batch, may fall outside Anthropic's lookback window and miss.
- **Discovery rules are inconsistent and untrusted.** Context files walk up to the filesystem root and load without trust (`ca/core/resource-loader.ts:260-302`), while `.agents/skills` stops at the git root.
- **No permission boundary.** Extensions run with full privileges (`ca/core/extensions/loader.ts:571-602`).
- **Continuation state is process-local** (`ai/api/anthropic-messages.ts:272-305`; the Codex WebSocket pool). It falls back correctly but gives no benefit across processes.
- **Fragile external dependencies.** Pi relies on dated beta features and model-id regexes (`cat/families/anthropic.ts:12-34`). The OAuth path impersonates Claude Code: system prefix, user agent and tool-name casing (`ai/api/anthropic-messages.ts:104-141, 1288-1309`). That is a terms-of-service and breakage risk.
- **Sub-agents are separate processes** (`ex/subagent/index.ts:389`): no shared prefix and separate cache keys.
- **Per-request cloning.** `emitContext` calls `structuredClone` on the whole transcript every request whenever an extension runner exists (`ca/core/extensions/runner.ts:1312-1314`).
- **Smaller issues:**
  - miss notices assume a fixed 5-minute TTL (`ca/core/cache-stats.ts:8`);
  - skills keep `readdir` order rather than sorted order (`ca/core/skills.ts:192`);
  - fork mints a new cache key;
  - there are no prompt variants for small local models.
- **Size.** `ca/core/agent-session.ts` (4,565 lines) and `ca/modes/interactive/interactive-mode.ts` (7,264 lines) undercut the "minimal" label. The core also bundles MCP, codemode and llama.cpp extensions.
- **Where docs and code disagree:**
  - the `CompactionEntry` in `docs/compaction.md` omits the `systemMessage` field that the code (`ca/core/session-manager.ts:91-104`) and `docs/session-format.md` both have;
  - the extension lifecycle table describes `cache_warming_decision` as an "Idle" refresh, but the code also fires it for refreshes during a run (`ca/core/cache-warmer.ts:300-318`).
