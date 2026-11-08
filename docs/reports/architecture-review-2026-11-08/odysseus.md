# Odysseus: code-level architecture study

Repo `odysseus-dev_odysseus` at `1c15090` (branch `dev`, `HARNESS_VERSION` 0.20.19). Paths are relative to the repo root. Every claim below comes from reading the code. Where the docs or specs disagree with the code, I say so.

**Shape.** The backend is a single Python/FastAPI process with a native-ESM frontend that has no build step. Most of the logic sits in a few very large files:
- `src/agent_loop.py` has 38,416 lines. One generator function, `stream_agent_loop`, runs from line 21241 to line 38416 (about 17k lines).
- `src/llm_core.py` has 4,743 lines.
- `routes/chat_routes.py` has 5,321 lines; the `/api/chat_stream` handler alone covers lines 2475–5108.
- `src/clean_agent_preview.py` has 9,031 lines.

The repo has about 1,600 test files. `specs/` is a dense map of how the implementation works and is useful, but parts of it are out of date (§12).

---

## 1. Architecture and turn flow

**Process model**
- One uvicorn process on asyncio, with no `--workers` setting (`Dockerfile:173`, `app.py:1487-1510`).
- The lifespan hook (`app.py:1185-1444`) starts these tasks in the background: MCP connect, tool-index prewarm, background-tool delivery, the Cookbook serve-lifecycle loop, the orphan reaper and the null-owner sweeps. The task scheduler and email pollers also run in-process.
- The built-in MCP servers (image_gen, memory, rag, email) run as Python stdio subprocesses. The browser server runs via `npx @playwright/mcp` (`src/builtin_mcp.py:72-90`).
- Model servers run in **tmux** sessions, either locally or over SSH (`routes/cookbook_routes.py:1602`).
- State lives in:
  - SQLite in WAL mode (`core/database.py:148`), with an FTS5 transcript index (`core/database.py:2532`);
  - JSON files for memory, settings and integrations;
  - Chroma for RAG, memory vectors and the tool index.

**Layers.** `routes/` handles HTTP and much of the orchestration. `src/` holds the runtime (loop, `llm_core`, tools, policy). `services/` holds search, memory/skills, hwfit and research. `core/` holds the DB, sessions and auth.

**One turn through `POST /api/chat_stream`** (`routes/chat_routes.py:2474`):
1. The form is parsed. Regex intent classifiers auto-escalate the turn from chat to agent mode when they detect tool, search, web or browser intent (`chat_routes.py:2673-2694`).
2. `build_chat_context` (`routes/chat_helpers.py:1120`) builds the context:
   - preprocesses attachments, YouTube links and vision-language images;
   - persists the user message;
   - calls `ChatProcessor.build_context_preface` (`src/chat_processor.py:321`), which returns, in order: preset system prompt, `UNTRUSTED_CONTEXT_POLICY`, persona memory, pinned and retrieved memory, RAG, web search, URL page bodies, skills index;
   - assembles `messages = preface + history` (`chat_helpers.py:1338`);
   - adds a datetime tail message (chat mode only, `:1349-1357`);
   - runs `maybe_compact` and then `trim_for_context` (`:1376-1383`).
3. **Chat mode** calls `stream_llm_with_fallback(..., tools=None, session_id=session)` (`chat_routes.py:4273`).
4. **Agent mode** calls `stream_agent_loop` (`chat_routes.py:4693`). The loop:
   - applies the turn contract and the spec router, then either branches to the compact preview (`agent_loop.py:21349-21371`) or runs the legacy loop below;
   - retrieves tools (`:22713`);
   - builds the prompt via `_build_route_request_state` → `_build_system_prompt` (`:24602`, `:14439`);
   - runs up to `MAX_AGENT_ROUNDS=20` rounds (`src/agent_tools/__init__.py:91`) of `stream_llm_with_fallback` (`agent_loop.py:27254`);
   - parses native or fenced tool calls;
   - executes them **sequentially** (`for i, block in enumerate(tool_blocks)`, `:32548`), with a progress queue that is cancelled if the client disconnects (`:33877-33905`);
   - appends results with `_append_tool_results` (`:15897`) and starts the next round;
   - finishes with nudges and loop breakers, a verifier subagent, a completion gate, and the teacher hand-off (`:38396`).
5. `llm_core` normalizes every provider:
   - repairs tool-call/result adjacency (`llm_core.py:2014`);
   - **hoists all system messages to index 0** (`:3018-3029`);
   - builds the payload for each provider;
   - emits SSE events in three shapes: `{"delta"}`, `{"type":"tool_calls"}` and `{"type":"usage"}`.
6. A detached task drains the stream into a replay buffer (`src/agent_runs.py:1-60`), so clients can resume via `/api/chat/resume/{id}` (`chat_routes.py:5109`). The buffer is in-memory only and does not survive a restart.
7. Saving the reply (`chat_helpers.py:1651-1712`):
   - tool markup is stripped from the text;
   - thinking goes to message metadata;
   - tool events go to `metadata.tool_events`.

   Memory and skill extraction are then queued to run one at a time (`:1772-1806`).

## 2. Modes

- **Plain chat.** Uses the preface plus history, no tools, and a datetime tail message.
- **Agent (legacy loop).** The default for ordinary models. The prompt and transport are chosen per route by `_agent_route_tool_mode` (`agent_loop.py:8389-8473`):
  - **Textual:** a fenced-block `TOOL_SECTIONS` prompt.
  - **Compact native:** short rules plus JSON schemas.

  The choice depends on the `supports_tools` flag, an API-host allowlist and model-name heuristics; Ollama defaults to textual. It can be overridden per model with `model_tool_modes` = none/compact/full.
- **Compact v3 preview** (`clean_agent_preview.stream_preview`, `:5625`).
  - Selected for model IDs that contain the `odysseus` or `ajax` token (`src/model_profiles.py:11-36`, `chat_routes.py:130-138`).
  - Uses immutable `TurnContract` capability families (`src/turn_contract.py:23-51`) and `compact_contract_v5` schemas (`clean_agent_preview.py:2664`).
  - Calls OpenAI-compatible endpoints directly with httpx.
  - Forces temperature 0 for the merged-tools fine-tuned models.
- **Spec router.** An optional 0.8B model that scores which tool should come next and can only narrow the contract (`src/spec_router.py:1-15`).
- **Plan mode.** Applies a denylist of mutating tools plus `update_plan` (`chat_routes.py:3580-3582`). The spec says the route forces plan mode off, but the code honors `plan_mode` (`chat_routes.py:2526`, `:2562`) and the frontend sends it (`static/js/chat.js:2899-2924`).
- **Deep research.** Runs in chat mode only; the frontend forces `mode=chat` (`chat.js:2937-2941`). It runs as a background job using an IterResearch-style loop: plan → search → extract → synthesize → decide (`src/deep_research.py:438-626`).
  - Each round's prompt is the question plus the *evolving report* plus a window of findings (`:1702-1737`), so the transcript never grows.
  - Extraction uses a semaphore (`:1207-1226`), and there is a fast path for simple facts on small models (`:413-466`).
- **Compare.** Creates N `[CMP]` sessions, each streamed with `compare_mode=true`, which strips tools (`chat_routes.py:3559-3576`). Panes can run sequentially and each can get a synthesis (`static/js/compare/index.js:836-883`).
- **Document editing.** The active document is injected as a protected, untrusted, line-numbered message. Editing uses FIND/REPLACE `edit_document` and `suggest_document`, with separate PDF-form and email-draft modes (`agent_loop.py:14630-14760`). Document tool arguments stream live as `tool_call_delta` events (`llm_core.py:3384-3387`).
- **Email reader** (`agent_loop.py:14762-14830`) and **triage pollers.** Triage makes separate one-shot calls per message: summary, AI reply, calendar extraction, urgency and spam (`routes/email/email_pollers.py:1026-1470`). Each call uses a static system prompt and goes through `task_llm_call_async`, which waits for the UI to go quiet and tags the request as background workload (`src/task_endpoint.py:73-111`).
- **Scheduled tasks.** Run the same `stream_agent_loop` with a fresh `[system, datetime-user, prompt]` message list (`src/task_scheduler.py:2020-2040`, background workload at `:2100`). Tools come from RAG retrieval plus `ASSISTANT_ALWAYS_AVAILABLE` (`:1795`).
- **Other modes.**
  - Background bash jobs, with an auto-continue monitor (`src/bg_monitor.py:1-40`).
  - Durable research results delivered back into the originating chat (`docs/BACKGROUND_TOOL_JOBS.md`).
  - Teacher escalation: when a self-hosted student fails a regex check, a SOTA teacher model answers and writes a SKILL.md draft (`src/teacher_escalation.py:1-23`).
  - Incognito, guide-only/no-tools policy (`src/tool_policy.py`), research-spinoff "Discuss" sessions (memory and RAG off), and a TUI/native surface that accepts external tool schemas.
  - Companion LAN pairing (`companion/`).

## 3. Provider abstraction

- **Routing.** `_detect_provider` (`llm_core.py:1107`) matches on hostname and picks one of four paths:
  - Anthropic native Messages (`:1861`);
  - Ollama native `/api/chat` (`:872`);
  - ChatGPT-subscription Codex Responses (`:1569`; OAuth device flow in `src/chatgpt_subscription.py`);
  - everything else OpenAI-compatible, with quirk hooks (`:3047-3091`): Kimi UA retry, Opus temperature omission, `max_completion_tokens`, Mistral effort, DeepSeek V4 thinking defaults (`:1481`), local Qwen `chat_template_kwargs.enable_thinking` (`:1242`), and `think:false` on Ollama `/v1` (`:3074-3079`).

  Bedrock, Azure and Cohere have spec files but take the generic OpenAI-compatible path.
- **Reasoning.**
  - `reasoning_content`, `reasoning` and `thinking` deltas are read (`:3729`) and emitted with `thinking:true`. They are kept out of the saved text and stored in metadata.
  - A harmony stream router handles gpt-oss (`:358`), and Mistral thinking blocks are parsed separately (`:1786`).
  - `reasoning_content` is kept only on the latest assistant message, except for DeepSeek, which keeps all of it (`agent_loop.py:16044-16048`).
  - Gemini thought signatures are echoed back (`:16073`).
  - Anthropic extended thinking is **not** implemented: the payload has no `thinking` field and the stream parser ignores `thinking_delta`.
- **Tool-call formats.**
  - Native OpenAI tool calls. Anthropic `tool_use` blocks are converted to and from them (`llm_core.py:1867-1946`, `:3362-3442`).
  - Prompted fenced blocks, where the tool name is the language tag: ```` ```web_search {"query":..}``` ```` (`src/tool_parsing.py:35-40`).
  - Recovery parsers for `[TOOL_CALL]`, XML `<invoke>`, Qwen `<function=…>`, Gemma, StepFun/DSML, `<function_model>` and raw OpenAI JSON blobs (`tool_parsing.py:110-308`).
  - If a provider rejects native tools, the route falls back to textual tools for 15 minutes (`agent_loop.py:8304-8326`).
  - Tool names that collide with gpt-oss built-ins are aliased at the provider boundary (`llm_core.py:1436-1468`).
- **Fallback.** `stream_llm_with_fallback` (`:4477`) tries an ordered chain of candidates. It only moves to the next candidate on an eligible failure before any content has streamed; once output starts, the route is pinned. Foreground fallback is opt-in per owner (`src/foreground_model_routing.py`).
- **Usage and cost.**
  - Usage is normalized into events.
  - OpenRouter's `usage.cost` is passed through (`:3696-3704`).
  - llama.cpp `timings` give true decode and prefill tokens/s (`:3706-3717`).
  - Usage is bucketed per round with model and endpoint attribution (`agent_loop.py:16315-16370`).
  - Otherwise cost falls back to a hardcoded price table (`src/model_pricing.py:20-103`) that has **no cache tiers**. Anthropic `input_tokens` excludes cache read and write tokens, so estimated Claude cost is wrong whenever caching is active.
- **Robustness.**
  - One shared keep-alive `AsyncClient` (`:645-659`).
  - A dead-host cooldown that trips after 2 consecutive failures and lasts 20 s (`:294-296`).
  - A first-token watchdog for local endpoints (`:214-233`).
  - A degenerate-repetition guard for local streams (`:439`).
  - Recovery from provider "context too long" errors (`src/generation_budget.py:13-37`).
  - An exact-match memo of non-streaming responses (128 entries), applied even when temperature > 0 (`llm_core.py:255-284`, `:2705-2714`).

## 4. Prompt and session cache handling (most important)

### 4.1 What is deliberately cache-aware (issue #2927)

Issue #2927 identified three ways Odysseus was destroying llama.cpp/LM Studio KV-cache reuse. Each has a fix, and `tests/test_kv_cache_invalidation_2927.py:1-18` covers them.

1. **The timestamp is out of the system prompt.** It is now a user-role message placed just before the latest user turn (`src/user_time.py:221-241`; `agent_loop.py:14590-14605`, `:15224`; `chat_helpers.py:1340-1357`; `task_scheduler.py:1748-1752`, `:2032-2040`).
2. **Side requests no longer run during the main turn.** Memory, persona and skill extraction wait until the session stream is idle and then run strictly one at a time (`chat_helpers.py:1759-1806`, docstring at `:1833-1843`).
3. **Slot affinity.** For self-hosted OpenAI-compatible endpoints only, the request carries a stable `session_id` plus `cache_prompt:true` (`llm_core.py:1149-1193`, applied at `:3086`). It is never sent to cloud APIs, because strict providers return 400/422.

Related mechanisms:
- **Local model gate.** Each local `host:port` gets one lock. Foreground work cancels in-flight background calls, and background work waits for UI quiet (`llm_core.py:94-178`, `src/interactive_gate.py`). This also keeps tasks from evicting the chat's KV cache.
- **Volatile, user-editable context** (active document and email, email style, integrations, MCP descriptions, skills, datetime) is inserted just before the latest user turn and never persisted (`agent_loop.py:15185-15224`). The history prefix therefore stays stable.
- **Deterministic ordering.** Schemas follow the order of the `FUNCTION_TOOL_SCHEMAS` list, and prompt sections follow the order of the `TOOL_SECTIONS` dict.
- **Anthropic** gets two `cache_control: ephemeral` breakpoints (`llm_core.py:1919-1945`):
  - on the system block, when tools are present or the system text exceeds 4,000 characters;
  - on the last tool.

### 4.2 Where the prefix still breaks (verified in code)

- **(a) Retrieval results sit *before* the history.** Memory (BM25-hybrid, chosen per query; `chat_processor.py:144-216`, `:380-427`), RAG results, web results and URL bodies all go into `preface`, and `messages = preface + history` (`chat_helpers.py:1338`). Any change in retrieved memory therefore invalidates the cache for the entire history on every turn.
  - The docstring at `chat_processor.py:342-353` says volatile content belongs at the end; the code does not do that.
  - The #2927 test harness uses a static preface (`tests/test_kv_cache_invalidation_2927.py:49-55`), so it misses this case.
- **(b) System messages are hoisted.** `llm_core` merges every system message into position 0 (`:2363`, `:2674`, `:3018-3029`), and the Anthropic builder does the same (`:1866-1868`). The legacy loop has 73 places inside `stream_agent_loop` that create system-role messages, most of them mid-run nudges appended to `messages` (e.g. `agent_loop.py:29548`, `:30862`, `:31506`). After hoisting, each nudge rewrites the cached system prefix.
  - Research clarification inserts a system message at index 0 (`chat_routes.py:3979`).
  - Compaction summaries are also system-role (`context_compactor.py:678`, persisted at `:779-783`). These are stable between compactions, so they cost less.
- **(c) The tool set changes every turn.** Each turn gets the top-8 retrieved tools, 16 `ALWAYS_AVAILABLE` tools and keyword hints (`src/tool_index.py:37-62`, `:604-704`; `agent_loop.py:22713`). That changes the `TOOL_SECTIONS` prompt subset, the native schema list and the Anthropic tool breakpoint. The prompt is also extended conditionally:
  - email rules when the last user text contains "email", "send" and similar (`:14862-14890`);
  - workspace rules (`:14910-14929`);
  - email-format rules (`:14935`).

  The base-prompt cache key includes `relevant_tools` (`:14545`).
- **(d) The compact v3 system prompt starts with a microsecond timestamp:** `f'You are Odysseus. Current UTC date and time: {datetime.now(timezone.utc).isoformat()}. '` (`clean_agent_preview.py:5732`). This gives zero prefix reuse across turns and contradicts the #2927 fix. The same path also:
  - bypasses `llm_core`, so it sends no `session_id`/`cache_prompt` and skips the local gate (`:5523-5560`, `:6052`);
  - appends per-turn classifier output to `history[0]` (`:6093-6100`).

  It does one thing well: within a turn, corrections are appended at the tail as user-role `_harness_control` messages (`:6242`, `:7080`).
- **(e) Old history is rewritten in place every round** in `_append_tool_results`:
  - old browser DOM snapshots are retired (`agent_loop.py:15956`);
  - old tool images are retired (`:15982`);
  - `reasoning_content` is stripped from older assistant messages (`:16048`).

  This deliberately trades cache hits for bounded context.
- **(f) Trimming slides and reorders.** `trim_for_context` pops the oldest turns and moves `_protected` messages to just after the system block (`context_compactor.py:383-547`). Once a session is over budget, the prefix shifts on every turn.
- **(g) Anthropic gets no message-level breakpoint.** History and tool results are never cached, and the long TTL is not used.
- **(h) OpenAI.** There is no `prompt_cache_key` anywhere. The ChatGPT-subscription payload allow-list excludes it and sets `store:False` (`llm_core.py:1595`, `:1608-1611`).
- **(i) Docker ordering quirk.** Under Docker, `/.dockerenv` adds a backend-runtime user message *after* the latest user turn (`agent_loop.py:14496-14509`, `:4244-4264`). The tail-insertion index then lands on that message (`:15185`), so all the injected context ends up *after* the user's request.
- **(j) Previous turns' tool rounds are not replayed.** Only user and assistant text is persisted; tool calls and results live in metadata (`core/models.py:164-212`, `chat_helpers.py:1700-1712`). The next turn's prefix diverges where the previous turn's tool rounds began, so agent rounds only get cache hits within a turn.

### 4.3 Serving-side cache flags (Cookbook)

The serve command is built client-side; the server validates it.

- **vLLM.** `--enable-prefix-caching` is added only when the checkbox is ticked (`static/js/cookbook.js:727`), and the checkbox defaults to off (`static/js/cookbookServe.js:1742`). This is harmless on recent vLLM versions, which enable prefix caching by default.
- **SGLang.** `--disable-radix-cache` is added **unless** the checkbox is ticked (`cookbook.js:772`). With the default unticked, **RadixAttention is off by default.** Re-parsing a saved command looks for `--enable-prefix-caching` (`cookbookServe.js:2464`, `cookbookRunning.js:1849`). An SGLang command never contains that flag, so editing a preset always turns the cache back off.
- **llama.cpp.** The command includes `-c`, `--flash-attn auto|on`, `--cache-type-k/v` and an optional `--parallel` (`cookbook.js:782-894`). The hwfit profiles pick a q8_0 or q4_0 KV cache (`services/hwfit/profiles.py:131-147`). The command never sets `--cache-reuse`, `--slot-save-path` or `--swa-full`.
  - The affinity field Odysseus sends is `session_id`. Upstream llama-server documents `id_slot`. Check that your target server actually honors `session_id`.
- **Ollama.** `num_ctx` is sent only when the context length is known (`llm_core.py:872-907`). **No `keep_alive`** is sent on chat requests; `keep_alive:0` is only used to unload (`cookbookRunning.js:1157`). The model therefore unloads after Ollama's default idle time.

### 4.4 Model switching, persistence and telemetry

- **Model switching.** Fallback candidates get route-neutral context shaping. Each route's prompt is rebuilt after removing route-specific injected messages (`_strip_agent_injected_messages`, `agent_loop.py:14078`). Only the answering route's compaction is persisted (`context_compactor.py:711-736`; `chat_routes.py:1377-1424`). Nothing warms the cache after a switch.
- **Persistence and resume.** Sessions and messages live in SQLite, with lazy hydration (`core/session_manager.py`). Detached runs replay from an in-memory buffer (evicted 180 s after the run finishes, `agent_runs.py:48`). Background jobs are durable.
- **Cache-hit telemetry.**
  - The only signal is an INFO log line for Anthropic cache read/write tokens (`llm_core.py:3411-3420`). It is not added to usage, metrics or the UI.
  - OpenAI `cached_tokens` is never read.
  - llama.cpp `timings` are parsed for tokens/s but not for cache reuse.

## 5. Prompt construction

**Final order (legacy agent loop, native install)**

1. A system block: preset prompt, `UNTRUSTED_CONTEXT_POLICY` (`src/prompt_security.py:8-17`) and the agent prompt.
2. Preface messages, all untrusted and user-role: persona memory, pinned and retrieved memory, RAG, web results, URL pages and the skills index.
3. The history.
4. Context blocks: active document, active email, email style, recent email context, integrations, MCP descriptions, skills (index plus matched procedures) and datetime.
5. The latest user turn.

**Untrusted wrapping.** Untrusted content goes through `untrusted_context_message`, which adds a fixed header and guard markers and escapes guard text inside the content (`prompt_security.py:63-99`). Consecutive user messages are separated by an invisible U+2063 assistant turn (`llm_core.py:2011`, `:2124-2128`).

**Agent prompt variants**
- **Textual:** preamble, then `TOOL_SECTIONS` for the included tools (about 36 KB, roughly 9k tokens, if all are included; `agent_loop.py:7897-8167`), then base rules and per-domain rules (5.6 KB; `:7073`).
- **Compact native:** a two-line preamble, `_API_AGENT_RULES` and the domain rules (`:8214-8244`). The full set of 92 native schemas is about 127 KB of source (`src/tool_schemas.py:298-2017`), so retrieval is essential.
- `_AGENT_PREAMBLE`, `_AGENT_RULES` and `_API_AGENT_RULES` are each defined twice; the second definition wins (`:6908` vs `:7033`).
- Users can override built-in tool descriptions, and an edit busts the prompt cache (`:8169-8187`, `:14540-14545`).

**Memory and RAG**
- At most 5 memories in total per turn. Pinned identity/contact memories are always included; the remaining slots are filled by BM25-hybrid retrieval, first over other pinned memories and then over unpinned ones (`chat_processor.py:142-216`, `:380-420`). Explicit memory-management requests skip this preload (`:205-214`).
- RAG uses k=5, a similarity threshold of 0.35 and a 10k-character cap (`:432-459`).
- When web search is on, the model generates the search query (`:473-499`).

**Skills**
- Skills are SKILL.md files with YAML frontmatter (`services/memory/skill_format.py:1-45`). Disclosure is progressive, inspired by Hermes (`docs/skills-lifecycle.md`): an index first, then procedures for matched skills, up to 3 by default and 12 at most (`agent_loop.py:14986-15099`). Eligibility is gated by audit and confidence.
- In agent mode the index is injected **twice**: once in the preface (`chat_processor.py:578-600`) and again in the skills tail block (`agent_loop.py:15288-15336`).

**Workspace instructions.** `AGENTS.md` is loaded from the workspace and every directory above it up to the root (at most 8 files, 12k characters each), as untrusted context (`agent_loop.py:4267-4300`).

**Model-size variants**
- Qwen tool-router LoRAs get a dedicated 7.8 KB prompt. The conversation sent is the latest message only, unless a turn contract asks to preserve the conversation (`:781-865`, `:14460-14488`).
- Local Qwen and MiniMax get forced sampling and stop settings (`llm_core.py:1295-1336`).
- Fine-tuned Odysseus/Ajax models get compact v5 schemas.
- Deep research has a fast path for small models.
- The ROADMAP itself lists "Agent prompt/context bloat" as a known high-priority problem.

## 6. Context management

**Token estimates.** Tokens are estimated heuristically, not tokenized:
- 0.3 per ASCII character, 1 per non-ASCII character, plus tool-call arguments (`src/model_context.py:502-532`);
- schema JSON at 0.3 per character (`src/generation_budget.py:78-85`);
- a 1,024-token reserve per image (`:46`);
- a safety margin of 2% (floor 1k, cap 2k) (`:63-75`).

**Context window discovery.** `/slots`, then `/props`, then `/v1/models`, then a known-models table, then the proxy catalog (`model_context.py:401-500`). Local endpoints are never cached.

**Budget.** The default setting of 6,000 tokens is treated as "auto": the budget becomes 85% of the known window, capped at 200k. An explicit setting is honored (`src/context_budget.py:28-68`).

**Compaction.**
- Triggers at 85% usage; the threshold is configurable from 50% to 95%.
- Summarizes the *older half* of non-system messages with the utility model, using a structured self-summary prompt (1,024 tokens max, each message truncated to 2k characters).
- Stores the summary as a persisted system message (`context_compactor.py:173-215`, `:552-706`).
- Unattended runs trim deterministically to 75% instead (`:588-606`).
- `_update_session_history` offsets the split by the count of *preface* system messages, which are not in `session.history` (`:756-793`). The persisted split is probably misaligned by a few messages.

**Trimming** (`:383-547`):
1. drop extra system messages;
2. truncate the system prompt to 2,000 characters;
3. drop old turns, protecting the latest user turn and its tool tail;
4. truncate the tail;
5. as a last resort, keep only the latest user message.

**Tool output caps.** Bash, python and web output are capped at 10k characters and file reads at 20k (`src/constants.py:121-123`). Web output is condensed to 3,200 characters for small router models (`agent_loop.py:16167`). The spec admits there is no central cap on MCP output. Prior visual evidence is limited to 1 record and 3 frames (`:15990-16035`).

## 7. Tool system

- **Registry chain, kept in sync by hand:**
  - `TOOL_HANDLERS` (`src/agent_tools/__init__.py`);
  - `FUNCTION_TOOL_SCHEMAS`;
  - `TOOL_SECTIONS` (prompt text);
  - `BUILTIN_TOOL_DESCRIPTIONS` (retrieval text);
  - the `_TOOL_NAME_MAP` aliases.
- **Retrieval.** Chroma embedding lanes plus keyword, non-Latin and URL hints, with a 1.5 s timeout before falling back to keywords (`tool_index.py:361-704`; `agent_loop.py:8304`, `:22700-22760`). Selection is explicitly not authorization.
- **Execution.**
  - Calls run sequentially. There are repeated-call and redundant-read suppression, per-turn budgets, a loop breaker and an intent-nudge cap.
  - `execute_tool_block` enforces admin and public blocks (`mcp__*` is blocked for non-admins), path confinement and truncation.
  - An in-process `app_api` loopback uses a per-process internal token (`THREAT_MODEL.md`).
- **Approvals (the strongest part).**
  - Each tool is classified by `ToolEffect` and `ResultIntegrity` (`src/tool_capabilities.py:23-46`).
  - Once untrusted content has entered a run, `decision_for` blocks execution, mutation and side-effect tools (`:1138-1200`).
  - The blocked call becomes an approval sealed to the exact action, scoped to the task or the chat, with a 10-minute TTL and bound to owner, session, workspace and document digest (`src/tool_approvals.py:1-40`).
- **Shell sandbox.**
  - `src/containment.py` implements **enforcing** bubblewrap containment: filesystem plus PID namespace plus wall clock, with network inherited unless the spec asks for `none` (`:84`, `:105`, `:418`, `:839-880`). When bwrap is unavailable, execution is refused (`subprocess_tools.py:519-560`, `:395-445`).
  - This contradicts `THREAT_MODEL.md` Known Gap #1 ("no sandbox").
  - `Dockerfile:45-68` does not install bubblewrap. Verify how bash behaves in Docker before trusting either claim.
- **Delegation and subagents.**
  - A fresh-context verifier subagent (`agent_loop.py:16821-16868`).
  - `chat_with_model` (`src/agent_tools/model_interaction_tools.py:30`), `pipeline`, `ask_teacher`, and `create_session`/`send_to_session` (`src/agent_tools/session_tools.py`).
  - Disk-backed background jobs with auto-continuation (`bg_jobs`, `bg_monitor`).

## 8. Plugin, extension and integration system

There is **no in-process plugin or manifest system.** Extension happens through these surfaces:

1. **MCP** (`src/mcp_manager.py`).
   - Transports: stdio, SSE and Streamable HTTP (`:173-434`). Remote servers get OAuth with encrypted tokens (`src/mcp_oauth.py`).
   - Tools are namespaced `mcp__{server}__{tool}` and described as `[MCP:label]` (`:698-735`).
   - Untrusted schemas are capped when rendered into the prompt: 12 parameters and 40-character tokens (`:51-118`). Descriptions are injected as untrusted context.
   - A tool is treated as read-only if it carries `readOnlyHint` annotations or matches a name heuristic (`:120-146`).
   - Disabled tools are filtered per server.
   - Approvals fail closed for arbitrary MCP tools. The exception is local stdio servers whose read and write tools are explicitly declared via env (`THREAT_MODEL.md`).
   - **Isolation weakness:** a stdio server whose config sets any env var receives the entire parent `os.environ` (`mcp_manager.py:218-222`).
2. **Built-in MCP servers** (`src/builtin_mcp.py:72-90`). Registered at startup; built-in servers can reconnect after a crash.
3. **Generic REST integrations** (`src/integrations.py`). Each preset is `{name, auth_type, auth_header, description}` (Miniflux, Gitea, Linkding, Home Assistant, ntfy, Discord, … `:28-160`). They are stored with encryption in `data/integrations.json` and called through the `api_call` tool, which enforces relative paths and pins the connection to the validated IP to prevent SSRF via DNS rebinding (`:378-506`). Descriptions are injected as untrusted context (`agent_loop.py:15107-15118`).
4. **Skills.** SKILL.md files that can be imported, audited, published or drafted (written by the teacher), as covered in §5.
5. **Inbound access for external agents.**
   - A scoped `/api/codex/*` surface, used by both Codex and Claude Code (`routes/codex_routes.py`).
   - Distributable bundles: `integrations/codex/.codex-plugin/plugin.json` (`skills: ./skills/`) and the Claude skill `integrations/claude/skills/odysseus/SKILL.md`.
   - Bearer API tokens with scopes. These are hashed with bcrypt and looked up through a prefix cache (`app.py:341-500`).

   Note the direction: Odysseus exposes itself *to* vendor CLIs. It does not use them as model backends.
6. **Webhooks and pairing.** HMAC-signed outbound webhooks; inbound task-trigger webhooks; an event bus; companion pairing that mints chat-scoped tokens (`companion/routes.py`).

## 9. Local-model workflow

1. **Hardware detection.** `detect_system` (`services/hwfit/hardware.py:794`) works locally or over SSH and covers NVIDIA, AMD gfx, Apple Silicon and Windows via PowerShell. Results are cached for 24 h. GPUs are grouped into identical pools for tensor parallelism (`:53-83`).
2. **Catalog.** The shipped catalogs are empty JSON lists (`services/hwfit/data/README.md`). A Rescan pulls Hugging Face org collections and MLX-community models, and vLLM recipes can be imported. A fresh offline install therefore shows no recommendations.
3. **Fit and ranking.** `analyze_model` and `rank_models` (`fit.py:431`, `:708`) walk a quantization ladder and score VRAM/RAM fit, context, quality and architecture.
   - Speed is estimated from memory bandwidth. Under CPU offload it uses a **harmonic blend** of GPU and CPU bandwidth: `1/(f/cpu_bw + (1-f)/gpu_bw)` (`fit.py:184-236`).
   - llama.cpp serve profiles (Quality / Balanced / Speed) compute `n_cpu_moe`, KV-cache type and context, shrinking context until it fits (`profiles.py:91-238`).
4. **Download.** Uses `hf download` in tmux, writing to the Hub cache so interrupted downloads can resume, or `ollama pull` (`cookbook_routes.py:941-990`).
5. **Serve.**
   - The frontend builds the command (`cookbook.js:600-900`).
   - The server validates and normalizes it, then runs it in tmux or as a PowerShell process (`cookbook_routes.py:1602-1700`).
   - Failures are matched against a catalog of error patterns, each with a one-click retry that edits the flags (`routes/cookbook_helpers.py:1430-1470`, `static/js/cookbook-diagnosis.js`).
6. **Wiring into chat.** The served model is auto-registered as a `ModelEndpoint` with `endpoint_kind=local` and manual refresh (`routes/cookbook/endpoint_registration.py:97`, called at `cookbook_routes.py:2399`). It then appears in the model picker, where its context window is discovered via `/slots`/`/props`. The agent can also drive the Cookbook through tools (`src/tools/cookbook.py`).
7. **Fine-tuning ecosystem.** The runtime has dedicated code paths for the project's own Ajax/Odysseus fine-tuned models: model-ID profiles (`src/model_profiles.py`) and Qwen router LoRA handling. It also captures SFT traces for synthetic `sft_*` users (`chat_helpers.py:162-230`), and many teacher-distillation and eval scripts live under `scripts/`. I did not verify whether model weights are distributed.

## 10. Performance

**Speed-ups**
- Warm shared HTTP client.
- Dead-host cooldown.
- First-token watchdog.
- Detached streams, so generation survives a disconnected tab.
- GZip; static files revalidate rather than using hashed builds.
- Tool-index prewarm (`app.py:1259-1278`) and optional endpoint keep-alive pings (`:1308-1319`).
- Lazy transcript hydration.
- llama.cpp `timings` for honest tokens/s.

**Costs**
- **Blocking I/O on the event loop.** `get_context_length` makes synchronous `httpx.get` calls with a 5 s timeout and **never caches local endpoints** (`model_context.py:246-268`, `:425-460`). It is called from async paths: `llm_core.py:2697`, `:3043`, `:4577` and `context_compactor.py:573`. In addition, `is_local_endpoint` opens a DB session and scans `ModelEndpoint` on every call (`model_context.py:56-103`), and it is called many times per request.
- **The local gate serializes per host:port, even on batch-capable vLLM/SGLang.** As a result, deep-research extraction against local models effectively runs one at a time (`deep_research.py:1207-1226` vs `llm_core.py:2836`).
- **Tools never run in parallel.**
- **One process, plus a 17k-line generator.**

## 11. Top 8 ideas worth adopting

1. **A local-model gate that gives foreground work priority** and cancels background calls, plus a UI "quiet" gate before background jobs run (`llm_core.py:94-178`, `src/interactive_gate.py`). Why it matters: on single-GPU servers it prevents crossed streams and protects the chat's KV cache.
2. **Volatile context as user-role tail messages, backed by explicit KV-cache regression tests** (`user_time.py:221`, `agent_loop.py:15185-15224`, `tests/test_kv_cache_invalidation_2927.py`). Why it matters: it keeps the system prefix byte-identical. Adopt the tests, but put retrieval *after* history too, unlike Odysseus.
3. **Post-turn side jobs serialized after the stream goes idle** (`chat_helpers.py:1772-1806`). Why it matters: memory and skill extraction stop evicting the main conversation's cache.
4. **Taint-gated, exact-action approvals** (`tool_capabilities.py:1138`, `tool_approvals.py`). Why it matters: prompt injection cannot reach send/shell tools without a sealed, single-use user decision, instead of relying on prompt warnings.
5. **Tool retrieval with a guaranteed core floor, keyword fallback and a hard timeout**, plus per-model none/compact/full tool surfaces (`tool_index.py:604-704`, `agent_loop.py:8389-8473`). Why it matters: small models get a small tool menu without losing obvious tools.
6. **Robust textual tool calls for local models**: fenced blocks with many recovery parsers, and a 15-minute TTL fallback from native to textual (`tool_parsing.py`, `agent_loop.py:8304-8326`). Why it matters: makes tool use work on servers with weak native function calling.
7. **Hardware-fit math**: bandwidth-blend speed estimates, VRAM-fit serve profiles, and error diagnosis with one-click retries that edit flags (`fit.py:184`, `profiles.py:91`, `cookbook_helpers.py:1430`). Why it matters: turns tuning a local serve into a deterministic, explainable formula.
8. **A fresh-context verifier subagent plus teacher escalation that writes SKILL.md drafts** (`agent_loop.py:16821`, `teacher_escalation.py`). Why it matters: an independent completion check, and a student→teacher distillation loop that improves local models over time.

Also worth a look:
- the Markovian deep-research state (evolving report instead of a growing transcript);
- the `AGENTS.md` walk up to the filesystem root;
- llama.cpp slot affinity;
- detached-run replay buffers;
- tool-name aliasing for gpt-oss.

## 12. Weaknesses and gaps

- **Maintainability.**
  - One 17k-line generator.
  - Around 80 top-level regex intent helpers with names like `_parse_qwen_explicit_*` and `_looks_like_*` in `agent_loop.py`.
  - The tool registry has to be kept in sync by hand across 5 or more places.
  - The 2.6k-line route handler.
- **Cache.** The issues in §4.2(a–j), plus SGLang's radix cache defaulting to off, no Ollama `keep_alive`, no `prompt_cache_key`, no Anthropic history breakpoint, and no cache telemetry or cache-aware cost.
- **Correctness risks.**
  - Compaction split misalignment (`context_compactor.py:756-793`).
  - The Docker tail-ordering quirk (§4.2i).
  - The skills index duplicated in agent mode.
  - The response memo caches outputs with temperature > 0.
  - No Anthropic thinking support.
  - MCP servers inherit the environment, and there is no central MCP output cap.
  - Detached runs do not survive a restart.
- **Docs that disagree with the code.**
  - `THREAT_MODEL.md` Known Gaps #1–3 are stale:
    - #1: bubblewrap containment now exists.
    - #2: `/api/v1/chat` now validates `base_url` with `validate_public_http_url` (`routes/webhook/webhook_routes.py:286-291`).
    - #3: `src/search/*` are now re-export shims (e.g. `src/search/ranking.py:1-14`).
  - `specs/chat.md` says plan mode is forced off; the code honors it.
  - The `memory_extractor` docstring still says FAISS (`services/memory/memory_extractor.py:1-10`).
  - The `chat_processor` cache docstring contradicts preface placement (§4.2a).
