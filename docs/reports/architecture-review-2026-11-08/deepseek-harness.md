# DeepSeek Harness (`dsh`): code-level architecture study

Checkout: `deepseek-ai_deepseek-harness` at `fcc0ad46` (v0.2.2-rc.1, a "developer preview" with breaking changes announced in README.md). All paths below are relative to the repo root. I only read the code; I ran nothing from the checkout. The `pi-ai` dependency was not installed in the checkout (no `node_modules`), so I could not check how it behaves inside. Those points are marked **[pi-ai, unverified]**.

## 0. Summary

dsh is a Cordis plugin tree in which every part can be replaced, including the agent loop. Its main engineering idea is that **every model request is a pure function of an append-only session log** (`.agents/notes/implemented/architecture/2026-07-05-reconstructable-requests.md`). Prefix-cache stability follows from that, and they do not manage it by hand:
- The system prompt is a static, deterministically ordered "surface node 0".
- Volatile facts go into a *user-role runtime-context snapshot*. A new snapshot is appended only when its content changes.
- On routes that declare support, prompt and tool changes are appended *in history* rather than rewriting the prefix.
- Compaction replays the warm prefix.

The native DeepSeek route gets all of this. Every other provider is delegated to `@earendil-works/pi-ai`.

## 1. Architecture and turn flow

**Main packages** (`packages/<group>/<pkg>`, about 250 workspaces; `AGENTS.md` layout):

| Package | Role |
|---|---|
| `core/agent-loop` | The driver |
| `core/agent` | `ctx.agents` registry |
| `core/session` | Log, surface and derived messages |
| `core/system-prompt` | Prompt sections, contexts, tool schemas |
| `core/tools` | Registry and pipeline |
| `core/scope` | Per-agent scoping |
| `llm/llm` | Adapter seam |
| `llm/llm-deepseek*` | Native adapter |
| `llm/llm-pi-ai` | Multi-provider adapter |
| `llm/token-meter` | Token measurement |
| `compaction/*` | Context compaction |
| `subagent/*` | Delegated agents |
| `bundle/*` | Profiles |
| `boot/*` | Boot, plugin-manager, HMR |
| `client/*` | About 70 browser-side Cordis plugins |

The framework is vendored: Cordis 4.0.0-rc.11 carrying 27 logged local modifications (`vendor/README.md`).

**Process model.**
- One Node (24.9 or later) process hosts the whole Cordis tree, and many sessions and agents run concurrently inside it.
- The CLI (`apps/cli/src/bin.ts:31-73`) imports each mode lazily: profile, plugin, dump-config.
- The Web UI is a second Cordis environment in the browser, connected through Typert RPC (`packages/api/gateway`).
- Desktop is Electron plus a "Desktop Host" running the same profile runner (`docs/architecture.md:49-53`).
- These run as child processes: sandboxed shell commands, PTC programs (`ptc-runtime-node`, a fresh Node process per call by default), MCP stdio servers, and out-of-process subagents (ACP, dsh-sdk, `codex app-server`, Claude Agent SDK).

**How Cordis is used ("everything is a plugin").**
- **Services and injection.** Services are `Service` subclasses with a `static inject` list. For example, `AgentLoop` injects `agents, sessions, llm, tools, systemPrompt, sessionProjections` (`packages/core/agent-loop/src/index.ts:290-291`).
- **Async init.** Startup work goes in `[Service.init]` (`:328`).
- **Registrations are effects.** Every registration is a `ctx.effect()` or `ctx.on()` call that returns a disposer. For example, `ctx.agents.setFactory(this)` at `:335`, so the loop itself is a swappable factory.
- **Deferred children.** `ctx.inject([...], cb)` waits for an optional service before running (`:358`).
- **Per-agent scope.** `createScope(loopCtx, agent)` mints `agent.ctx`, tagged with an identity key (`packages/core/agent-loop/src/agent.ts:147`; `packages/core/scope/src/index.ts:137-147`). Registries keep layered per-scope entries that shadow global ones (`ScopedLayers`, `packages/core/system-prompt/src/index.ts:445-448`).
- **Scoped events.** Events are dispatched through `scopeTarget()`, so scoped listeners only see their own agent or its descendants (`scope/src/index.ts:170-185`).
- **Isolated service instances.** Loader `isolate:` realms give a group its own service instances, for example per-preset `planMode` or `compaction` (`vendor/loader/src/config/isolate.ts`; `packages/bundle/web-app/presets/cordis.patch.yml`).
- **Event dispatch modes.** Events use five modes: emit, waterfall, parallel, serial, bail (`docs/cordis-primer.md`). About 99 harness events are catalogued in `docs/event-producer-consumer.md`.

**One turn, as I verified it in `agent.ts`:**

1. **Wake.** `followup` / `steer` / `inject` put input into the next turn or next step, with or without waking the driver (`:170-189`). `kick()` then loops over `turn()` (`:268-281`).
2. **Open the turn.** `turn()` appends `turn/start` (`:336`). Each step calls `preStep()`, which:
   - claims inbox input (`:287`);
   - snapshots the model selection (`:288`);
   - resolves the step's tool set with per-step `when()` conditions (`:292`);
   - runs `ctx.systemPrompt.assemble()` (`:294`);
   - runs the `agent/pre-step` waterfall, whose fallback appends the runtime-context snapshot (`:296-306`).
3. **Step.** `step()` does the following (`:435-610`):
   - **Prepare the call.** `prepareRequest()` runs the `agent/request` waterfall. It *refuses* any provider, model or effort change at this point (`:635-640`), then calls `ctx.llm.prepareCall()` to bind the adapter (`:644`).
   - **Refresh runtime facts** (`:446-450`).
   - **Project the system prompt** (`:453-461`).
   - **Admit user messages** as `user/message` (`:463-477`).
   - **Build the request.** `buildRequest()` logs `request/header` and `request/context`, logs tool add/remove as a `developer/message`, deep-freezes the derived history and marks the request (`:656-744`).
   - **Stream.** It streams through `llm/stream` and commits either `assistant/message` (with its embedded chunk stream and usage) or `assistant/attempt`.
   - **Errors.** `agent/request-error` may return `retry` (`:548-563`). Retries never repeat assembly or pre-step.
   - **Tools.** It runs `ctx.tools.execute()` with `maxParallelToolCalls`, default 10 (`:586-597`; `constants.ts:6`).
4. **Close.** Failed steps record synthetic tool results (`:375-385`). `agent/turn-stopping` (serial) can keep the turn open (`:395-399`).

The architecture doc's sequence (`docs/architecture.md:85-106`) matches this code.

## 2. Modes

| Mode | How it differs |
|---|---|
| `web` (default, `npx @deepseek-ai/dsh web`) | `dsh-base` plus the web-app bundle. The agent plane sits behind per-session **agent presets** (minimal / standard / cordis "Creator" / ptc in `packages/bundle/web-app/presets/*`). Persona: "You are a coding agent powered by the {{model}} model." (`standard.patch.yml:11-14`). |
| `headless` (`dsh headless "task"`) | One-shot, no server. HMR, credential store and account are disabled. Permission and approval come from CLI flags. Optional `--json` stream (`packages/bundle/headless/cordis.patch.yml:9-46`). |
| `sdk` / `sdk-minimal` | Stdio JSON-RPC server for the TS and Python SDKs. `sdk-minimal` skips `dsh-base` (`docs/architecture.md:23`). |
| `acp` | Agent Client Protocol stdio server (`packages/acp/acp`). |
| desktop | Electron with a reserved `desktop` profile. |
| TUI | **Absent.** It was removed, so only profile templates `acp, web, headless, sdk, sdk-minimal` exist (`packages/util/official-bundles/src/bundles.ts:10-26`). |
| Plan mode | Adds the `plan:policy` prompt section when active (`packages/plan/plan-mode/src/index.ts:197-204`) and narrates entering or leaving it. **Tools are intentionally unchanged "for request-cache stability"** (`packages/bundle/base/cordis.patch.yml:344`). It is guidance only, with no enforcement (plan-mode README "Known Limitations"). |
| PTC | Only `run_code` is callable. All other tools are rendered as a typed SDK *inside the system prompt* (`packages/core/tool-executor-ptc/src/index.ts:16-48`): about 32 KB of prompt in that revision (`snapshots/session/advanced-toolchain/system-prompt.expected.md:38-625`). |
| Minimal preset | `complete: true` persona plus `includeRuntimeContext: false`, which suppresses all other sections and the optional contexts (`presets/minimal.patch.yml:11-16`). This is the closest thing to a "small model" variant. |
| Goal / team / workflow / ralph | Autonomous goal rounds (`goal-round-driver`, each round declares a new request series, `src/index.ts:451`), a shared task board, JS orchestration scripts, and fresh-agent iteration. |

Permissions come from presets: `read-only`, `workspace-write`, or `danger-full-access`, combined with approval `ask` or `never` (`base/cordis.patch.yml:240-276`). The default is workspace-write plus ask.

## 3. Provider abstraction

- **Seam.** `LlmAdapter` requires only `stream()`. Adapters may also implement `prepareCall()`, which binds the model metadata and the stream to one adapter "generation" so a settings change cannot split them (`packages/llm/llm/src/index.ts:208-303`). `PreparedLlmCall` carries the capabilities `systemPromptUpdate` and `toolUpdate` plus `contextWindow` (`:168-192`).
- **Vocabulary** (`packages/llm/llm/src/types.ts`).
  - Content blocks: `text`, `reasoning`, `image`, `file`, `tool-call`, and the tool-change blocks `tool-addition` / `tool-removal` (`:68-157`).
  - Stream chunks: `block-start`, `*-delta`, `block-end`, `usage`, and `finish` with an opaque `ReplayEnvelope` (`:467-508`).
  - **Usage counts are disjoint:** `inputTokens` is uncached input only (`:174-196`).
- **Request projection** (`LlmRuntime.adapterStream`, `index.ts:1068-1157`). Files always become handle text. Images become text for text-only models. `projectToolUpdates()` chooses deferred or full tool declarations per route (`content.ts:439-510`). Replay state is stripped when the historical adapter differs from the target (`index.ts:1027-1041`).
- **Native DeepSeek** (`packages/llm/llm-deepseek`) speaks **Anthropic Messages** to DeepSeek:
  - `POST {base}/v1/messages` with `anthropic-version` and the betas `files-api-2025-04-14` and `mid-conversation-tool-changes-2026-07-01` (`src/adapter.ts:136-152`; `src/messages-api.ts:4-7`).
  - Thinking: `thinking:{type}` plus `output_config.effort` (off/low/high/max, default high) (`src/serialize.ts:147-156`).
  - Tools: `defer_loading` (`:160-167`).
  - Images go through the Files API with inline fallback (`file-store.ts`).
  - SSE translation enforces strict block, stop-reason and tool-JSON validation (`translate.ts:104-166`).
  - Extra headers: an anonymous user id, `x-deepseek-harness-session-id`, and `x-deepseek-harness-compact: 1` on compaction calls (`adapter.ts:148-152`).
- **Reasoning round-trip.** Every historical `reasoning` block is re-sent as a `thinking` block (`serialize.ts:26-39`). The signature is attached only when the replay envelope's model equals the target model (`replay.ts:39-63`). DeepSeek's *OpenAI-style* `reasoning_content` rules are not in dsh code: "The provider's own reasoning-content exclusion is managed server-side" (reconstructable-requests note, Consequences). Never stripping old reasoning keeps every request an append-extension of the previous one. For DeepSeek via pi-ai's chat-completions route, pi-ai owns `reasoning_content` (there is a compat switch, `requiresReasoningContentOnAssistantMessages`, `llm-pi-ai/src/catalog.ts:415-416`) **[pi-ai, unverified]**.
- **Other providers: `llm-pi-ai`.** Supported protocols: anthropic-messages, openai-completions, openai-responses, azure, codex-responses, bedrock, mistral (`catalog.ts:338-346`). It also supports custom OpenAI-compatible routes, with gates for many compat switches (`catalog.ts:389-461`).
  - Each operation builds an immutable snapshot (`adapter.ts:293-302`).
  - pi-ai's own retries are disabled; the harness retries (`:155`).
  - A local patch (`patches/@earendil-works__pi-ai@1.3.0.patch`) removes per-delta `parseStreamingJson`, which was O(n²) over tool arguments, and adds Gemini `thought_signature` round-trip on OpenAI-compatible endpoints.
- **Usage and cost.** Adapters map provider usage, for example `cache_read_input_tokens` to `cacheReadTokens` (`translate.ts:34-43`). There is **no money cost accounting**: pi-ai cost is zeroed, "no consumer reports spend" (`catalog.ts:33-38`).

## 4. Prompt and session cache handling (most important)

**4.1 Prefix layout.**
- The request is `system` (surface node 0), then tools, then derived history.
- Sections are sorted by numeric order, then by name using code-unit comparison so the order is identical on every machine (`system-prompt/src/index.ts:136-172, 248-256`).
- Tools are sorted lexicographically unless a `toolOrder` is configured (`:232-246`).
- Tool parameters are `structuredClone`d per assembly (`:648-653`).
- The escalation enum (`sandbox_permissions`) is the same in every session and is checked only at execution, because schemas are registry-global (`packages/sandbox/sandbox/src/escalation.ts:22-42`).

**4.2 Volatile content stays out of the prefix.** `systemPrompt.context()` registers dynamic facts. They render into one user message: "Current runtime context. This snapshot supersedes earlier…" (`:320-324`). That message is appended only when its text differs from the retained one, and a `CLEARED` marker is appended when it becomes empty (`agent-loop/src/runtime-context.ts:20, 119-169`). The comment at `system-prompt/src/index.ts:182` says it directly: "Process-specific paths and endpoints stay out of the cached system prompt." Contexts registered this way:

- **Working directory:** a required context (`session/working-directory/src/index.ts:90-96`).
- **Sandbox policy** (`sandbox-policy/src/index.ts:175-184`) and **approval policy** (`user-approval/src/index.ts:190`).
- **Subagent delegation note** (`subagent/src/child-agent.ts:206-210`).

Other volatile inputs are durable *user* messages admitted in pre-step, never part of the system prompt:

- **AGENTS.md / CLAUDE.md** (`context/agent-instructions/src/index.ts:1-10`; `config.ts:12`). Nested files that fs tools touch are appended incrementally.
- **Skills catalog**: names and descriptions only, loaded by the `skill` tool. A change appends a replacement catalog (`skill/tool-skill/src/index.ts:86, 275-298`).
- **Clock**: `time-context`, at most every 10 minutes (`time-context/src/index.ts:52-57`).

Todo lists are never re-injected; the model sees them only in its own tool results. Built-in memory is absent; there are only MCP examples (`apps/cli/config/examples/mcp-memory/*`).

**4.3 System prompt changes.** `SystemPromptProjection.project()` (`runtime-context.ts:68-116`):
- On routes declaring `systemPromptUpdate:'in-history'` (`types.ts:434-440`), a changed prompt is **appended** as a later `system/message`. The DeepSeek serializer emits it as `role:'system'` after the preceding user turn (`serialize.ts:83-89, 106-116`).
- Otherwise node 0 is replaced, which costs a cache miss. pi-ai models without native support turn later system text into a `<system-reminder>` user message (`llm-pi-ai/src/context.ts:222-236`).
- A fixed bug shows the stakes. A series start used to rewrite node 0 with identical text, which dropped one real step to **0.16% cache hit (722k uncached tokens) against about 99.9% on neighbouring steps**. Now nothing is rewritten when the latest surviving node already matches (`.agents/notes/implemented/bug-fix/2026-10-22-series-start-unchanged-prompt-prefix.md`; `runtime-context.ts:99-107`).

**4.4 Tool-list changes.**
- The loop diffs tool names against the previous header and logs a `developer/message` containing `tool-addition` / `tool-removal` blocks (`agent.ts:692-706`).
- `projectToolUpdates` chooses the wire form per route (`content.ts:439-510`):
  - `in-history`: deferred declarations plus addition and removal blocks.
  - `addition-only`: additions only; any removal rebuilds the baseline.
  - unsupported: the full current list, and a new series begins (`agent.ts:457`).
- The default `deepseek-flash` route is `addition-only` with in-history prompt updates. **`deepseek-v4-pro` declares neither** (`llm-deepseek/src/models.ts:8-23`), unless the server's `/models` listing advertises them (`listing.ts:172-195`).
- pi-ai maps compat flags to `in-history` for Anthropic and `addition-only` for Chat/Responses (`llm-pi-ai/src/models.ts:75-91`). It adds a placeholder tool when every Anthropic tool is deferred (`adapter.ts:71-75, 415-421`).
- Tool-change handling is checked by a real-API test (`apps/cli/tests/profiles/sdk/dynamic-tool-cache.e2e.ts`).

**4.5 By provider.**

| Provider | What dsh does |
|---|---|
| **DeepSeek** | Automatic prefix (disk) cache. dsh only guarantees a byte-stable prefix and maps `cache_read_input_tokens` and `cache_creation_input_tokens` (`translate.ts:36`). `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` are **not read anywhere in code**. A real-API test asserts `cacheReadTokens > 0` on every request after the first, noting 64-token block granularity (`core/agent-loop/tests/request-cache.e2e.ts:16-27, 97-99`). |
| **Anthropic** | dsh writes **no `cache_control` itself**. Breakpoints and TTL come from pi-ai, driven by profile `cacheRetention: none\|short\|long` (`llm-pi-ai/src/config.ts:170-171, 369`; `adapter.ts:150`) and compat switches `supportsCacheControlOnTools` and `supportsLongCacheRetention` (`catalog.ts:446-452`) **[pi-ai, unverified]**. |
| **OpenAI** | `sessionId` is passed to `streamSimple` (`adapter.ts:464`), which pi-ai presumably maps to `prompt_cache_key`. Retention is handled the same way **[pi-ai, unverified]**. |
| **Gemini** | Implicit caching only benefits from the stable prefix; explicit `cachedContents` is **absent**. |
| **OpenRouter / LiteLLM** | A custom `openai-completions` route with `cacheControlFormat: 'anthropic'` (`catalog.ts:142-151, 442-443`) and `thinkingFormat: openrouter`. |
| **Local** (vLLM, llama.cpp, Ollama) | Only through OpenAI-compatible routes with `vllmPriority`, `chatTemplateKwargs` and `thinkingTokenBudgetField`. `keep_alive`, `num_ctx`, `cache_prompt` and `id_slot` are **absent** (grep finds nothing). |

**4.6 Compaction, model switching and cache.**
- The summarizer **replays the warm prefix verbatim** (system, tools including the tool history, and the shadowed messages) and appends the instruction as the *final user message*. Tools are kept even though they are never called, "for prefix-cache alignment" (`compaction/compaction-basic/src/summarizer.ts:25-31, 79-84, 145-162`).
- Pruning tool results without a model call is deferred until pressure qualifies, so history rewrites happen together (`compaction-basic/src/index.ts:344-349`).
- Image offload happens in quanta, "Larger steps rewrite the request prefix less often" (`llm-pi-ai/src/config.ts:193-198`; DeepSeek uses 20 images).
- A model switch compacts against the *new* model's window (`index.ts:181-203`). It also strips foreign replay state and drops cross-model thinking signatures (sections 3 and 4.3).
- The persona's `{{model}}` variable means a model switch also changes the prompt (`standard.patch.yml:14`). The cache is lost on a model switch anyway.

**4.7 Persistence, resume and fork.**
- **Storage.** One directory per session holding `session.vN.jsonl[.zstd]` (checksummed zstd frames). The format is `SESSION_FORMAT_VERSION = 4` (`core/session/src/types.ts:90`). Migrations are adjacent and never overwrite an earlier generation (`docs/architecture.md:128`).
- **Resume.** It takes a write lease, cold-reads the log and appends synthetic closers for an interrupted turn (`agent-loop/src/index.ts:785-801`). It then logs `request/header` with reason `resume`. An unchanged envelope continues the series (`docs/architecture.md:114`).
- **Fork.** `buildForkSeed()` copies a prefix, adds `session/end-seed` and closes the open tail (`core/session/src/fork.ts:21-30`).
- **Checkpoint.** `session-checkpoint-policy` flushes the log before every model request and is fail-closed (`src/index.ts:29-37`).

**4.8 Cache telemetry.**
- Per-attempt usage is stored on `assistant/message`.
- `token-meter` keeps a session `tokenUsage` projection (uncached, cacheRead, cacheWrite) and computes exact per-turn usage (`llm/token-meter/src/turn-usage.ts:12-27`).
- The Web UI shows cache hit % per session and per turn (`client/ui-chat/src/client/chat/StatsPills.tsx:108-119`; `TurnUsagePanel.tsx:34-36`). Headless `--json` sums `cacheReadTokens` (`bundle/headless/src/json-stream.ts:213-221`).
- `request/header` reasons (`initial` / `resume` / `change` / `series`) make cache drops explainable: "a header change or compaction appears as a cache-read drop on the next step" (reconstructable-requests note).

## 5. Prompt construction

- **Sections.** Centrally ordered (`system-prompt/src/index.ts:136-172`): harness identity ("You are an AI agent powered by DeepSeek Harness.", `:455-461`), persona prefix, plan/team policy, one terse per-tool rule section (for example `tool:bash`, `shell/tool-bash/src/index.ts:250-255`), MCP server instructions, then persona suffix.
- **Variables.** Strict `{{var}}` interpolation; unknown names throw (`:346-383`).
- **Complete sections.** A `complete:true` section replaces the whole prompt (`:659-694`).
- **Size.**
  - Native headless prompt: about **3.7 KB, roughly 1k tokens** (`snapshots/session/advanced-toolchain/system-prompt.expected.md:1-35`).
  - 28 tool schemas: about **24 KB JSON, roughly 6k tokens** (the same scenario's `tool-schemas.expected.json`; the largest are `workflow` at 3.5 KB and `bash` at 2.3 KB).
  - PTC moves the tools into a prompt of about 32 KB.
- **Context files.** AGENTS.md and CLAUDE.md are read from `$DSH_HOME`, `~/.agents` and the project root down to the cwd, with a 64 KiB cap per chain (`base/cordis.patch.yml:307-310`).
- **Skills.** Progressive disclosure, as in 4.2.
- **Tool descriptions.** Cross-call guidance goes in prompt sections, "not one-call schema prose" (`tool-bash/src/index.ts:250`).
- **Model-size-specific prompt or tool variants.** None exist beyond selecting a preset.

## 6. Context management

- **Token counting.** A heuristic of 4 characters per token plus per-block overhead (`llm/token-meter/src/estimate.ts:13-60`). It is **anchored to provider-reported usage** when the request envelope matches, so only the delta since the last request is estimated (token-meter README). The README admits that CJK text and JSON underprice.
- **Triggers** (`compaction-basic/src/index.ts`):
  - pre-step pressure (`:157-175`);
  - model switch (`:183-203`);
  - provider `CONTEXT_WINDOW_EXCEEDED` followed by retry (`:213-257`).
- **Threshold.** `min(0.8 × window, window − maxTokens − 65,536 headroom)`; the most recent 16% is kept verbatim (`config.ts:19-23, 75, 153-200`).
- **Range.** From node 1 (the system prompt is never compacted) up to a tool-pairing-balanced cut (`region.ts:107-147`).
- **Algorithm.** The range is replaced with a `<compacted-summary>` checkpoint that uses fixed headings and merges any prior checkpoint (`summarizer.ts:32-71`).
- **Truncation and spill.**
  - `spill-policy` caps each tool result at 12,500 estimated tokens, keeping head and tail plus a locator to the full spilled file (`spill/spill-policy/src/index.ts:49-140`; `base/cordis.patch.yml:422-425`).
  - Pruning keeps head 4,096 and tail 1,024 characters of results over 8,192 characters, under pressure only (`compaction-tool-result-pruner/src/config.ts:7-14`).
  - Images are offloaded on `IMAGE_OFFLOAD_REQUIRED`.

## 7. Tool system

- **Definition.** `defineTool({name, description, parameters, output:{schema, render}, execute})` (`docs/cookbook/adding-a-tool.md`). Contract in `core/tools/src/contracts.ts:26-102`:
  - an **output schema is required** and is validated;
  - `timeoutMs` is never sent to the model;
  - `isConcurrencySafe(args)` is opt-in;
  - `presentCall` / `presentResult` produce replay-safe UI.
- **Activation.** A per-step `when()` decides whether a tool is active (`:114-124`).
- **Parallel calls.** Exclusive calls act as barriers. Safe calls run in a rolling pool of up to 10. Results and policy are committed in model order, and aborted calls get synthetic results (`core/tools/src/batch.ts:1-96`). Safe tools include read, read_image, web_*, and subagent.
- **Pipeline.** `tools/pre-execute`, then monotonic guards, then `ctx.approval`, then `tools/execute` (the timeout and retry wrapper), then `projectContent`, then `tools/post-execute` (accept, block, replace, or add context), then `finalizeContent`, then `tools/result` (`docs/tool-execution-pipeline.md`).
- **Approvals.** Codex-style: the call carries `sandbox_permissions` and a `justification`, and the user grants one-shot approval. Absent or failed answerers deny (`user-approval/src/index.ts:62-71`).
- **Sandbox.** bwrap or Landlock on Linux, Seatbelt on macOS, ACL/AppContainer on Windows. It fails closed with `SANDBOX_UNAVAILABLE` and reports `full` or `partial` enforcement (`sandbox/sandbox-local/README.md`).
- **Other tools.** MCP tools are named `mcp__server__tool`. PTC SDK sub-calls also go through the same pipeline.

## 8. Plugin and extension system

- **Packaging.** A plugin is an npm package exporting `name`, `inject` and `apply(ctx, config)`, or a `Service` class with `static Config`.
- **Bundles and profiles.** A **bundle** declares `package.json` → `"dsh": {"bundle": {"patch": "./cordis.patch.yml"}}`. Its YAML inserts rows (`id`, `name`, `config`, `disabled` with `!!js` expressions, `inject`, `group`, `isolate`) (`packages/experimental/ralph-bundle/*`). A **profile** in `$DSH_HOME/profiles/<name>` lists bundles in order and holds its own `cordis.patch.yml` and lockfile.
- **Layering.** bundles, then the profile patch, then the home patch, then `--patch`. A patch replaces a row by id (`docs/architecture.md:13-39`). `dsh --profile web --dump-config` prints the result.
- **Discovery.** Installation is `dsh plugin --profile p add <pkg>` (pnpm inside the profile directory) or the Web Plugins page / agent `plugin_manager` tool, which requires approval or full access.
- **Distribution.** The `dsh-plugin` GitHub topic is only a README convention (`README.md`). Discover reads user-configured market `index.json` URLs, defaulting to an empty list (`boot/plugin-market/src/index.ts:112`), produced by `apps/plugin-market-generator`. Install falls back across registries (npmmirror by default) and needs approval before dependency build scripts run (plugin-manager README).
- **Compatibility.** Checked through `engines.dsh`, otherwise `@deepseek-ai/dsh-*` peer dependencies, *before* pnpm runs. Exact-version exemptions are possible (`boot/app-boot/src/plugin-compatibility.ts:55-102`).
- **Hot reload.** HMR reloads config by default; module roots are opt-in (`base/cordis.patch.yml:27-32`). Effects unwind and registrations come back. A tool change then becomes an in-history `developer/message`, not a cache bust, on capable routes.
- **What plugins can contribute:** tools, LLM adapters (`ctx.llm.registerAdapter`), prompt sections, contexts and variables, executors, compaction engines, commands, sandbox/fs/shell/subprocess backends, subagent providers, persistence backends, session events and projections, Web client UI nodes, and settings cards (`docs/architecture.md:144-169`).
- **Hooks.** Hook points are waterfall events: `agent/pre-step`, `agent/request`, `agent/request-error`, `llm/stream`, `system-prompt/assemble`, `tools/pre|post-execute`, `tools/execute`, and `fs/*-intent`. Experimental bridges run Claude Code and Codex `hooks.json` files and Claude Code mods.
- **Trust model:** none. "installed Host code executes in-process outside the workspace sandbox" (plugin-manager README).

Minimal real plugin (`packages/guard/timeout-policy/src/index.ts:28-81`, condensed):

```ts
export const name = 'timeout-policy'
export const inject = ['tools']
export function apply(ctx: Context): void {
  ctx.on('tools/execute', async (exec, next) => {          // waterfall: must call next()
    const timeoutMs = ctx.tools.get(exec.name, exec.agent)?.timeoutMs
    if (timeoutMs === undefined) return next()
    using d = deadline(exec.signal, timeoutMs, TOOL_TIMEOUT)
    const upstream = exec.signal; exec.signal = d.signal
    try { const r = await next(); return timeoutOf(d.signal, TOOL_TIMEOUT) ? toolTimeoutResult(timeoutMs) : r }
    finally { exec.signal = upstream }
  })                                                        // disposer auto-registered on unload
}
```

## 9. Subagents and multi-agent

The `ctx.subagents` providers are listed below (`packages/subagent/*`, READMEs). Each is exposed as a tool (`tool-subagent`). Control tools cover listing agents, sending a message, interrupting and waiting.

| Provider | Behaviour |
|---|---|
| `spawn` | In-process child with an empty history. It inherits route and preset. |
| **`fork`** | Seeded with the parent's *completed-turn* prefix; the in-flight turn is excluded (`subagent-fork-in-process/src/index.ts:39-77`). |
| ACP and dsh-sdk | Separate processes. |
| **Codex** | Pinned `@openai/codex` 0.153.4 running `app-server --stdio` JSON-RPC with an ephemeral thread (`subagent-codex/src/run.ts:132-136`; `wire.ts:285-299`). |
| **Claude Code** | `@anthropic-ai/claude-agent-sdk` 0.3.263 with a custom spawn routed through the harness subprocess service (`subagent-claude-code/src/run.ts:370-371`). |

The external providers run one task and return only the final text.

Forked children keep the parent's request prefix byte-identical (`.agents/notes/implemented/architecture/2026-08-10-fork-children-stay-one-shot.md`):
- a global `send_message` tool, so the tool schemas are identical;
- the delegation note sits in *runtime context*, not the system prompt (`child-agent.ts:206-210`);
- the task is appended after the seed;
- the tool has no model-selection args (`base/cordis.patch.yml:395-403`; `tool-subagent/src/index.ts:85`).

Children pin approval to `never`, so they work inside the sandbox fixed at delegation (`child-agent.ts:222-240`). The depth limit persists in the session header. Teams add a shared task board with compare-and-set ownership; workflow runs JS scripts with `agent()` and `parallel()`.

## 10. Performance

- **Lazy loading.** CLI modes are loaded with dynamic import (`apps/cli/src/bin.ts:33-67`). `dsh-lazy-require` covers CJS host dependencies. Only narrow pi-ai entry points are imported, "without evaluating pi-ai's aggregate entry point" (`llm-pi-ai/src/models.ts:1-36`).
- **Message derivation.** Done incrementally: each surface node is projected once and cached by content generation (`core/session/src/index.ts:999-1020`). Frozen messages are tracked in a WeakSet so history is not re-frozen (`agent.ts:728-734`).
- **Persistence.** Session projection cache with write-behind (`base/cordis.patch.yml:196-200`). Full-text session search is off by default. The JSONL migration verifier runs in a worker thread.
- **Streaming.** Idle watchdogs: 300 s for DeepSeek (`llm-deepseek/src/adapter.ts:65-89`; `defaults.ts:4`). The pi-ai patch removes O(n²) partial-JSON parsing.
- **Concurrency.** Up to 10 parallel tool calls, live-reconfigurable (`maxParallelToolCalls` is Volatile).
- **Measurement.** Benchmarks act as gates (`benchmarks/*`: session-open, session-corpus, agent-continuation, terminal-io, long-session-browser).
- **Main cost.** Prefix-cache reuse is effectively the main performance feature.

## 11. Top 8 ideas worth adopting

1. **Split static prompt from runtime context.** `section()` holds static text; `context()` produces a durable user-role snapshot that is appended only when it changes (`system-prompt/src/index.ts:52-90, 177-185, 320-324`; `runtime-context.ts:119-169`). Why it matters: dates, cwd, sandbox and approval policy stop busting the cached prefix, and every request stays replayable.
2. **Per-route update capabilities** (`systemPromptUpdate`, `toolUpdate`) plus logged `tool-addition` / `tool-removal` developer messages and `deferLoading` (`llm/types.ts:434-465`; `agent.ts:692-706`; `content.ts:439-510`). Why it matters: mid-session prompt, MCP and plugin changes extend the cache instead of invalidating it, with a clean fallback for each provider.
3. **Requests reconstructable from an append-only log**: `request/header` snapshots with reasons, deep-frozen derived history, and a loop-request marker (`agent.ts:656-744`; reconstructable-requests note). Why it matters: the next request is an append-extension of the previous one *by construction*, and every cache drop is attributable in the log.
4. **Compaction that reuses the cache**: replay system, tools and history, then add a trailing instruction (`summarizer.ts:25-31, 120-162`). Why it matters: the most expensive call in a long session hits the warm cache instead of a full prefill.
5. **Batch and minimise history rewrites**: prune only under pressure, offload images in quanta, and never move unchanged prompt text into node 0 (`compaction-basic/src/index.ts:344-349`; `runtime-context.ts:93-108`; the 2026-10-22 note). Why it matters: one careless rewrite cut a step from 99.9% to 0.16% cache hit.
6. **Fork subagents that keep the prefix** (identical tools, prompt and seed, child-specific bytes at the tail) and **vendor-CLI delegation** over official SDK and app-server protocols (fork note; `subagent-codex/src/wire.ts`; `subagent-claude-code/src/run.ts`). Why it matters: cheap context-sharing children, plus Codex and Claude Code as subagents without screen-scraping.
7. **Context measurement anchored to provider usage, with cache telemetry and real-API cache tests** (token-meter README; `turn-usage.ts`; `request-cache.e2e.ts`; `StatsPills.tsx:108-119`). Why it matters: compaction triggers stay accurate, and cache regressions fail CI instead of failing silently.
8. **Profiles, bundles and patches with row ids, isolate realms, scoped registries, and registrations as effects** (`docs/architecture.md:13-39`; `scope/src/index.ts`; `plugin-compatibility.ts`). Why it matters: any built-in, the loop included, can be overridden per deployment, preset or agent without forking, and hot reload unwinds cleanly.

Also worth adopting:
- Pin the tool catalog constant across modes, so plan mode changes the prompt only.
- Cap tool results with a spill locator at post-execute.
- Fail-closed durability checkpoints before each model request.

## 12. Weaknesses and gaps

**Weaknesses:**
- **Default data egress.** `dsh_session_log` is **enabled by default** (`session/session-log-deepseek/src/index.ts:60`, mounted at `base/cordis.patch.yml:43-44`). It uploads the session log, including tool output, file contents and cwd, up to 8 MiB per request to the DeepSeek endpoint or any configured gateway (`docs/deepseek-llm-api-wire-extensions.md:74-76, 160`). It also sends the plugin inventory and an anonymous user-id header.
- **Caching outside DeepSeek is delegated.** Breakpoints, TTL and cache keys live in pi-ai. Real Anthropic and OpenAI routes probably lack in-history prompt and tool updates, so any prompt or tool change rewrites the prefix. There are no local-model KV controls and no Gemini explicit cache.
- **Weak enforcement and trust.**
  - Plan mode is guidance only.
  - Plugins run in-process and unsandboxed, and agents can install them with approval.
  - Subagents cannot ask for approval.
  - Codex and Claude Code children run one task each, with no continuation.
- **Measurement and cost.** No USD cost accounting. Token estimates are poor for CJK text. Superseded runtime-context and prompt nodes accumulate until compaction (an accepted trade-off).
- **Adoption cost.** The project is very complex (about 6k TS files, about 2.7k agent notes, an elaborate process). APIs are pre-stable.

**Docs and code disagree:**
1. **Stale cache field names.** The `request-cache.e2e.ts:20, 96` comments and `llm/src/types.ts:179-180` describe `prompt_cache_hit_tokens` / `prompt_tokens`. The adapter actually parses Anthropic-style `cache_read_input_tokens` (`translate.ts:36`).
2. **TUI references.** CLI help still shows a `tui` profile (`apps/cli/src/args.ts:10, 90-100`), but no TUI ships.
3. **Session-log default.** The session-log-deepseek README frames it as "for deployments enabling…", but it is on by default.
4. **Deprecated hook still used.** `docs/architecture.md:114` calls `agent/request` deprecated, yet model-switch compaction depends on it (`compaction-basic/src/index.ts:181-203`).
5. **Package description.** `llm-pi-ai`'s `package.json` calls it a "DeepSeek … design-verification twin", while its README and the base bundle present it as *the* multi-provider adapter.
6. **Model ids.** The e2e test uses `deepseek-v4-flash` while the catalog id is `deepseek-flash` (`request-cache.e2e.ts:79`; `models.ts:10`).
