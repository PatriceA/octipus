# Goose-Inspired Enhancements — Phased Plan

**Created:** 2026-06-19
**Status:** Draft for review (extendable — add workstreams as sections)
**Source:** Evaluation of Block/Goose (block/goose, AAIF) against Octipus.
**Method:** Phase 0 documentation-discovery agents mapped every claim to `file:line`
in this repo. Scope was corrected against reality — several "borrow" ideas already
exist in Octipus and are downgraded accordingly.

> House rules in force for every workstream (DESIGN.md): no hardcoded models — bind a
> topic and resolve via `ModelRegistry.getModelForTopic(topic)`; fail loud; secrets in
> vault not `.env`; tests required; **one thing per PR** → each workstream is its own
> `feat/*` or `fix/*` branch. Run a Sonnet code review before each PR.

---

## TL;DR — what's actually worth doing

| # | Workstream | Reality after audit | Effort | ROI | Order |
|---|-----------|--------------------|--------|-----|-------|
| 1 | **Toolshim** (translator model for weak/local models) | Genuinely new. Attacks recurring Ollama tool-call breakage. | M | ⭐⭐⭐ | **1st** |
| 2 | **Tool-output-targeted summarization** | Proactive compaction already exists (token-threshold). Refine to per-tool-output granularity. | S–M | ⭐⭐⭐ | **2nd** |
| 5 | **Recipes via pipeline extension** | Full pipeline system already exists (80%). Add params + model override + sharing. | M | ⭐⭐ | 3rd |
| 3+4 | **Interactive plan checkpoint + checkbox resume** | Swarm/pipeline/task_state already cover the swarm path. Gap = single-agent plan-mode + markdown checkbox artifact. | S–M | ⭐⭐ | 4th |
| 6 | **MCP Apps** (interactive UI from tools) | Artifact infra + MCP `resources/list` both exist, unwired. Wire + sandbox. | M–L | ⭐⭐ | 5th |
| 7 | **Ollama live pull** | **Already fully built.** Only polish (WS stream + un-gate setup). | XS | ⭐ | last |

Skip entirely (already production-grade): extensions enable/disable + allowlist,
subagents, multi-provider, ACP/CLI-account auth. See §"Already covered".

---

## ▶ RECOMMENDED BUILD ORDER — single source of truth (start here)

Execute top-to-bottom. Each row is its own branch/PR (house rule: one thing per PR;
Sonnet review + `typecheck`/`lint`/`test`, plus `eval` where noted, before each).
**Before coding any item, read its phase/workstream section AND Phase 0 "Allowed APIs".**
The per-part "execution order" notes lower in this doc are subordinate to this list.

| # | Branch | What | Depends on | Effort |
|---|--------|------|-----------|--------|
| 1 | `chore/remove-unused-github-plugin` | Delete unused `extensions/github` (W8 first step) | — | XS |
| 2 | `refactor/capability-model` *(memo only)* | W8 design memo: capability-provider contract + connectors-as-primary. No code yet. | — | S |
| 3 | `feat/toolshim-translator` | Phase 1 — translator model for weak/local tool calls | — | M |
| 4 | `feat/incremental-tool-output-compaction` | Phase 2 — tool-output-targeted summarization | — | S–M |
| 5 | `feat/role-tool-binding-ui` | W7 — DB-backed, UI-editable role↔capability binding | memo #2 (for the connector/MCP part) | M |
| 6 | `feat/topics-page` | W10 — dedicated Topics config page (+ `executorModel` field) | — | M |
| 7 | `feat/lead-worker-models` | W9 — per-topic executor via swarm child | **#6** (needs `executorModel`) | S–M |
| 8 | `feat/recipes-on-pipelines` | Phase 3 — recipes on the pipeline engine | — | M |
| 9 | `fix/ollama-pull-polish` | Phase 6 — WS progress + default-on HW recommend | — | XS |

**Dependencies are minimal:** only #7→#6 is hard. #1–#4 are independent and safe to start
immediately. **#3 and #4 are the highest ROI** (toolshim + compaction) — if you want value
first; **#1/#2/#5/#6** if you want the modularity/config cleanup first. Both tracks are
independent — pick either, they don't block each other until #7.

**Deferred (do not start):** Phase 5 (MCP Apps) — reuse artifacts, revisit only if a real
`ui://` producer appears.

---

## Phase 0 — Allowed APIs (verified, cite these in every phase)

**Models / providers**
- `ModelProvider` interface — `src/models/providers/interface.ts` (`complete()`, `stream()`, `checkHealth()`).
- `ProviderRouter` singleton `getProviderRouter()` — `src/models/providers/index.ts` (~L65–180).
- `ModelRegistry.getModelForTopic(topic): Promise<ModelConfigEntry|null>` — `src/models/model-registry.ts:109`. Unbound topic ⇒ returns null + logs "No model mapped for topic" (fail-loud at call site).
- Topic seed list — `src/models/single-model-binding.ts:27` (`SINGLE_MODEL_CHAT_TOPICS`), builder `singleModelTopicBindings()` L60. Background topics already include `summarization`, `memory_extraction`, `evaluation`.
- `CompletionResult { content, toolCalls?, finishReason, usage, ... }` — `src/models/litellm-client.ts:50`.
- Ollama provider + **pull with progress**: `OllamaProvider.pull(model, onProgress)` — `src/models/providers/ollama-provider.ts:492`; `PullProgress` L40; `parsePullLine` L56.

**Agent loop / context**
- Main loop `AgentWorker.loop()` — `src/core/agent-worker.ts:563`; iteration counter `this.iteration` L572; token accumulator `this.totalTokensUsed` L33/778.
- Existing **proactive** compaction: `AUTO_COMPACT_THRESHOLD = 100_000` L656, compaction L658–669.
- Reactive (ContextWindowExceeded) compaction L718–742.
- `compactMessagesWithSummary(messages, options)` — `src/utils/context-compaction.ts:385`; `estimateTokens` L34, `calculateTotalTokens` L43.
- Tool-call robustness already present: `normalizeToolCallNames` (`src/core/tool-executor.ts:142`), hallucinated-respond intercept (`agent-worker.ts:800`), repeat/spam loop detection (L818–875), `appendSyntheticToolResults` (L1344), **text→toolcall fallback** `parseTextToolCalls` (L1144–1219).
- Tool-call error classification — `src/core/errors/classification.ts:249–271` (`TOOL_CALL_INVALID` / `RETRY_NOW`).

**Swarm / orchestrator / pipelines**
- `SwarmSpawner.spawnChild()` — `src/core/swarm/spawner.ts:98`; **drops parent Q&A history**, passes only `TaskBrief` via `composeChildMessage()` L1085.
- `spawnWorker()` — `src/core/orchestrator/worker-spawner.ts:265`; fresh context, message = `task` + optional `input` (L841), no history.
- Pipeline handoff — `src/core/orchestrator/handoff.ts` (`createHandoffContext` L119, `formatHandoffChain` L78).
- `PipelineManager.createAndRun()` — `src/core/orchestrator/pipeline-manager.ts:24`.
- Pipeline schema — `src/db/schema/pipelines.ts:1` (`currentStageIndex`, stage `status`, `requiresApproval`); template schema `src/db/schema/pipeline-templates.ts:1` (`PipelineStepConfig { maxRetries, retryTargetStage, promptTemplate, model? }`).
- Template var expansion `expandPromptTemplate(template, vars)` — `src/core/orchestrator/templates.ts` (only `{{description}}`, `{{previousOutput}}`, `{{handoffText}}` today).
- `task_state` table — `src/db/schema/task-state.ts:1` (`status pending|in_progress|done|...`, `inputs/outputs jsonb`, `dependsOn uuid[]`, `pg_notify task_state_<session>`).

**Artifacts / MCP / web**
- Artifact schema — `src/db/schema/artifacts.ts:1` (`currentVersionId`, `metadata jsonb` incl iframe allow-list); versions `src/db/schema/artifact-versions.ts:1` (`htmlTemplate`, `schemaJson`, `changeSummary`; append-only, pointer-based).
- Render — `src/core/artifacts/render.ts:52` (`renderTemplate`, handlebars-like, scripts stripped); events `src/core/artifacts/events.ts` (`publishArtifactVersionUpdated`).
- Artifact REST — `src/api/routes/artifacts.ts` (returns `embedUrl/outerUrl/appUrl/shareUrl`); UI `web/app/artifacts/page.tsx`.
- **MCP resources already fetched**: `MCPBridge.connect()` calls `resources/list` — `src/mcp/bridge.ts:166–176`; `MCPResource { uri, name, mimeType }` `src/mcp/protocol.ts:32`. **Not yet surfaced to agents/UI.**
- WS streaming pattern — `src/api/websocket.ts:83` (`agentManager.onEvent()` → `safeSend`).

**hwfit (Ollama)**
- Catalog `src/capabilities/hwfit/catalog.ts:20`; live sizing `src/capabilities/hwfit/sizing.ts:63` (`fetchSizeMB` → `/v2/library/{name}/manifests/{tag}`); install job runner `src/capabilities/hwfit/install.ts:112` (`startInstall`/`runInstall`, `InstallJob`); routes `src/api/routes/models.ts:805/848/904`; web `web/components/models/recommended-models-panel.tsx:112` (`pollJob`); setup `scripts/setup-wizard.ts:703` (`maybeRecommendModel`, gated by `OCTIPUS_SETUP_RECOMMEND=1`).

**Anti-patterns to avoid (all phases)**
- Do NOT hardcode any model id — always a bound topic.
- Do NOT add a parallel system where one exists (no new "recipe" tables if pipelines fit; no new artifact renderer).
- Do NOT swallow errors — surface tool-translation / pull / render failures.
- Do NOT reformat untouched code (Biome formatter is off).

---

## Phase 1 — Toolshim (translator model)  ⭐ top priority

**Branch:** `feat/toolshim-translator`

**Goal.** When the primary model returns prose that *should* have been a tool call
(no structured `toolCalls`, and `parseTextToolCalls` fails), call a small bound
translator model to convert the prose + the available tool schemas into a valid
tool call, instead of dead-ending or burning a `TOOL_CALL_INVALID` retry.

**Why (grounded).** Octipus already patches symptoms: near-miss names
(`tool-executor.ts:142`), hallucinated respond tools (`agent-worker.ts:800`),
text→toolcall regex/JSON fallback (`agent-worker.ts:1144`), Ollama parser-error
retries (`classification.ts:264`). Toolshim is the model-based escalation of that
last-resort fallback — exactly Goose's pattern (pair weak model with a small
translator).

**What to implement (copy the existing fallback shape, don't invent):**
1. New bound topic `tool_translation` — add to `SINGLE_MODEL_CHAT_TOPICS`
   (`src/models/single-model-binding.ts:27`). Resolve via
   `ModelRegistry.getModelForTopic('tool_translation')`. If unbound ⇒ skip toolshim
   (fail-soft to current behaviour) and log once — do NOT hardcode a model.
2. New module `src/models/toolshim.ts`:
   `async translateToToolCall(opts: { text: string; tools: ToolSchema[]; model: ModelConfigEntry }): Promise<ToolCall | null>`.
   - Prompt the translator with the tool schemas (reuse the schema shapes already
     passed to providers) + the primary model's prose; require a single JSON tool call.
   - Validate the returned name against `toolExecutor.getTools()` (same guard
     `parseTextToolCalls` uses, `agent-worker.ts:1198`-ish) before returning.
3. Wire into `agent-worker.ts` **after** `parseTextToolCalls` returns empty and
   before returning prose as final text (around L929–948). Order:
   structured toolCalls → `normalizeToolCallNames` → `parseTextToolCalls` → **toolshim** → plain text.
4. Gate: only invoke when (a) topic bound, (b) the turn was expected to act (tools
   available + not toolsDisabled), (c) at most once per iteration (reuse an
   iteration-scoped flag like `lastToolCallSignature` L37).

**Verification checklist**
- Unit: `toolshim.test.ts` — prose + schema ⇒ valid `ToolCall`; unregistered name ⇒ null; malformed JSON ⇒ null (fail-soft).
- Unit: unbound `tool_translation` topic ⇒ toolshim skipped, no throw.
- Integration: a stub provider returning prose-instead-of-toolcall ends in a real tool execution, not a dead-end.
- `bun run typecheck && bun run lint && bun test src` green.

**Anti-pattern guards.** No model id literals. Don't replace the existing
fast-path fallbacks — toolshim is the *last* resort (a model call is expensive).
Fail-soft to today's behaviour if anything is missing.

**Effort:** M. **Risk:** Med (extra latency on the failure path only — guard hard).

---

## Phase 2 — Tool-output-targeted summarization

**Branch:** `feat/incremental-tool-output-compaction`

**Reality.** Octipus already compacts proactively at
`totalTokensUsed > AUTO_COMPACT_THRESHOLD (100_000) && messages.length > 10`
(`agent-worker.ts:656`). Goose's nuance: summarize the **oldest tool outputs**
specifically once there are >N tool calls, keeping recent calls full — cheaper and
less destructive than whole-history compaction, and triggers earlier so overflow
400s are rarer.

**What to implement (extend, don't replace):**
1. Add an iteration-independent counter for tool results retained in `this.messages`
   (count `role === 'tool'` messages). Constant `TOOL_OUTPUT_SOFT_CAP` (default 10,
   mirror Goose).
2. When the count exceeds the cap, summarize/truncate the **oldest** tool messages
   only — reuse the existing truncation idiom from the reactive block
   (`agent-worker.ts:728–732`, slice to 2000 + marker) or call
   `compactMessagesWithSummary` with a high `preserveRecentCount` so only old tool
   outputs fold. Keep assistant/user turns intact.
3. Hook next to the existing `AUTO_COMPACT_THRESHOLD` check so both proactive paths
   live together (L656). Make the cap config-driven via `AgentWorkerConfig`
   (`src/core/agent-base.ts:28` area), not a literal.

**Verification checklist**
- Unit: 12 tool messages + cap 10 ⇒ 2 oldest summarized/truncated, recent untouched, non-tool turns preserved.
- Unit: counter resets correctly after compaction (no double-fold loop).
- Regression: existing 100k-token proactive + reactive paths still fire (don't break `context-compaction` tests).
- `bun test src` green.

**Anti-pattern guards.** Don't summarize recent tool outputs (model still needs
them). Don't double-compact. Token estimate stays the existing `estimateTokens`
heuristic — don't add a tokenizer dep.

**Effort:** S–M. **Risk:** Low.

---

## Phase 3 — Recipes (single workflow primitive, on the pipeline engine)

**Branch:** `feat/recipes-on-pipelines`

> **DECISION (2026-06-19): collapse to ONE user-facing concept — "recipes".** Keep the
> pipeline *execution engine* (`PipelineManager`, stages, handoff, approval, retry — it's
> the runtime recipes need) but **retire `pipeline_templates` as a separate user concept**:
> recipes replace it as the authored, parameterized, shareable definition. Runtime
> instances stay (the `pipelines` rows = a running recipe). Net: no duplicate
> author-time primitive, slimmer surface, one thing the user learns.

**Reality.** Octipus has a production pipeline system that is ~80% of Goose recipes:
`pipelines` + `pipeline_templates` (`PipelineStepConfig { name, topic, toolIds,
requiresApproval, promptTemplate, maxRetries, retryTargetStage }`), templating
(`expandPromptTemplate`), approval gates, QA-validation retry. We reuse the engine and
**fold the template concept into recipes** — do NOT build a parallel `recipes` runtime.

**Gaps vs Goose recipes → what to add:**
1. **Typed parameters.** Add `parameters` to `PipelineTemplate` (Zod schema in
   `src/config/` style): `{ key, input_type: string|number|boolean|date|select,
   requirement: required|optional|user_prompt, default?, options? }`. Validate on
   create; prompt for `user_prompt` params at invoke.
2. **Parameter templating.** Extend `expandPromptTemplate`
   (`src/core/orchestrator/templates.ts`) to substitute `{{param.key}}` alongside the
   existing 3 vars. Keep it the same regex engine — do NOT pull in Jinja/handlebars.
3. **Per-recipe model/provider override.** `PipelineStepConfig.model` already exists
   in schema — honor it in `spawnWorker` overrides (`worker-spawner.ts:265` already
   accepts `overrides.model`); still resolve through `ModelRegistry` (override = a
   bound model id, never a literal in source).
4. **Sharing / authoring.** `pipeline_templates` already has `userId` + `isPreset`.
   Add export/import (YAML) + `/list_recipes` `/invoke_recipe` meta-tools alongside
   the existing `/create_pipeline` (`src/core/orchestrator/meta-tools.ts:95`).
5. **(Defer)** retry shell-`checks` and sub-recipe composition — Octipus retry is
   role/QA-based, not shell-exit-based; sub-recipes ≈ nested pipelines. Log as
   follow-ups, don't build now.

**Verification checklist**
- Unit: param schema validation (required missing ⇒ reject with specific message — fail loud).
- Unit: `{{param.key}}` expands; unknown param ⇒ explicit error.
- Integration: a 2-stage recipe with one `user_prompt` param + a per-stage model override runs end-to-end.
- Eval unaffected: `bun run eval` green (routing/prompt change surface).

**Anti-pattern guards.** No new parallel workflow tables. No new template engine.
Model overrides are bound ids, not literals.

**Effort:** M. **Risk:** Low–Med (touches orchestrator meta-tools → eval must pass).

---

## Phase 4 — Interactive plan checkpoint + checkbox resume

**Branch:** `feat/plan-checkpoint-resume`

**Reality.** The swarm path already does Goose's "fresh worker from the brief":
`spawnChild` drops Q&A history and passes only `TaskBrief`
(`spawner.ts:98/1085`); pipelines persist `currentStageIndex` + per-stage status +
retry; `task_state` tracks `status/dependsOn`. The genuine gap is the
**single-agent / orchestrator-direct** experience: (a) a "we've agreed the plan —
clear the chatter and execute against the plan doc" checkpoint, and (b) a
human-readable **markdown checkbox plan artifact** that updates in place and lets a
crashed/over-budget run resume from the first unchecked phase.

**What to implement:**
1. **Plan artifact.** Persist the agreed plan as an artifact (reuse
   `artifacts`/`artifact_versions`, `htmlTemplate`/`schemaJson` — a markdown body
   with `- [ ] Phase N` lines; `metadata` holds phase→task_state mapping). Creation
   via the existing artifact repo; no new table.
2. **Checkpoint handoff.** On "execute", spawn a fresh worker
   (`spawnWorker`/`spawnChild`) whose input is the **plan artifact only** (the
   mechanism already exists — just feed the artifact text as `input`, drop history).
   This is the Goose "clear message history, act on plan" move mapped onto the
   existing fresh-context spawn.
3. **Checkbox update + resume.** As each phase completes, flip its `task_state` row
   to `done` (`src/db/schema/task-state.ts`) AND re-render the artifact version
   (`publishArtifactVersionUpdated`). On resume, read the artifact / `task_state` and
   start at the first non-`done` phase. Lean on pipeline `currentStageIndex` when the
   plan is run as a pipeline.

**Verification checklist**
- Unit: plan markdown ⇄ phase list round-trips; first-unchecked detection correct.
- Integration: kill a run mid-phase-2, resume ⇒ starts at phase 2, phase-1 checkbox stays checked.
- Integration: checkpoint spawn carries plan text, NOT the prior Q&A (assert message history absent).

**Anti-pattern guards.** Reuse artifact versioning (append-only) — don't invent
in-place mutation. Don't duplicate `task_state`/pipeline state; bridge to them.

**Effort:** S–M. **Risk:** Med (artifact versioning is pointer-based; resume logic needs care).

---

## Phase 5 — MCP Apps (interactive UI from tools)

**Branch:** `feat/mcp-apps`  •  **DEFERRED — reuse existing artifacts, no new renderer.**

> **DECISION (2026-06-19): don't reinvent.** Do NOT build the Goose-style sandbox-proxy /
> double-iframe / postMessage MCP-App stack. If an MCP server ever emits a `ui://` HTML
> resource, surface it through the **existing artifact system as-is** (it already renders
> sandboxed HTML with allow-list metadata). No dedicated work scheduled until a real
> MCP-App producer we care about appears. The spike below stays as the trigger criteria.

**Reality.** Two halves already exist and just need wiring: (1) Octipus's **artifact
system** renders server-side HTML templates into sandboxed embeds with allow-list
`metadata` and `appUrl` (`artifacts.ts`, `render.ts`, `web/app/artifacts`); (2) the
**MCP bridge already fetches `resources/list`** (`bridge.ts:166`) but never surfaces
them. Goose's MCP Apps = an extension returns a `ui://` single-file HTML resource
(`text/html;profile=mcp-app`) rendered in a sandboxed iframe with CSP +
postMessage + tool callbacks via `_meta.ui.resourceUri`.

**Spike (timebox ~1 day) — answer before building:**
- Do any MCP servers Octipus connects to actually emit `ui://` / `mcp-app` resources? (else value is low.)
- Can the existing artifact iframe sandbox host MCP-App HTML, or is a distinct CSP/proxy needed (Goose uses a double-iframe + dynamic CSP)?
- Map `_meta.ui.resourceUri` tool-result linking onto Octipus tool-result → artifact flow (currently implicit).

**If green, build:**
1. Surface MCP resources with mime `text/html;profile=mcp-app` as a new artifact
   type (reuse `artifact_versions.htmlTemplate`).
2. Render in the existing sandboxed iframe; add dynamic CSP from resource metadata
   (`connect_domains`/`resource_domains`) — extend artifact `metadata` allow-list.
3. postMessage bridge in `web/` for `ui/initialize` + `ui/action/*`; route tool
   callbacks through the existing tool executor.

**Verification checklist**
- Spike memo committed to `.octipus/` with the 3 answers + go/no-go.
- If built: a sample MCP-App resource renders sandboxed; a `ui/action` tool callback executes and returns; CSP blocks an off-allow-list fetch (security test).

**Anti-pattern guards.** Reuse artifact rendering + iframe sandbox; don't fork a
second renderer. Security first — default-deny CSP, no host API exposure to guest.

**Effort:** M–L. **Risk:** Med–High (security surface; depends on real MCP-App producers existing).

---

## Phase 6 — Ollama live pull: polish only

**Branch:** `fix/ollama-pull-polish`

> **DECISION (2026-06-19): do the polish.** Both items below are in scope — WS-stream the
> install progress (drop polling) and make HW recommendation the default in interactive
> setup (un-gate `OCTIPUS_SETUP_RECOMMEND`).

**Reality.** **Already fully built** end-to-end: `OllamaProvider.pull` with streamed
progress, `hwfit/install.ts` job runner, `/models/recommend|install|install/:jobId`
routes, `RecommendedModelsPanel` with `pollJob`, and setup `maybeRecommendModel`.
Octipus already beats Goose here (Goose has no pull, no HW recs).

**Only-if-wanted polish (XS each):**
1. Replace install-progress **polling** (`recommended-models-panel.tsx:112`) with
   WS push — publish `runInstall` progress via the gateway hub (`websocket.ts:83`
   pattern). Nicer UX, less HTTP chatter.
2. Reconsider the `OCTIPUS_SETUP_RECOMMEND=1` gate (`setup-wizard.ts:704`) — make HW
   recommendation the default in interactive setup so first-run users get it.

**Verification.** WS event delivers progress to UI; setup recommends without the env flag.
**Effort:** XS. **Risk:** Low. *(Lowest priority — do only if idle.)*

---

## Already covered — explicitly skip

- **Extensions enable/disable + allowlist** — three layers already: filesystem
  extensions (`src/extensions/loader.ts`, hot-reload), plugins
  (`src/plugins/loader.ts`), MCP servers (`src/mcp/bridge.ts`), plus a full
  permission engine (`src/security/permissions.ts`, `permission-rules.ts`
  deny→allow→ask, `db/schema/permissions.ts` with conditions) and per-role tool
  binding (`db/schema/roles.ts`). Production-grade. **No work.**
- **Subagents** — swarm (`src/core/swarm/`) is more capable (budgets, depth, cancel, cycle detection).
- **Multi-provider** — `ProviderRouter` covers 12+ providers.
- **ACP / CLI-account auth** — `CLIAgentWorker` already inherits host creds (claude/codex/antigravity/mistral). See memory `project_cli_agent_host_config`.

---

## Suggested execution order (each = its own PR)

1. `feat/toolshim-translator` (Phase 1)
2. `feat/incremental-tool-output-compaction` (Phase 2)
3. `feat/recipes-on-pipelines` (Phase 3)
4. `feat/plan-checkpoint-resume` (Phase 4)
5. `feat/mcp-apps` (Phase 5 — spike gate first)
6. `fix/ollama-pull-polish` (Phase 6 — optional)

Phases 1–2 are independent and highest ROI; start there. 3–5 are independent of each
other and can parallelize across branches. Sonnet code review + `typecheck/lint/test`
(and `eval` for 3) before every PR.

---

---

# Part B — Modularity & configuration (added 2026-06-19)

**Why this part exists.** Octipus has **five** ways to add agent capabilities —
built-in tools (`src/tools`), plugins (`extensions/<name>`), MCP (`src/mcp`),
connectors (`src/connectors`), extensions (`src/extensions`) — with **three different
role-gating behaviours**. Goose has **one** (everything is an MCP "extension").
That sprawl is the source of "things are hardwired in several places, and we keep
adding." Part B converges them and makes capability↔role binding **data-driven and
UI-editable** instead of code-only.

**Verified gating today** (`worker-spawner.ts:276` intersects role tools; enforcement
in `orchestrator/roles.ts:113` `getToolsForRole`):
- built-in tools — `toolIds` in role `config.ts` (code-only).
- plugins — `plugin-<name>` in `toolIds` (code-only).
- MCP — all-or-nothing via a single `'mcp'` entry in `toolIds` + lazy meta-tools.
- connectors — **bypass roles entirely** (`worker-spawner.ts:278`), OAuth-presence gated.
- extensions — not tools; gateway commands, no role gating.

---

## W7 — DB-backed, UI-editable capability ↔ role binding  ⭐ unblocks the UX gap

**Branch:** `feat/role-tool-binding-ui`

> **DECISION (2026-06-19): yes, role-bindable — including connectors/MCP.** Primary driver
> (beyond the UX gap): **stop flooding every agent with tools it won't use.** Role binding
> is the lever that keeps each role's toolset minimal (also helps small models — fewer tools
> = less confusion, ties to `small-model.ts` tool-capping).

**Reality.** Role `toolIds` are defined only in code (`src/core/orchestrator/roles/<name>/config.ts`),
loaded once at startup (`roles/index.ts:30`). DB `roles.toolIds` **exists but is unused**
(`src/db/schema/roles.ts:6`). No `PATCH /roles`. Web `/tools` is read-only
(`GET /tools/role-map`, `src/api/routes/tools.ts:115`; UI `web/app/tools/page.tsx:120`).

**What to implement.**
1. Make DB `roles.toolIds` the runtime **override**, falling back to the code config
   when null — single read point in `getToolsForRole()` (`orchestrator/roles.ts:113`).
   Invalidate the role/tool cache on write (roles are cached at load).
2. `PATCH /roles/:id` route (admin-gated) to set a role's toolIds.
3. `/tools` UI: turn the read-only role badges into toggles — assign/unassign a
   capability per role; writes through to DB.
4. Bring connectors + MCP **under the same binding**: assign concrete ids
   (`connector_atlassian`, or per-MCP-server id) to roles instead of the
   all-or-nothing `'mcp'` flag and the role-bypassing connector path
   (`worker-spawner.ts:278`). Connectors must stop bypassing role gating.

**Verification.** Toggling a tool→role in UI changes which tools a freshly spawned
worker of that role receives (integration test). Connector tool no longer appears for
a role it wasn't bound to. Cache invalidates (no stale toolset). `bun test` + `eval` green
(tool-selection surface).

**Anti-patterns.** Don't fork a second resolution path — one read point. Don't lose the
code-config default (DB null ⇒ fall back). Keep enforcement in `getToolsForRole`.

**Effort:** M. **Risk:** Med (tool-resolution hot path + cache).

---

## W8 — Converge the five abstractions; prefer connectors over core

**Branch:** `refactor/capability-model` — **design-gate first** (memo in `.octipus/` before code).

> **DECISION (2026-06-19): connectors/MCP are the primary extension model (Goose-style);
> built-in tools are reserved for CORE only.** New capabilities should land as isolated
> connectors/MCP that never touch core code. The memo formalises this and the migration
> path. **GitHub decision:** GitHub is core for the dev workflow → **keep `src/tools/github`
> as a built-in tool**, but **fix its auth to a per-user vault token** (drop the host-keychain
> `gh auth` dependency — multiuser-safe; aligns with `feedback_secrets_in_vault_not_env`).
> **Delete `extensions/github`** (unused REST plugin) now. Revisit the official GitHub MCP
> server later only if we decide GitHub should leave core.

**Reality.** 5 registration paths, 3 gating behaviours (table above). The user's goal:
more capabilities should live as **isolated connectors/plugins** that never touch core
code.

**Design phase (output a memo, get sign-off):**
- Define ONE "capability provider" contract every path implements:
  `register() → declare tools → enable/disable → bind roles`. Adding any capability
  and assigning its roles becomes the same DB-backed operation.
- Write the decision matrix: when to use built-in tool vs plugin vs MCP vs connector
  (and deprecate overlap — e.g. extensions-as-commands vs plugins-as-tools).
- **Capability-awareness** (the Jira correction): the agent should detect a *not-
  connected* capability (no Atlassian OAuth ⇒ no Jira) and **prompt the user to
  connect**, never silently fail. This is the modular model working as intended —
  capabilities appear when their connector is added, isolated from core.

**Concrete first steps (safe, do now):**
1. **Delete the dead duplicate** `extensions/github/` (REST plugin, vault token,
   assigned to **no role** → zero dependents). Keep `src/tools/github` (gh-CLI, used by
   `review` role).
2. File a follow-up: `src/tools/github` auths via **host keychain** (`gh auth status`,
   `tools/github/index.ts:42`) — a multiuser problem. Move to per-user vault token
   (the pattern the deleted plugin already had). Relates to memory `feedback_secrets_in_vault_not_env`.

**Verification.** Memo committed + approved before refactor. `extensions/github` removal:
no role references `plugin-github` (grep), tests + boot green.

**Anti-patterns.** Don't big-bang the convergence — stage behind the memo. Don't remove
`src/tools/github` (it's wired into `review`).

**Effort:** design S, refactor L (stage). **Risk:** High if rushed → design-gate.

---

## W9 — Lead/Worker (planner + executor) models  — NEW (was missing from the plan)

**Branch:** `feat/lead-worker-models`

**Reality.** **No planner→executor split exists.** Orchestrator mode is param-count
tiered (`router/lite/full`, `src/core/orchestrator/mode-selector.ts:10`); workers pick
their own topic model independently (`model-selector.ts:88`); small-model prompt/tool
trimming exists (`small-model.ts:39`); `getBackupModelForTopic` exists but is **unused**
(`model-registry.ts:151`).

> **DECISION (2026-06-19): keep it lean — REUSE the swarm, no intra-turn model switching.**
> Do NOT swap models mid-conversation inside one worker (chain-dependent, error-prone).
> Instead: a topic optionally has an **executor model**; the **planner** (the worker on the
> planner model) does the reasoning and **spawns a swarm child** to execute, and that child
> binds to the topic's executor model. The planner can also spawn children for planning —
> it's just normal `spawn_child`. **Leave the executor empty when planner = executor**
> (then everything behaves exactly as today). This is purely a model-resolution tweak on an
> existing mechanism, nothing new in the loop.

**What to implement (minimal).**
1. Add an optional per-topic **`executorModel`** (Topics page, W10). Empty ⇒ no change.
2. In swarm child model resolution (`SwarmSpawner.spawnChild` → child model pick,
   `spawner.ts:98`), when a child is spawned for a topic that has an `executorModel`,
   resolve the child to that model via `ModelRegistry` (bound id, never a literal).
3. Nothing else — the planner is whatever model already serves the topic; execution is a
   normal swarm child. Pairs naturally with **Phase 1 toolshim** (the executor is exactly
   the weak/local model toolshim protects).

**Verification.** Topic with `executorModel` set: planner runs on the topic's planner
model, the spawned executor child runs on `executorModel` (assert child's resolved model).
Topic with `executorModel` empty: byte-for-byte today's behaviour (no regression). No
mid-turn model switch anywhere (assert one model per agent instance).

**Anti-patterns.** No intra-worker model switching. No new orchestration layer — reuse
`spawn_child`. No model-id literals. Empty executor = pure no-op path.

**Effort:** S–M. **Risk:** Low (additive, reuses swarm).

---

## W10 — Dedicated Topics configuration page

**Branch:** `feat/topics-page`

**Reality.** Topic binding is buried per-model in the edit modal
(`web/components/models/edit-model-modal.tsx`); `topicRoles` stores only
`'primary'|'backup'` (`src/db/schema/models.ts:26`); **no per-topic params**; the
canonical topic list is duplicated — `SINGLE_MODEL_CHAT_TOPICS` (20,
`src/models/single-model-binding.ts:32`) vs `AVAILABLE_TOPICS` (24,
`web/lib/types/models.ts:84`).

**What to implement.** A **topic-centric** page: list topics, assign primary/backup
model per topic, and hold per-topic extras the model card can't —
temperature/maxTokens override, **planner/executor pair (W9)**, backup model.
- Routing base stays (`getModelForTopic`, `model-registry.ts:109`); add a
  `topics_config` jsonb (or a `topics` table) for the extras.
- Reconcile the two canonical topic lists into **one** source of truth.
- This is the "easy config" surface the user asked for: base unchanged, place changes,
  room for more.

**Verification.** Assigning a model to a topic on the new page routes that topic to it
(parity with the old per-model flow). Per-topic temperature override is applied at spawn.
Single topic list drives both backend + UI.

**Anti-patterns.** Don't break `getModelForTopic` routing — additive only. Don't keep two
topic lists. Per-topic model refs are bound ids.

**Effort:** M. **Risk:** Low–Med (schema add + UI).

---

## Part B execution order

W7 (role-binding UI) and W10 (Topics page) are the two user-facing config wins —
do them first. W9 (lead/worker) depends on W10's per-topic config surface. W8 is the
architectural spine — design memo early (it informs W7's connector/MCP unification),
ship the safe `extensions/github` deletion now, stage the big refactor later.

Suggested: `feat/role-tool-binding-ui` → `feat/topics-page` → `feat/lead-worker-models`,
with `refactor/capability-model` memo in parallel + the `extensions/github` deletion as a
standalone tiny PR.

---

## Decisions — RESOLVED 2026-06-19

- **Phase 3:** ✅ One primitive — **recipes** on the pipeline engine; retire `pipeline_templates` as a user concept.
- **Phase 5 (MCP Apps):** ✅ Deferred — reuse existing artifacts, no new renderer.
- **Phase 6 (Ollama):** ✅ Do the polish (WS stream + un-gate setup recommend).
- **W7:** ✅ Role-bindable, incl. connectors/MCP — to keep each role's toolset minimal (don't flood agents).
- **W8:** ✅ Connectors/MCP = primary extension model; built-in = core only. GitHub stays built-in but moves to per-user vault token; delete unused `extensions/github`.
- **W9/W10:** ✅ Per-topic `executorModel`; empty = planner==executor (no-op). Planner spawns a swarm child as executor — reuse `spawn_child`, no intra-turn switching.

## Suggested first PRs

1. `chore/remove-unused-github-plugin` — delete `extensions/github` (tiny, safe, do now).
2. W8 design memo in `.octipus/` — capability-provider contract + connectors-as-primary migration path (gates W7's connector unification).
3. `feat/role-tool-binding-ui` (W7) → `feat/topics-page` (W10) → `feat/lead-worker-models` (W9).
4. Highest-ROI Goose items in parallel: `feat/toolshim-translator` (Phase 1), `feat/incremental-tool-output-compaction` (Phase 2).
