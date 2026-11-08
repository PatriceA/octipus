# Hermes Agent (NousResearch): code-level architecture study

Shallow checkout `48c7a09f`. Paths are relative to the repo root. I only read the checkout (committed JSON fixtures were parsed with `python -I`). Where the docs and the code disagree, this report follows the code, and §13 lists the drift.

**Scale:**
- `agent/` has 366 modules.
- The turn loop is about 35 `agent/turn_*.py` phase files.
- Persistence is about 60 `hermes_state_*.py` files.
- The developer docs total 1.3 MB.

**Two invariants** shape every change (`AGENTS.md:19-28`):
- The per-conversation prompt cache is sacred. Only compaction may break it.
- The core stays narrow. New capability arrives as plugins, skills or MCP.

## 1. Architecture and turn flow

**Process model (recently changed; the docs lag).**
- **The gateway authority:** one process per profile (`hermes gateway run`). It starts on demand, exits when idle, and owns sessions, `AIAgent`s, tools and approvals.
- **Every UI is a client:**
  - Classic CLI: "never AIAgent" (`hermes_cli/gateway_chat.py:1`; `hermes_cli/main.py:1603-1604`).
  - Ink TUI and Electron Desktop: JSON-RPC over WebSocket, with Pydantic contracts generated into TypeScript (`tui_gateway/AGENTS.md:8-22`).
  - Dashboard.
- **Also in that process:** 26 platform adapters (`plugins/platforms/*`), an OpenAI-compatible API server (`gateway/platforms/api_server.py:1-6`), the cron ticker and the kanban dispatcher.
- **Admission and execution:** turns go into a durable FIFO (`session_admissions`, `hermes_state_common.py:596-622`). They may run in managed worker subprocesses of kind cron, child, compute or kanban (`:623-636`; `gateway/session_managed_worker.py`).
- **Drift:** `architecture.md` still shows the CLI calling AIAgent in-process.

**Core.**
- `AIAgent` is a facade over 14 mixins (`run_agent.py:214-217`).
- `run_conversation` cancels any review fork sharing the session id, binds the cache-affinity scope, then forwards to `agent/conversation_loop.py` (`agent/turn_facade.py:22-41,134`).
- The loop is synchronous; concurrency uses threads.

**One turn** (`agent/conversation_loop.py:1646-1805`):
1. **Setup:** `build_turn_context` (`agent/turn_context.py:1189`):
   - restores or builds the system prompt (`conversation_loop.py:802-930`);
   - persists the user row;
   - runs `pre_llm_call` hooks (`:903`);
   - prefetches external memory (`:1056-1086`);
   - stamps the `api_content` sidecar (`:1089-1135`);
   - stages the skills-index delta (`:1356`).
2. **Main loop:** `while api_calls < max_iterations and budget.remaining` (`:1751`), each iteration in order:
   - `prepare_iteration` drains `/steer` messages and tracks the budget.
   - `assemble_api_request` (`agent/turn_request_assembly.py:106-286`) builds the wire copy and sanitizes it. It canonicalizes whitespace and tool-call JSON (`:189-194`) and builds the cache plan last (`:203-231`).
   - Preflight compaction gate.
   - Retry loop with fallback and credential rotation (`:1577-1600`).
   - `normalize_model_response`.
   - `run_tool_round`, or `finish_text_response` with stop gates: verify-on-stop, LSP, `pre_verify` (`agent/turn_stop_gates.py:1-10`).
3. **Finalize:** `finalize_turn` persists the turn, syncs memory and spawns the review fork (`agent/turn_finalizer.py:602-615,862-875`).

**Tool dispatch:** agent-level tools use the `INLINE_TOOL_EXECUTORS` table (`agent/inline_tool_executors.py:291-342`). Everything else goes through `model_tools.handle_function_call`.

## 2. Modes

| Mode | Prompt / tools / permissions |
|---|---|
| **Interactive** (cli, tui, desktop, acp) | Automatic "coding posture" in code workspaces adds a brief and a pinned git snapshot (`agent/coding_context.py:1-9,28`). Tools: `hermes-cli`. Approvals: `smart` guardian, then a human (`hermes_cli/config_defaults.py:1660`) |
| **Messaging** | Platform hint plus a "Current Session Context" block as `system_message`, with untrusted-label warnings and PII hashing. Shared chats prefix the sender per message instead of naming a user in the prompt (`gateway/session.py:378-431`). Per-platform toolsets (`toolsets.py:201-221`); `/approve`; busy input = interrupt, queue or steer (`config_defaults.py:814`); 85% hygiene compaction (`gateway/run_turn_hygiene.py:97`) |
| **Webhook** | web, vision, clarify only (`toolsets.py:39`) |
| **API server** | OpenAI-compatible; a host-declared conversation key drives the cache scope |
| **Cron** | Fresh session per fire, `platform="cron"`, SOUL kept, project files only with a `workdir`, no review fork (`cron/scheduler.py:2507-2512`). `cron_mode: deny` (`config_defaults.py:1663`). Pre-run script, `wakeAgent:false` gate, injection scan (`cron/scheduler_prompt.py:21-35,385-393`). Cache scope per job (`agent/transports/codex.py:31-47`) |
| **One-shot** (`-q`, `-z`) | No skill coaching, no clarify, no steer note; at most 2 subagents (`agent/oneshot_footprint.py:1-20`) |

**Other modes:**
- **Codex app-server:** Codex owns the loop and reaches curated Hermes tools over MCP (`agent/transports/codex_app_server.py:1-6`; `hermes_tools_mcp_server.py:1-5`).
- **ACP:** a server for IDEs, with edit modes (`acp_adapter/modes.py:8-16`), and a client that runs vendor agent CLIs as "models" (`agent/acp_client.py:1-12`).
- **Batch runner:** JSONL prompts, sampled toolsets, ShareGPT trajectories (`batch_runner.py:1-6`; `toolset_distributions.py:1-7`).
- **Smaller modes:** kanban workers (`hermes -p <profile> chat -q`), Bot Mode forever chats (`agent/system_prompt.py:350-371`), MoA, `/goal`, `/loop`.
- **Execution backends:** local, docker, ssh, modal, managed_modal, daytona, vercel_sandbox (`agent/terminal_env_registry.py:26-29`), plus plugins.

## 3. Provider abstraction

- **API modes:** chat_completions, codex_responses, anthropic_messages, bedrock_converse, codex_app_server (`agent/agent_init.py:269-272`), plus plugin transports. `ProviderTransport` does convert_messages / convert_tools / build_kwargs / normalize_response (`agent/transports/base.py:1-52`), returning `NormalizedResponse` with protocol state in `provider_data` (`types.py`).
- **Profiles:** declarative `ProviderProfile` (`providers/base.py:1-10`). About 38 live in `plugins/model-providers/`; the last registered wins.
- **Credentials:** API keys, OAuth, credential pools, fallback chains. Claude Code OAuth is reused from the keychain with CC identity headers (`agent/anthropic_credentials.py:40-48`).
- **Tool-call format:** native function calling only.
  - Hermes XML `<tool_call>` / `<think>` appears only in training-trajectory export (`agent/agent_runtime_helpers.py:100-139`) and in ACP text extraction (`agent/acp_openai_bridge.py:20-29,142-150`).
  - No in-loop parser for open models; the managed llama-server runs `--jinja` (`hermes_cli/local_runtime/supervisor.py:190`).
- **Reasoning:**
  - Stored in `assistant_msg["reasoning"]` (`agent/AGENTS.md:48-49`).
  - Replayed per route: Anthropic signed thinking, Codex encrypted items, Gemini `thought_signature` (`agent/reasoning_carriers.py:1-16`).
  - A streaming scrubber covers 9 think-tag names (`agent/think_scrubber.py:17-25`).
- **Usage:** `normalize_usage` maps the Anthropic, Responses and Chat shapes, including DeepSeek `prompt_cache_hit_tokens` and Kimi `cached_tokens` (`agent/usage_pricing.py:615-693`). Cost is profile, then subscription, then pricing table (`:700-730`). Stored per session and per model (`hermes_state_common.py:466-535,569-590`).

## 4. Prompt and session cache handling (most important)

### 4.1 Persist what you send; replay byte-exact

- **System prompt:**
  - Built once and stored in `sessions.system_prompt` (`hermes_state_common.py:483`).
  - Any fresh agent restores it verbatim: gateway eviction, `--resume`, a worker (`conversation_loop.py:802-930`). A failed restore is logged as "prefix cache will miss" (`:734-746`).
  - It is rebuilt only when the Model, Provider, Session ID or cwd lines are stale (`:957-990`).
  - Platform is deliberately not an identity field. A TUI↔Desktop switch sends a note instead of rebuilding.
- **`tools[]`:**
  - The full definitions are pinned in `sessions.tool_names` (`tools/mcp_tool_agent.py:217-232`).
  - A restore keeps pinned bytes and order, drops deregistered tools, and appends new ones at the tail (`:325-350`). The MCP refresh preserves the prefix (`:128-151`).
  - Gateway sessions freeze toolsets in a launch policy (`conversation_loop.py:788`).
- **`api_content` sidecar:**
  - The exact bytes sent for a user turn are stored, including recall and plugin context injected at API time (`messages.api_content`, `hermes_state_common.py:557`; `turn_context.py:1089-1135`; `hermes_state_api_content.py:41-67`).
  - Those bytes are replayed for history (`turn_context.py:1418-1475`).
  - The wire copy also gets whitespace and tool-argument JSON canonicalization for "bit-perfect prefixes" and local KV reuse (`turn_request_assembly.py:189-194`).

### 4.2 Three tiers (`agent/system_prompt.py:744-808`)

- **The tiers:**
  - **Stable:** SOUL, guidance, model-gated blocks, `skills.auto_load` bodies, coding brief.
  - **Context:** caller `system_message`, project files, workspace snapshot, platform hint.
  - **Volatile:** skills index, MEMORY, USER, external-memory block, plugin sections, profile line, timestamp, runtime env.
- **Ordering rationale (code comments):**
  - The skills index leads the volatile tier, so an unchanged index stays in the longest common prefix (`:791-793`).
  - The profile path is volatile, so the stable tier is identical across profiles (`:797-798`).
  - Shared project files precede worktree-specific lines.
- **Stable-tier string:** saved as `_cached_system_prompt_static` (`:810-819`) and reconstructed after a restore (`:843-869`). It carries an early cache breakpoint.
- **Timestamp:** date-only `Conversation started:` taken from the lineage-root session-id stamp. A "Today's date (as of the last context rebuild)" line is added only on rebuild days (`:182-228,501-525`).
- **Frozen inputs:** the git snapshot is probed once and pinned (`:674-703`). Plugin prompt sections render once per session and are recovered from the persisted bytes (`:119-169`), capped at 4,000 chars at one position (`hermes_cli/plugins_dispatch.py:98-100`).

### 4.3 Anthropic `cache_control` (`agent/prompt_caching.py`)

- **Default layout** (`:345-377`), 4 markers:
  - static-tier prefix, plus the full system prompt (the string is split into 2 text parts only in the request, `:178-199`);
  - the last 2 cacheable messages;
  - without a static split: 1 system marker and the last 3 messages;
  - prior decoration is stripped first (`:247-258`).
- **Direct `api.anthropic.com` layout:** static prefix + `tools[-1]` + the last 2 "completed transaction endpoints" (`:276-342`; `agent/agent_runtime_helpers.py:1570-1577`). This lets *different sessions* share the tools and stable-system prefix.
- **Native vs envelope:**
  - Native markers go inside blocks; role:tool markers move into `tool_result`.
  - OpenRouter, Portal and LiteLLM get markers only on content parts, never top-level on tool or empty-assistant messages (OpenRouter hangs).
  - LiteLLM gets no tool-part markers, since that returns 400 (`:23-33,57-114`).
- **Builder-declared scaffolds:**
  - Skill, cron and webhook builders register the stable prefix of their user message (`agent/prompt_cache_boundary.py:1-58`; `cron/scheduler_prompt.py:366-385`; `agent/skill_commands.py:401-415`).
  - The planner sends `[scaffold, tail]` with the marker on the scaffold, and keeps that split shape after the marker window moves on (`:80-99`).
- **TTL:**
  - `5m` by default (`config_defaults.py:688`); the 1h form is `{"ttl":"1h"}` (`:117-119`).
  - Opt-in `auto`: 1h for human-paced sources, 5m for subagent, cron, oneshot, webhook, kanban, api and batch. The code cites a measurement: 63% of interactive writes were cold rewrites after 5–60 min idle, and 1h on machine-paced traffic would cost +49% (`:147-161`).
  - Qwen/Alibaba is clamped to 5m (`:122-175`).
- **No markers on one-shot requests** (no tools, at most one user turn: titles, summaries, MoA synthesis), because the write premium is never read back (`:35-47`; `agent/auxiliary_client.py:3848-3852`).
- **Route policy** (`agent_runtime_helpers.py:1739-1850`): native Anthropic; Claude and Kimi via OpenRouter or Portal; Anthropic-wire Claude gateways; LiteLLM Claude; MiniMax M2 (M3 caches automatically); Qwen on OpenCode or DashScope; a per-custom-provider `prompt_caching` flag.
- **Failover:** markers are stripped and re-planned for the new route (`conversation_loop.py:1290-1339`).
- **Bedrock:** `cachePoint` allowlist plus server-verdict suppression (`agent/bedrock_adapter.py:530-590`).

### 4.4 Keyed caches and affinity

- **Key format:** `prompt_cache_key = pck_<sha256(scope ‖ static system ‖ name-sorted tools)[:24]>` (`agent/transports/codex.py:428-449`). Chat Completions uses the same key (`chat_completions.py:62-117`), automatically for `api.openai.com` (`:648`).
- **Scope** (`agent/prompt_cache_scope.py`):
  - A host-declared key becomes `gwk_` + hash(source, key, generation) (`:109-163`). The generation counter is never garbage-collected, so `/new` gets a fresh bucket even after pruning (`hermes_state_common.py:666-689`).
  - Otherwise the scope is the compression-lineage root (`:166-192`).
  - Cron maps to `cron_<job>` (`codex.py:31-47`).
- **xAI:** `x-grok-conv-id` header plus body key. xAI caches are slot-keyed, so a fork appends `::review` only after its own compaction (`prompt_cache_scope.py:203-238`).
- **Other headers:** Codex `x-client-request-id` (`codex.py:869`); custom `session_affinity_header` and `x-opencode-session` (`agent/opencode_affinity.py:8-22`).
- **Retention:** 24h `prompt_cache_retention` for Meta and Bedrock Mantle (`codex.py:357-375`).

### 4.5 Gemini, DeepSeek, local

- **Gemini:** implicit caching only. `cachedContents` is absent; `cachedContentTokenCount` is read (`agent/gemini_native_adapter.py:631`).
- **DeepSeek:** automatic caching. `prompt_cache_hit_tokens` is read (`chat_completions.py:791-798`).
- **llama.cpp:**
  - The managed router relies on server prompt caching and byte-stable prefixes (`supervisor.py:173-191`).
  - `return_progress` keeps long prefills from tripping stall timers (`agent/local_prompt_progress.py:1-30`).
- **Ollama:** `num_ctx` is detected via `/api/show`, capped by `context_length`, sent per request in `options`, and the compressor is clamped to it (`agent/agent_init_ollama.py:9-65`; `plugins/model-providers/custom/__init__.py:57-62`).
- **Absent:** `keep_alive`, and `id_slot` / `cache_prompt` / `n_keep` slot pinning.

### 4.6 Volatile content placement

| Content | Treatment |
|---|---|
| Dates | Birth date only. The gateway renders per-message timestamps into the user text |
| MEMORY / USER | Snapshot frozen at load (`tools/memory_tool_store.py:224-256,649-652`), 2,200 / 1,375 chars (`agent/agent_init.py:1196-1199`). Writes go to disk only |
| External memory (Honcho…) | Static `system_prompt_block()`. `prefetch()` recall is fenced and appended to the current user message (`turn_context.py:114-136,1056-1086`), then persisted via the sidecar |
| Skills list | Index plus a delta note on the user message, sent only when the difference changes (`agent/skills_index_delta.py:1-15,102-138`) |
| Todo | Tool results only; re-injected after compaction (`tools/todo_tool.py:1-4`) |
| Subdirectory AGENTS.md | Appended to the tool result on first touch (`agent/subdirectory_hints.py:1-26`) |
| Steer and budget notices | A standalone user row, or the newest *unpersisted* tool result (`agent/AGENTS.md:64-68`; `conversation_loop.py:126-158`) |

### 4.7 Mid-session changes

- **Memory write:** waits for the next session or a compaction, which reloads memory (`system_prompt.py:822-840`).
- **New skill:** delivered as a delta note. `/skills install --now` is an explicit break (`hermes_cli/skills_hub.py:131`).
- **Toolsets:** stay pinned. `/reload-mcp` is explicit; Bot Chat capability epochs rebuild once (`conversation_loop.py:822-856`).
- **`hermes sessions refresh-prompts`:** sets an epoch, which rebuilds once (`agent/prompt_refresh.py:1-13`).
- **Model switch:** the stale identity triggers a rebuild, counted as `model_switch` (`hermes_cli/observability/shared_metrics_efficiency.py:347-366`). The docs accept that provider caches are model- and account-scoped.

### 4.8 Compaction

- **The single refresh boundary:** compaction reloads memory, refreshes tool definitions, and always rebuilds the prompt, keeping the old object when the bytes are equal (`agent/conversation_compression.py:3065-3104`).
- **In-place by default:** the session id is kept and old rows are soft-archived (`config_defaults.py:671`).
- **Prepared summaries (opt-in):** built in the background on copies (docs `context-compression-and-caching.md:674-724`).
- **Micro-compaction:** off, because "every pass rewrites the prompt prefix" (`agent/micro_compaction.py:1-5`).
- **Provider-side:** Responses and Codex native compaction keep server state.

### 4.9 Forks share the warm cache

- **Background review and `/btw`** use `build_cache_parity_fork`:
  - same model and credentials, verbatim system prompt, byte-identical `tools[]`, same session id and inherited scope;
  - persistence detached;
  - permissions enforced by a dispatch-side whitelist: "advertising is not permission";
  - about 26% cheaper per the code comment (`agent/background_review.py:965-1063,1116-1156`; `agent/side_question.py:1-8`).
- **Batch subagents:**
  - An optional gate holds siblings until the leader's first chunk (`tools/delegate_tool_prefix_gate.py:1-82`); off by default (`config_defaults.py:1359`).
  - The goal rides the first user turn, so siblings share one system prompt (`tools/delegate_tool_progress.py:187-190`).

### 4.10 Persistence and telemetry

- **Storage:** SQLite `state.db` (WAL, bounded read pool). FTS5 word and trigram indexes over messages, including tool names and args (`hermes_state_common.py:955+`; `hermes_state_fts.py:16-61`). `system_prompts` de-dup table (`:461-464`).
- **Resume, branch, rewind:**
  - `--resume`.
  - `/branch` copies rows up to a boundary into an independent session (`hermes_state_mutation_branch.py:1-40`).
  - `/undo` and `/retry` (`hermes_state_rewind.py:1-5`).
- **Telemetry:**
  - Every call logs `cache=read/prompt (%)` (`agent/turn_usage.py:199-200`).
  - Per-session and per-model cache columns; `/usage`, `/insights`.
  - Opt-in shared metrics (`relay_shared_metrics.py:1365-1383`) classify cache breaks: compression, model_switch, prompt_rebuild, toolset_change, cache_expired, provider_reported_miss (`shared_metrics_contract.py:659-662`).
  - They also detect *unannounced* misses: a cold read after a warm read on the same route within the TTL (`shared_metrics_efficiency.py:213-226`).

## 5. Prompt construction

**Measured size**, from committed renders (`tests/fixtures/prompt_surface/surfaces.json`, produced by `scripts/ci/prompt_surface.py:1-20`; CI fails when stale and posts token deltas on PRs):

| Stock render | Stable | Volatile | Tools |
|---|---|---|---|
| CLI, Claude | 1,225 | 1,268 | 11,242 tokens, 23 tools incl. 3 bridge tools |
| GPT | 2,420 | Not covered | Not covered |

So `tools[]` is about 80% of the fixed prefix.

**Context files** (`agent/prompt_builder.py:1580-1750`):
- Only one type loads. Priority: `.hermes.md` (walk to git root), then the `AGENTS.override.md`/`AGENTS.md` chain from root to cwd, then `CLAUDE.md`, then `.cursorrules` / `.cursor/rules`.
- Cap: the larger of 20k chars and 6% of the window, up to 500k, truncated 70/20 (`:1033-1051`).
- Injection hits are blocked (`:84-111`). SOUL.md is the identity slot (`system_prompt.py:556-562`).

**Skills use progressive disclosure:**
- Category-grouped `name: description` rows, descriptions at most 60 chars, under a strong "MUST load" preamble (`prompt_builder.py:1295-1360`; `agent/skill_utils.py:846`).
- `skill_view(name[, file_path])` loads bodies and references (`tools/skills_tool.py:733-743`).
- `auto_load` pins bodies in the stable tier (`system_prompt.py:323-347`).
- Focus mode shows names only.
- LRU cache keyed on file signatures, plus a disk snapshot (`prompt_builder.py:1077-1130`).

**Model variants:**
- Tool-use enforcement for gpt, codex, gemini, gemma, grok, glm, qwen and deepseek (`:344-362`).
- Google and OpenAI execution guidance; the developer role for gpt-5 (`:659`).
- **No size-based (small vs large) variant.** The nearest are the one-shot footprint and focus posture.

## 6. Context management

**Token accounting:**
- chars/4 (`agent/model_metadata.py:2340`), corrected by a usage anchor: the provider's counts plus a rough delta. The anchor is fingerprinted and persisted.
- Image costs are learned per model and host (docs `:107-170`).

**Triggers:**
- `threshold` 0.50, but windows under 512K are floored to 0.75 (`agent/context_compressor.py:1148-1151`).
- Gateway hygiene at 85%, provider-overflow recovery, and opt-in idle compaction.

**Algorithm (`compress`, `:5422+`):**
1. Prune tool results over 200 chars, with no LLM call (`:837-847`; `context_compressor_window.py:39-47`).
2. Keep the head plus a token-budget tail aligned to tool groups. The lean tail is 2.5% of the window, 10–25K, at most 20% (`:924-933`).
3. One aux-LLM structured summary (Goal / Progress / Decisions / Files / Next / Critical), updated iteratively, plus:
   - an extracted anchor index (SHAs, paths, errors);
   - user messages verbatim, newest first;
   - `session_search` recovery pointers.
   Budget: 20% of the compressed content, 2K–10K tokens (`:825-828`).
4. Assemble with a "REFERENCE ONLY" prefix (`:259-299`), `[SKILL_PRUNED]` reload markers, re-injected todos and tool-pair repair.

**Failure handling:** a 60/300/900 s cooldown persisted to the DB, and a deterministic fallback summary.

**Pluggable:** the `ContextEngine` ABC (`agent/context_engine.py:48-240`).

**Tool output:**
- Terminal is capped at 50 KB / 2,000 lines (`tools/tool_output_limits.py:13-15`).
- A result over 100K (50K for MCP) spills to disk with a preview and the path.
- 200K-char per-turn budget (`tools/budget_config.py:9-21`; `tools/tool_result_storage.py:1-6`).

## 7. Tool system

**Registry:**
- `registry.register(name, toolset, schema, handler, check_fn, requires_env, is_async, max_result_size_chars, dynamic_schema_overrides, override, scope, execution_timeout)` at import (`tools/registry.py:735-775`).
- OpenAI schemas; composable toolsets (`toolsets.py:46-222`).

**Parallel calls:**
- Interactive tools are barriers; a read-only set runs in parallel.
- File tools are admitted by canonical-path overlap: readers share, writers are exclusive (`agent/tool_dispatch_helpers.py:29-50,261-330`).
- Up to 8 workers (`agent/tool_executor.py:136,1930-1946`).

**Progressive disclosure:**
- MCP and plugin tools plus cold built-ins sit behind `tool_search` / `tool_describe` / `tool_call`, with a listing budget of min(5% of context, 4K tokens) (`tools/tool_search.py:1-7`; `config_defaults.py:1973-2007`).
- A/B over 288 runs: schema −56%, tokens −23%/−11%/−7% on large/medium/small models, accuracy flat, but `clarify` use fell (`evals/core_tool_deferral/results/SUMMARY.md:1-25`).

**Approvals and safeguards:**
- Hardline floors and `approvals.deny` globs run before yolo or mode-off (`tools/approval_floors.py:1-30`). The YOLO env var is frozen at import (`tools/approval.py:45-47`).
- Default `smart` mode: pattern-flagged commands go to an aux-LLM guardian (APPROVE / DENY / ESCALATE), with comments stripped (`tools/approval_smart.py:1-31`). cron, `-q` and unattended surfaces default to `deny`.
- Plugin `pre_tool_call` can block or escalate. Shadow-git checkpoints run before mutations (`tools/checkpoint_manager.py:1-11`). MCP results are wrapped as untrusted (`agent/tool_dispatch_helpers.py:572`).

**Code execution via RPC (`execute_code`):** the model writes a Python script whose tool calls RPC back to the host (UDS/TCP locally, polled files remotely), and only stdout returns. Limits: 300 s, 50 calls, 50 KB of stdout with spill (`tools/code_execution_tool.py:1-52`; `code_execution_rpc.py:1-6`). Its iterations are refunded to the budget (`agent/iteration_budget.py:26-28`).

## 8. Plugin and extension system

- **Discovery (later source wins):** bundled `plugins/<name>/`, `~/.hermes/plugins/`, project `.hermes/plugins/` (only with `HERMES_ENABLE_PROJECT_PLUGINS`), and the pip group `hermes_agent.plugins` (`hermes_cli/plugins.py:1-9`; `plugins_discovery.py:29,206-240`). An impostor check rejects user plugins that claim a bundled name from another directory.
- **Single-select kinds** (ABC + orchestrator): memory, context engine, model provider, image/video/web-search/browser/TTS/STT, terminal env, secret source, delegation backend, dashboard auth, platform adapter (`plugins/AGENTS.md:85-93`; `hermes_cli/plugins_context.py:270-874`).
- **Manifest:** `plugin.yaml` v1/v2 with kind, platforms, provides_tools/hooks, topologically ordered `requires_plugins`, consented `python_dependencies`, `config_schema` (drives the Desktop form), capabilities, oauth, locales. Unknown fields are ignored (`website/docs/developer-guide/plugins/index.md:607-660`). Portable Agent Plugins v1 packages (`plugin.json` + `skills/` + `mcp.json`) stay disabled until enabled (`:59-140`).
- **Contributions:**
  - Tools; overriding a built-in needs the operator's `allow_tool_override`.
  - About 40 hooks (`hermes_cli/plugins.py:111-160`).
  - Middleware that rewrites or wraps LLM and tool calls (`middleware.md:30-55`).
  - Commands, frozen prompt sections, `plugin:skill` skills, locales, aux tasks, `ctx.llm`.
  - Shell hooks with Claude-Code-compatible stdin, where exit code 2 blocks (`agent/shell_hooks.py:1-5`).
- **Lifecycle:** `register(ctx)` with a 10 s load deadline and 30 s per hook, fail-open (`config_defaults.py:1699-1705`). Live reload applies tools and prompt sections from the next session.
- **Trust:** full trust in-process by default (SECURITY.md §2.5). Opt-in `plugins.isolation: host` runs non-bundled plugins in a per-profile host process over framed JSON with ABC-typed proxies (`plugins/AGENTS.md:119-149`). A boundary lint enforces `plugin_api.json`.
- **Distribution:**
  - `plugin-catalog/`: about 1,200 SHA-pinned YAML entries, human-merged and validated in CI, plus a `removed.yaml` kill list (`plugins/AGENTS.md:66-83`).
  - `optional-mcps/`: about 67 entries.
  - Skills hub with static scanning and trust tiers (`tools/skills_guard.py:1-30`).
  - Features that leave core (memory providers, Honcho) migrate automatically (`hermes_cli/memory_provider_migration.py:1-36`).

## 9. Learning loop

- **Triggers:**
  - Memory review every 10 user turns; skill review after at least 10 tool iterations without `skill_manage` (`agent/agent_init.py:1160-1162,1194,1236-1238`; `agent/turn_context.py:816-825`; `agent/turn_finalizer.py:862-869`).
  - Each runs as a post-delivery fork, never as text in the user's chat (`turn_finalizer.py:602-615`).
  - Disabled for cron, at about 30K tokens per event (`cron/scheduler.py:2511`).
- **Prompts:** USER-vs-MEMORY routing, a grounding rule, "procedure first, pitfalls as rules", a do-not-capture list (env failures, negative tool claims) (`agent/background_review.py:365-560`).
- **Limits:**
  - Skill-only reviews get no memory tool (`:1122-1126`).
  - Per-review input budget (`:1060`).
  - A live turn cancels the review (`turn_facade.py:39-41`).
- **Memory:** bounded, §-delimited, atomic batches, threat-scanned, at most 3 failures per turn (`tools/memory_tool_store.py:175-256`).
- **Skills:** `skill_manage` with provenance (`tools/skill_manager_tool.py:1-50`). The curator, weekly and after 2h idle, applies stale (14d) and archive (30d) transitions, optionally with an LLM consolidation pass, and never deletes (`agent/curator.py:1-33`).
- **Recall:** `session_search` is FTS5 BM25, lineage-deduped, with cron demoted, and **makes no LLM calls** (`tools/session_search_tool.py:1-33`).

## 10. Subagents

**Spawning and isolation:**
- `delegate_task` builds a child `AIAgent` with a fresh conversation and its own task_id.
- The child gets the parent's toolsets minus delegate_task, clarify, memory, send_message and cronjob_manage; the default is `[terminal, file, web]` (`tools/delegate_tool.py:1-11`; `delegate_tool_toolsets.py:14-23`).
- Its prompt is a focused system prompt plus the workspace context files, with the goal as the first user turn (`delegate_tool_progress.py:180-219`).

**Limits** (`config_defaults.py:1312-1370`):
- Batches of up to 10; depth 1 (orchestrator roles up to `max_spawn_depth`).
- An own budget of 250 iterations and an inactivity timeout.
- Results capped at 24K chars, with spill.

**Background mode:** results return as a new turn (`tools/async_delegation.py:1-8`).

**Model choice:** config (`delegation.model` / `provider` / `base_url`) or a `DelegationProvider` plugin that returns per-task routes (`delegate_tool_routes.py:1-8`; `delegate_tool_config.py:572-605`). The schema exposes only goal, context, images, output_schema and a list/steer/stop action.

**Approvals:** auto-deny.

**Under the gateway:** the owner reserves children and refuses requests over capacity or depth (`agent/runtime_session_child.py:1-18`).

## 11. Performance

- **Startup:** lazy forwarders (`agent/lazy_forward.py:1-5`); lazy provider discovery and `LazyHeaders`, which skip git subprocesses at import (`providers/base.py:42-55`); skills-index disk snapshot; MCP schema cache, so tools register without spawning servers (`tools/mcp_schema_cache.py:1-4`); startup watchdog (`hermes_startup_watchdog.py:1-20`).
- **Runtime:** SQLite WAL with a read pool; streaming with stale-stream breakers; parallel tool batches; background memory prefetch behind stuck-call gates (`agent/memory_manager.py:38-60`); optional prepared compaction.
- **Cost levers:** cache-parity forks, tool deferral, the one-shot footprint, no markers on one-shot requests, TTL by pacing, prompt-surface CI.

## 12. Top 8 ideas worth adopting

1. **Persist what you send.** Store the prompt bytes, a `tools[]` pin and an `api_content` sidecar, and replay them from any process (`conversation_loop.py:802-930`; `mcp_tool_agent.py:217-350`; `turn_context.py:1089-1135`). *Why:* the cache stays warm across restarts, workers and resumes, and recall injection stays cacheable.
2. **Stable / context / volatile tiers, with breakpoints on the stable tier and `tools[]`** (`system_prompt.py:744-808`; `prompt_caching.py:178-199,313-342`). *Why:* the prefix is reused across sessions, profiles and worktrees.
3. **A delta channel instead of prompt mutation.** Skill deltas, surface notes and subdirectory hints ride the user message or tool result (`skills_index_delta.py`; `turn_context.py:160-183`; `subdirectory_hints.py`). *Why:* new capability reaches the model with no cache break.
4. **Cache-parity forks with a dispatch-side whitelist** for learning reviews and `/btw` (`background_review.py:965-1156`). *Why:* about 26% cheaper, and the transcript is never polluted.
5. **A rotation-stable, content-addressed `prompt_cache_key` / affinity scope,** with a never-GC'd generation counter and xAI slot handling (`prompt_cache_scope.py`; `codex.py:428-449`). *Why:* it survives compaction and `/new` without merging forks.
6. **Compaction as the one refresh boundary,** plus lean summaries with anchors, verbatim user messages, recovery pointers and `SKILL_PRUNED` (`conversation_compression.py:3065-3104`; `context_compressor.py:924-933`). *Why:* one predictable break that also carries config and memory updates.
7. **Progressive tool disclosure plus prompt-surface CI** (`tools/tool_search.py`; `scripts/ci/prompt_surface.py`). *Why:* 56% smaller schemas, and every token of drift is reviewable on the PR.
8. **Cache economics:** TTL by pacing, no markers on one-shot calls, a leader-first gate for subagent batches, break-cause telemetry including `provider_reported_miss` (`prompt_caching.py:35-47,147-161`; `delegate_tool_prefix_gate.py`; `shared_metrics_efficiency.py:213-226`). *Why:* avoids paying for cache writes nobody reads and for cold fan-outs.

Runners-up: `execute_code` RPC tool calling; path-overlap parallelism; approval floors before yolo; verify-on-stop; Claude-Code-compatible shell hooks.

## 13. Weaknesses, gaps and drift

### Weaknesses

- **Extreme complexity:** hundreds of sibling modules, issue-number-driven edge cases, many lease and recovery layers, and docs that drift.
- **Synchronous, thread-based loop,** with many daemon threads (forks, prefetch, prepared compaction, tool pool).
- **chars/4 estimates between provider anchors.** After a rewind or model switch, the first request may be rejected for size.
- **About 11K tokens of tools ahead of the system prompt.** Any tool change breaks everything, and pinning keeps config changes away from long sessions until compaction.
- **Tiny frozen memory** that is invisible after a mid-session write, and **no vector recall in core.**
- **Missing cache features:** no Gemini `cachedContents`, Ollama `keep_alive` or llama.cpp slot pinning, and nothing handles Anthropic's 20-block lookback (searched; none).
- **Plugins default to full trust in-process.** Agent Plugins v1 has no trust model (plugins guide `index.md:122-125`).

### Doc/code drift

1. **Anthropic layout:** the docs say "system_and_3" (`context-compression-and-caching.md:791-801`). The code uses static + system + last 2, or tools + static + 2 endpoints (`prompt_caching.py:3-5,313-377`).
2. **Skills index tier:** "stable" per `prompt-assembly.md:33-41`; volatile in code and in the fixture (`system_prompt.py:791-793`).
3. **Honcho:** "built-in" per `README.md:26` and `prompt-assembly.md:92`; a catalog plugin in code (`plugins/AGENTS.md:19-30`).
4. **Session search:** "LLM summarization" per `README.md:26` and `toolsets.py:127`; "No LLM calls" in code (`session_search_tool.py:8`).
5. **Iteration budget:** "500 shared with subagents" (`agent/AGENTS.md:15`), but each agent has its own budget (`iteration_budget.py:1-5`). That docstring says 50; the config default is 250 (`config_defaults.py:1345`).
6. **Cron memory:** `skip_memory=True` per `agent/AGENTS.md:127`; `skip_memory=False` in code (`cron/scheduler.py:2510`), with providers in a no-write cron context.
7. **Summary ceiling:** 12K tokens in the docs (`context-compression-and-caching.md:650`), 10K in code (`context_compressor.py:828`).
8. **CLI process model:** in-process per `architecture.md:147`; through the gateway in code (`gateway_chat.py:1`).
9. **`pre_llm_call` injections:** "nothing is persisted" per the plugin guide (`plugins/index.md:1613`); persisted as `api_content` in code (`hermes_state_messages.py:403-408`).
10. **Compaction threshold:** "50%" in the docs, effectively 75% for windows under 512K (`context_compressor.py:1150-1151`).
