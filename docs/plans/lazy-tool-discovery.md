# Plan: Lazy Tool Discovery (cut per-request tool-schema bloat)

Status: IMPLEMENTED (2026-06-16, branch `feat/lazy-tool-discovery`). Phases 1-6
landed.

### Phase 6 measured results (research role, `scripts/measure-tool-payload.ts`)
- **Advertised tool payload:** FULL 49 tools / 29,087 bytes (~7.3k tokens) →
  LAZY 13 tools (11 core + 2 discovery) / 7,869 bytes (~2.0k tokens) =
  **72.9% smaller**. 38 handlers move behind `list_tools`/`describe_tool`.
- **Live prefill (qwen3:8b, ollama, num_ctx=16384):** prompt_eval_count
  6,387 → 1,705 tokens = **73.3% fewer prefill tokens** (matches the byte cut).
  Wall-time prefill on a *warm/healthy* GPU is already sub-100ms so the time
  delta is small/noisy there; the win is largest on a cold iGPU with no prefix
  cache (the original timeout failure mode).
- **Tuning note:** core = `['websearch','knowledge']`. `knowledge` is a 9-handler
  group (~6.3k bytes) kept whole, so it dominates the residual core payload.
  Dropping `knowledge` to the long tail would reach ~95% reduction but costs a
  discovery round-trip on the common KB-search path — kept core deliberately
  (Design decision: don't over-trim the common path). Note: `coreToolIds` is
  toolId-granular, so a finer split would require carving a lighter knowledge
  tool group.
- NOTE: the plan's `OLLAMA_DEBUG_LOG_REQUESTS` / `/tmp/ollama-request-logs-*`
  capture does **not** exist in this codebase; measured via the script above
  (static payload) + a direct `/api/chat` prefill benchmark instead.
Author context: 2026-06-16. Follow-up to the research-role trim (commit a2491fb).

Implemented files: `src/core/orchestrator/tool-split.ts` (+ test),
`src/tools/tool-discovery.ts` (+ test), `RoleMeta.coreToolIds` +
`roles/index.ts` validation, `AgentWorkerConfig.toolAdvertisement` (agent-base),
agent-worker `:1231` advertisement filter, worker-spawner gating,
`roles/research/config.ts` core set. Docs: `docs/OLLAMA.md`.

## Problem & goal

Every allowlisted tool's full JSON parameter schema is advertised on **every**
request via the OpenAI `tools` field (`agent-worker.ts:1231`). For research this
was ~12k tokens of schemas vs a ~2.4k system prompt; on the local ollama iGPU
that prefill took minutes and timed out the client.

Goal: advertise only a small **core** set of tools natively (full schema, no
round-trip) plus two lightweight discovery meta-tools (`list_tools`,
`describe_tool`) for the **long tail**. Target ~90–95% reduction of the tool
payload for tool-light turns, at the cost of one extra round-trip when a
long-tail tool is first needed.

## Key architectural facts (verified — Phase 0 done)

- Tool array built at **`src/core/agent-worker.ts:1231-1240`** from
  `this.toolExecutor.getTools().values()` → `ChatCompletionTool[]`, passed as
  `tools` at `:1278`. Each `ToolHandler` has `{ name, description, parameters,
  toolId?, execute }` (`src/core/agent-base.ts:21-32`).
- **Dispatch is independent of advertisement.** Tool calls are executed in
  `ToolExecutor.handleToolCalls()` via `this.tools.get(toolCall.name).execute()`
  (`src/core/tool-executor.ts:302-421`, lookup at `:344`). ALL role tools are
  registered in the executor regardless of what we advertise — so a model can
  call any registered tool by name even if its schema wasn't sent. **This is the
  crux: lazy discovery only changes the advertised `tools` array, never
  registration or dispatch.**
- Role tools resolved in **`getToolsForRole()` `src/core/orchestrator/roles.ts:113-141`**:
  filters `toolIds` by capability, fetches built-in handlers via
  `getToolRegistry().getToolHandlersForTools(builtinIds)`, and **already appends
  MCP lazy handlers** `getMCPBridge().getLazyToolHandlers()` when `'mcp'` is in
  `toolIds`. This is the precedent to mirror.
- MCP meta-tools `mcp_list_tools` / `mcp_call_tool` live in
  **`src/mcp/bridge.ts:492-579`** (`getLazyToolHandlers()`); `mcp_list_tools`
  returns a catalog `{name, description, parameters}`. Built-in precedent for
  returning another tool's schema: **`art_toolbox_describe`**
  (`src/tools/artifacts-toolbox/index.ts:138-157` → registry `describe(id)`).
- Role config type **`RoleMeta`** = `{ role, toolIds, defaultTopic }`
  (`src/core/orchestrator/roles/types.ts:7-11`); loaded by folder-scan in
  `roles/index.ts:30-88` (the loader copies fields into `RoleConfig`, so any new
  field must be threaded there too).
- Small-model detection: **`isSmallModel(model, routerMaxParams)`**
  (`src/core/orchestrator/small-model.ts:39-43`) using `deriveParamCount`
  (`mode-selector.ts:46-65`). `worker-spawner.ts` already branches on `isSmall`
  (e.g. `applyToolCap(roleTools, orchCfg.smallModelMaxTools, …)` ~`:437`) and
  trims prompt sections. Model carries `supportsTools` and `metadata.paramCount`
  (`src/db/schema/models.ts:4-78`).
- Eval harness: `bun run eval` → `src/eval/cli.ts`; YAML suites in `eval/`
  (`capability-routing.yaml`, `small-mode.yaml`, `quality.yaml`); assertion
  types incl. `uses_tool`, `not_uses_tool`, `routes_to_role`, `token_count_under`
  (`src/eval/types.ts:11-25`, evaluators `src/eval/assertions.ts:81-114`).
  NOTE GAP: integration-mode `toolsUsed` is currently `[]` (runner.ts ~:176,
  "would need agent event tracking") — `uses_tool` only works reliably in unit
  mode today; wiring tool-event capture is part of Phase 6 if we want
  integration assertions.

## Design decisions (bake these in)

1. **Split source = role config.** Extend `RoleMeta` with optional
   `coreToolIds?: string[]`. Semantics:
   - `coreToolIds` absent/undefined → **current behavior** (advertise all
     `toolIds` with full schema). Fully backward-compatible; no role is forced to
     opt in.
   - `coreToolIds` present → advertise only those with full schema; the rest of
     `toolIds` become the long tail behind discovery meta-tools.
   - Invariant: `coreToolIds ⊆ toolIds`. Validate at load time in
     `roles/index.ts` (fail loud — throw, matching the existing role/folder-name
     check).
2. **Advertisement, not registration, is what changes.** Keep registering ALL
   role tools in the ToolExecutor (dispatch must keep working). Only the
   `tools`-array builder filters down to core + meta-tools.
3. **Discovery meta-tools injected like MCP's.** Add a
   `buildToolDiscoveryHandlers(longTail: ToolHandler[])` that returns
   `list_tools` + `describe_tool` `ToolHandler`s closed over the worker's
   long-tail set. Mirror `mcp_list_tools`/`art_toolbox_describe` exactly.
   - `list_tools()` → `[{name, description}]` for the long tail (NO parameters —
     that's the whole point).
   - `describe_tool({name})` → `{name, description, parameters}` for one tool;
     throw on unknown name (fail loud, suggest `list_tools`).
   - These are registered AND advertised (they're the entry point).
4. **Gating (DECIDED: ollama-only + non-small).** Lazy discovery is enabled
   **only when `model.provider === 'ollama'`** AND the model is non-small AND has
   `coreToolIds` set. Rationale: the bloat only hurts local ollama (each request
   re-prefills the schemas on the iGPU with no cross-request server-side prompt
   caching benefit across cold loads/evictions); remote providers (deepseek,
   openai, anthropic) prefix-cache the tool block cheaply and tool-call more
   reliably, so they stay on the proven full-schema path.
   - **provider !== 'ollama'**: full schema (unchanged). Never lazy.
   - **ollama + small model** (`isSmallModel`): NOT discovery — keep the existing
     `applyToolCap` path (full schemas, hard-capped count). Small models chain
     multi-step discovery poorly and already get the heaviest prompt trims.
   - **ollama + non-small + `coreToolIds` set**: use lazy discovery.
   - **`supportsTools === false`**: no tools at all (unchanged).
   - Gating decided in `worker-spawner.ts` (where `isSmall` and the resolved
     model — incl. `provider` — are already known), then passed to the worker so
     the `:1231` builder knows the mode. Do NOT re-derive model size or provider
     in agent-worker.
5. **Boundary with MCP discovery.** MCP keeps its own `mcp_list_tools`/
   `mcp_call_tool` (genuinely dynamic/remote). Built-in discovery is a separate
   pair (`list_tools`/`describe_tool`) over statically-registered built-ins —
   built-ins are called *directly by name* (no `call_tool` indirection needed,
   since their handlers are registered). Document this two-surface split; note
   future unification as out-of-scope for v1.

## Phases

### Phase 1 — Types + config plumbing + split helper
**Implement:**
- Add `coreToolIds?: string[]` to `RoleMeta` (`roles/types.ts:7-11`) and to
  `RoleConfig` + the loader copy in `roles/index.ts:30-88`. Add the
  `coreToolIds ⊆ toolIds` validation (throw on violation).
- Add a pure helper (new file `src/core/orchestrator/tool-split.ts`):
  `splitRoleTools(handlers: ToolHandler[], coreToolIds: string[] | undefined):
  { core: ToolHandler[]; longTail: ToolHandler[] }`. Map handler→toolId via
  `handler.toolId`. If `coreToolIds` undefined → `{ core: handlers, longTail: [] }`.
  Keep the `mcp` lazy handlers in `core` (they're already a discovery surface).
**Verify:** unit test `tool-split.test.ts` — undefined passes all through as
core; a defined subset partitions correctly; mcp handlers always land in core.
**Anti-patterns:** no `any`; don't mutate the input array; don't read model/DB
here (pure function).

### Phase 2 — Built-in discovery meta-tools
**Implement:** `buildToolDiscoveryHandlers(longTail: ToolHandler[]):
ToolHandler[]` (new file `src/tools/tool-discovery.ts`), copying the shape of
`src/mcp/bridge.ts:500-578` and `artifacts-toolbox` `describe`:
- `list_tools` — params `{}`; returns `longTail.map(t => ({ name: t.name,
  description: t.description }))`. Description tells the model: "call
  `describe_tool` to get a tool's parameters before using it."
- `describe_tool` — params `{ name: string (required) }`; returns the matching
  handler's `{name, description, parameters}`; throw if not found.
**Verify:** unit test — `list_tools` omits `parameters`; `describe_tool` returns
the exact schema object; unknown name throws with a helpful message.
**Anti-patterns:** don't deep-clone schemas unnecessarily; don't swallow the
unknown-name error.

### Phase 3 — agent-worker advertisement integration
**Implement:**
- Add a worker-level field (set at spawn) e.g. `toolAdvertisement: { mode:
  'full' } | { mode: 'lazy'; coreToolIds: string[] }` on `AgentWorkerConfig`
  (`agent-base.ts`) — passed in by the spawner (Phase 4), NOT derived here.
- At `agent-worker.ts:1231`, when mode is `lazy`: build the advertised array as
  `splitRoleTools(...).core` schemas **plus** `buildToolDiscoveryHandlers(longTail)`
  schemas. When `full`: current behavior verbatim.
- Leave `handleToolCalls` untouched — long-tail tools remain registered and
  callable by name.
**Verify:** a unit/integration test that, with a lazy role, the constructed
`tools` array contains core tool names + `list_tools` + `describe_tool` and does
NOT contain long-tail tool schemas; and that calling a long-tail tool by name
still dispatches (executor lookup succeeds).
**Anti-patterns:** don't change the dispatch/registration path; don't break the
`toolsDisabled` short-circuit.

### Phase 4 — Gating in worker-spawner
**Implement:** in `worker-spawner.ts` where `isSmall` is computed and
`getToolsForRole` is called (~:275-437):
- Compute mode: `lazy` iff `model.provider === 'ollama' && !isSmall &&
  roleConfig.coreToolIds !== undefined && model.supportsTools`; else `full`.
  Small-model (and all non-ollama) paths keep the current behavior /
  `applyToolCap`.
- Pass the chosen `toolAdvertisement` into the worker config.
- Log the decision (mode, core count, long-tail count) for observability.
**Verify:** spawn a non-small research worker → mode lazy, advertised count
small; spawn a small-model worker → mode full + capped. Assert via logs/test.
**Anti-patterns:** don't duplicate small-model detection logic — reuse
`isSmallModel`. Fail loud if `coreToolIds` references an id not in `toolIds`
(should already be caught in Phase 1).

### Phase 5 — Configure core sets per heavy role
**Implement:** add `coreToolIds` to the roles with the biggest payloads. Start
with **research**: `coreToolIds: ['websearch', 'knowledge']` (hot path; the
rest — filesystem, profiles, artifacts, artifacts_toolbox, task_state, mcp —
become long tail; mcp stays core via the split rule). Review other roles
(coding, general, security, ai) and set conservative cores; leave roles without
`coreToolIds` unchanged.
**Verify:** capture a real request body (see Phase 6) for research before/after;
confirm advertised tool bytes drop ~90%.
**Anti-patterns:** don't over-trim a role's core below what it needs every turn
(causes a round-trip on the common path); don't touch roles you didn't measure.

### Phase 6 — Tests, eval, and perf measurement
**Implement / run:**
- Unit tests from Phases 1–3.
- `bun run typecheck && bun run lint && bun test` green.
- `bun run eval` — `capability-routing.yaml`, `small-mode.yaml`, `quality.yaml`
  must stay green (routing/role selection unaffected; tool advertisement is
  post-routing). Add a new suite `eval/tool-discovery.yaml` with a non-small
  scenario asserting a long-tail tool is reached via discovery, and a small-model
  scenario asserting the capped/full path. NOTE: to assert `uses_tool` in
  integration mode, first close the runner.ts `toolsUsed` gap (wire agent
  tool-call events into the eval context) — scope this explicitly or keep the
  new assertions unit-mode where possible.
- **Perf measurement (the actual win):** with `OLLAMA_DEBUG_LOG_REQUESTS=1`,
  capture a research request body from
  `/tmp/ollama-request-logs-*/*_api_chat_body.json` in the `ollama` container;
  compare `len(json(tools))` before vs after, and measure prefill `prompt eval
  rate`/duration for the same prompt. Record numbers in the PR.
**Verify:** payload bytes down ~90% for a tool-light research turn; evals green;
a long-tail tool still usable end-to-end.

### Final Phase — Verification & rollout
- Re-confirm backward compat: a role with no `coreToolIds` produces a byte-for-
  byte identical `tools` array to today (snapshot test).
- Confirm small models are never put on the discovery path.
- One logical change per PR: consider splitting (A) mechanism (Phases 1-4) from
  (B) per-role config (Phase 5) so the mechanism can land dark (no role opts in
  → no behavior change) and roles opt in incrementally.
- House rules: fail-loud everywhere, no `any`, no hardcoded models, eval green.

## Risks / open questions for review
1. **Round-trip cost on slow local models.** On the iGPU an extra discovery turn
   = extra prefill+gen. Net win only when long-tail tools are used rarely. The
   core set must cover each role's common path. (Mitigated by Phase 5 tuning.)
2. **Mid-size local models' discovery reliability.** glm-4.7-flash/qwen — do they
   reliably call `describe_tool` then the real tool? Validate in Phase 6 before
   enabling for a role in production. If shaky, gate lazy mode to remote models
   only (add a capability/metadata flag rather than size alone).
3. **Prefix caching softens the cost for remote — RESOLVED: ollama-only gate.**
   Remote providers prefix-cache the tool block cheaply and tool-call reliably,
   so lazy discovery is gated to `provider === 'ollama'` only (see Design
   decision 4). Remote models always stay on full schema. (A future
   `metadata.lazyTools` opt-in flag could broaden this, but is out of scope.)
4. **Two discovery surfaces (built-in vs MCP).** Acceptable for v1; note future
   unification.
