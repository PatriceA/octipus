# Agent Harness Refactor — QA 2026-07-03 root causes and plan

Source: QA run 2026-07-03 (sessions `1465ab5b` FIFA/orchestrator, `1f70f70a` chore-wars/codex+automation).
Every finding below was verified against the live agent event logs (via MCP) and traced to code.

**Update 2026-07-04:** four-agent code audit added — Gemini provider path, all API
providers, CLI pipeline, and pi-mono comparison. See Part 3. Headline: **flash-lite's
tool-calling failures are substantially octipus's fault** (Part 3.1) — the provider
integration sends unsanitized schemas, can't force function calling, corrupts replay
history, and misroutes truncated turns to the toolshim. Fix the provider path before
concluding any model "can't orchestrate".

**Custom-provider parity (2026-07-04, required):** there are TWO Gemini implementations
— the first-party `gemini-provider.ts` (OpenAI-compat endpoint) and the custom
`custom/gemini-compat-provider.ts` + `custom/gemini-envelope.ts` (native envelope, used
by user-configured Gemini endpoints). Every G-fix in Phase 1G must land in BOTH. The
schema sanitizer (`sanitizeSchemaForGemini`) stays a single source of truth extended once
and consumed by both paths; message hygiene, `toolChoice`/functionCallingConfig, thinking
budgets, thought_signature round-trip (incl. streaming), and the shared
`parseToolCallArguments`/AbortSignal/Retry-After helpers apply symmetrically. The
custom-compat providers (openai-compat, anthropic-compat, gemini-compat) also receive the
hoisted `sanitizeToolMessages` (A10) and AbortSignal threading (A9) — not just the
first-party providers. Rationale: a fix that only covers one Gemini flavour leaves the
other silently broken for anyone pointing octipus at a custom Gemini endpoint.

---

## Part 1 — Root causes (verified, file:line)

### 1.1 Orchestrator ran gemini-3.1-flash-lite instead of the deepseek default

The orchestrator's model comes from the **`chat` lane binding**, not from the default model
and not from the topic label:

- `src/core/orchestrator/model-selector.ts:17-56` `selectForOrchestration`:
  session `/model` override → **`getModelForTopic('chat')`** → `getDefaultModel()`.
  A bound `chat` lane short-circuits the default unconditionally.
- The `topic general` shown in the agent header is a hardcoded role constant
  (`src/core/orchestrator/roles/orchestrator/config.ts:10` `defaultTopic: 'general'`)
  — purely cosmetic, never consulted for model choice.
- Binding deepseek to `general` maps to the **`agents`** lane (`topics.ts:86` alias),
  which only workers read (`model-selector.ts:96-98`). The orchestrator ignores it.

So: the `chat` lane is bound to gemini-3.1-flash-lite; that wins. Working as coded,
but three UX/design defects make it a trap:

- The models page "default" implies it applies to the orchestrator. It doesn't when `chat` is bound.
- Topic label vs model lane are decoupled with zero UI indication.
- No capability floor: flash-lite failed native tool calling — its second `spawn_child`
  had id `call_shim_…` from `src/models/toolshim.ts:142`, i.e. a translator model
  reconstructed the tool call from prose. A model that needs the toolshim should never
  orchestrate. (`validateOrchestratorModel`, `model-selector.ts:63-91`, only rejects
  reasoners / models with `supportsTools=false` — flash-lite claims support and passes.)
  **Update 2026-07-04:** the audit (Part 3.1) shows `call_shim_…` events are frequently
  *integration* artifacts, not model incapacity — truncated/malformed turns are shimmed
  without checking `finishReason` (G5), schemas reach Gemini unsanitized (G2), and
  `tool_choice` can't be forced (G3). Fix those first; keep the shim-usage floor as a
  fallback signal only after the provider path is clean.

### 1.2 Orchestrator's useless final answer ("We have updated the summary…")

- `spawn_child` detaches; the orchestrator is expected to call `collect_children`.
  **In lite mode (small models) the tool surface is stripped to `spawn_child`+`remember_this`**
  (`meta-tools.ts:497-499`) — `collect_children` doesn't exist, so small orchestrators
  *always* fall into the auto-collect safety net.
- The auto-collect path truncates each child's output to **500 chars**
  (`src/core/agent-worker.ts:275-287`, slice at line 280) before asking the model to
  "synthesize". Two multi-thousand-char research summaries became two stubs → vague meta-answer.
  The explicit `collect_children` path does NOT truncate (`collect-tool.ts:93-107`) — the
  asymmetry is the bug.
- Nothing verifies the final answer carries the delegated results: `output-guard.ts`
  checks security patterns only. Relay is a soft prompt line (`roles/orchestrator/prompt.md:87`).

### 1.3 Chore-wars run: orchestrator "failed", spinners forever, children stopped

- Agent record `10ac5174`: `error: "Agent timeout exceeded (1800s / 1800s) during handleToolCalls"`.
  The orchestrator's global 1800s wall clock (`config/defaults.ts:87`) races against
  `handleToolCalls` (`agent-worker.ts:418-451`) **while it blocks on children** — the
  automation child ran 29m (a 375m-timeout `flutter build` inside), so the parent died
  and cascaded a stop.
- The stopped automation child (`cdb3c367`) got **no terminal event**: its event log has
  one `status_change` (running) and no `complete` — the UI spinner never resolves.
- Same session, overlapping mandates: the codex child produced a correct
  `android/key.properties` + keystore; the later automation child **overwrote it** with a
  broken one (`storeFile=/android/app/upload-keystore.jks`, absolute-wrong path,
  passwords printed in the transcript). No scoping, no file-conflict awareness between siblings.

### 1.4 "zsh zsh zsh … write_file" and eternal per-tool spinners (codex CLI)

- `src/core/cli-adapters.ts:591-634` `parseCodexEvent`: title = `detectToolFromCommand()`
  (`:175-187`) = first whitespace token of the command. Codex wraps every step in
  `zsh -lc '…'` → title `zsh`, 63 times. Any command containing `>` is titled `write_file` (`:184`).
- The real command IS carried in `args.command` and reaches the UI as `argsSummary`,
  but `web/components/chat/message-timeline.tsx:377-386` renders only `title || name`
  — `argsSummary` is never displayed (only the legacy `agent-activity-card.tsx` used it).
- `cli_tool_use` and `cli_tool_result` events carry **no id** (`cli-adapters.ts:617-654`);
  the web handler (`web/app/chat/page.tsx:986-1177`) has **no `cli_tool_result` branch at
  all** and never emits `tool_call_complete` for CLI agents. `statusDot()` defaults
  undefined status to a spinner (`message-timeline.tsx:366-370`) → every CLI tool row spins forever.
- Ollama path: pairing works via `toolCallId`, but `toolshim.ts:142` mints
  `call_shim_${Date.now()}` — two shim calls in the same ms collide → mis-paired rows.
- CLI agents report `totalTokens: 0` — no token accounting from codex usage events.

### 1.5 File-change log missing changes; file browser "file not found"

- Codex file changes are detected by regex on shell commands
  (`cli-adapters.ts:189-204`): only `cat >`, `sed -i`, `mkdir -p`, `rm`. That's exactly why
  the run showed 2 entries while codex's own final report lists ~12 changed files —
  codex's native `apply_patch` item types are silently dropped (`parseCodexEvent` handles
  only `command_execution` and `agent_message`, `:638-656`).
- Recorded paths are raw command-literal relatives, never resolved against the agent's cwd
  (`cli-adapters.ts:626-630`).
- **Workspace-root mismatch (highest-leverage bug):** the agent runs in the dev-mode
  project dir (`cli-agent-worker.ts:343-347` uses `sessionCtx.projectPath` →
  `/home/patrice/Github Rep/chore wars`), but every read-back surface pins to the per-user
  workspace root `./workspace` (`security/workspace-fs.ts:156-164` via
  `WorkspaceFS.forAgent({userId})`): file view/write `api/routes/sessions.ts:264,304`,
  changes list/diff `sessions.ts:346-348,374`. Result: file browser 404s, and
  `getWorkspaceChanges` runs git in `./workspace` (`session-changes.ts:79-99` →
  `isGitRepo:false`) so the Changes tab is blind for dev sessions.

### 1.6 Expert model override can't be cleared (422)

- UI sends `modelPreference: null` when "use the lane's model" is chosen
  (`web/app/experts/page.tsx:164-165, 234` — `v.modelPreference || null`).
- PATCH schema `src/api/routes/experts.ts:198` is `t.Optional(t.String())` — TypeBox
  `Optional` allows `undefined`, not `null` → 422. The handler (`:176`) and DB column
  (`db/schema/experts.ts:19` nullable) already handle `null` correctly once past validation.
  Same latent shape on POST (`:127`).

### 1.7 Expert "role" confusion

- `role` is a fixed 16-value enum (`swarm-tool.ts:26-43` `CHILD_ROLES_ENUM`,
  mirrored `web/lib/types/models.ts:115`) = tool bundle + base prompt + spawn_child routing key.
  `name` is the display label. Multiple experts per role is by design — the orchestrator
  disambiguates by name/description (`expert-index.ts:77-79`). The field reads like a
  duplicate title in the UI; the concept isn't explained. This is a UX problem plus a
  role-count problem (16 roles is too many; see 1.8).

### 1.8 "Why is an architect doing code changes?"

- `roles/architecture/config.ts:4` grants `['filesystem','shell','knowledge','task_state','websearch','repo_registry','mcp']`
  — full write filesystem + full shell, same surface as `coding` minus git.
  The "read + write docs only, hand off to coding" rule exists **only in the prompt**
  (`roles/architecture/prompt.md:1,6-7`). Prompt-only restrictions on write tools do not hold.
- Role selection is LLM-driven with a soft hint (classifier topic injected at
  `orchestrator-runner.ts:233`); any enum role is accepted for any task
  (`swarm-tool.ts:334-341` rejects unknown roles only). "Play Store submission" has no
  alias → the LLM picked `architecture` and nothing objected.
- Whether a child runs on a CLI harness (codex) vs an API/ollama model is purely a
  function of the model bound to the role's lane (`spawner.ts:902-1053`) — the
  orchestrator has no say and no awareness of the difference.

### 1.9 What we lost relative to pi (and what hermes does better)

Octipus uses only `@mariozechner/pi-tui` (rendering); the agent runtime is homegrown.
Compared to pi's runtime (`pi-agent-core` / `pi-coding-agent`):

- pi carries `toolCallId` on every `tool_execution_start/update/end` event; octipus's
  gateway/CLI envelopes dropped it (zero hits for `toolCallId` in `src/tui-pi`).
- pi's edit tool returns `details.diff` + `details.patch` (unified) per edit; octipus
  emits raw `newText` or shell regex guesses, and `/changes` re-shells `git diff` as plain text.
- pi persists a branchable JSONL transcript tree (`id`/`parentId`, compaction entries,
  `CustomEntry` vs `CustomMessageEntry`); octipus has a transient event stream.
- pi RPC mode is a ready-made orchestrator boundary (JSONL over stdio, ~25 id-correlated
  commands, `get_last_assistant_text`).
- hermes: iteration budget that exits with a work summary instead of dying; compaction
  that never splits a tool call/result pair; ordered parallel tool execution.

---

## Part 2 — Refactoring plan

Ordered by leverage. P1 items are independent small diffs (each shippable alone).

### Phase 0 — config, today, no code

- Bind deepseek-v4-flash to the **`chat`** lane on the Topics page (or clear the `chat`
  binding so the default applies). This alone fixes the orchestrator model.

### Phase 1 — correctness quick fixes (small diffs, ~1–2 days total)

1. **Experts 422**: `api/routes/experts.ts:198` (and `:127`) →
   `t.Optional(t.Union([t.String(), t.Null()]))`. One-line root-cause fix; UI already correct.
2. **Auto-collect truncation**: `agent-worker.ts:280` — raise the 500-char slice to a real
   budget (e.g. 8–16k chars per child, bounded by context) and make the synthesis message
   say "relay the content, do not summarize the fact that you have it".
   Add `collect_children` to the lite-mode tool surface (`meta-tools.ts:497-499`).
3. **Deterministic relay fallback**: after auto-collect, if the model's final answer is
   shorter than X% of collected child output and doesn't overlap it, **append the formatted
   child results verbatim** to the response instead of trusting a small model to relay.
   (Extend `output-guard.ts` or the fallback at `orchestrator-runner.ts:489-500`.)
4. **Codex adapter titles**: in `detectToolFromCommand`, unwrap `^\S*(zsh|bash|sh)\s+-l?c\s+`
   and title from the inner command (first token + capped args). Render `argsSummary` in
   `message-timeline.tsx` `ToolCallRow` as the secondary line.
5. **CLI tool pairing**: emit codex `item.id` as the event id on `cli_tool_use`/`cli_tool_result`;
   add a `cli_tool_result` branch in `web/app/chat/page.tsx` that flips the matching row's
   status (reuse the `tool_call_complete` shape). Never default a missing status to spinner
   once the agent itself is terminal — when `swarm.node_completed`/`complete` arrives,
   mark all still-pending rows as done/unknown.
   **Update 2026-07-04 — the web branch alone is insufficient (Part 3.4):** the Claude
   adapter never emits `cli_tool_result` at all (`parseClaudeEvent` ignores `type:"user"`
   tool_result blocks, which carry `tool_use_id` + `is_error` — parse them); and the codex
   result event hardcodes `toolName:'shell'` + puts output in `result` while the TUI reads
   `output` (`cli-adapters.ts:650`, `tui-pi/gateway-adapter.ts:319-320`). Both CLIs already
   provide stable ids (Claude `tool_use.id`, codex `item.id`) — octipus just discards them.
   Prefer mapping CLI results onto the existing rich `tool_call_complete` contract
   (`tool-executor.ts:427-439`) instead of growing the parallel `cli_*` vocabulary.
6. **Toolshim ids**: `toolshim.ts:142` → `call_shim_${crypto.randomUUID()}` (or counter).
7. **Terminal events on stop/cascade**: when a child is stopped (cascade or manual),
   emit `status_change: stopped` + a `complete`-shaped event with the stop reason so the
   UI and the orchestrator both finalize. (Emit from the spawner/agent-manager stop path.)
8. **Workspace root for read-back**: thread `sessionCtx.projectPath` (dev mode) into the
   session file/changes routes — `sessions.ts:264,304,346-348,374` must build
   `WorkspaceFS`/`getWorkspaceChanges` against the same root `cli-agent-worker.ts:343-347`
   computes. This single fix repairs the file browser 404s AND the blind Changes tab.
9. **file_change paths**: resolve against the agent's `workspaceCwd` before emitting
   (`cli-adapters.ts:626-630`); emit absolute (or root-relative + root id) paths.

### Phase 2 — orchestrator hardening (~1 week)

1. **Capability floor for orchestration**: extend `validateOrchestratorModel` to require
   *proven* native tool calling — track per-model shim usage (the toolshim already knows
   when it fires); if a model needed the shim in the last N calls, reroute orchestration to
   the default/first tool-reliable model and surface a warning in the UI. A model that
   can't emit tool calls natively must never orchestrate.
   **Update 2026-07-04:** land Phase 1G (Part 3.6) *before* this — today's shim counter
   would blame the model for provider bugs. The floor stays, but as the last line of
   defense, and shim-usage stats must reset after the Gemini-path fixes ship.
2. **Timeout budget that understands children**: stop charging detached-child wait time
   against the orchestrator's 1800s wall clock (the parent is idle-waiting, not stuck).
   Give children their own per-role timeout; on child overrun, return a structured
   `ChildResult status="timeout"` to the parent instead of killing the parent.
   The parent should end its turn with a partial-results answer, never a raw timeout error.
3. **Role consolidation (16 → ~6)**: the 16-role enum multiplies lanes, experts, and
   misrouting surface. Collapse to capability profiles, e.g.
   `research`, `write` (communication/pm/writing), `code` (coding/devops/automation/qa),
   `review` (review/security/architecture-as-advisor), `data` (data/ai/finance), `general`.
   Keep old names as aliases in `TOPIC_TO_ROLE_ALIAS` for compat. This follows the same
   consolidation already done for topics (#169/#171) — do it once, for roles too.
4. **Tool grants enforce the role contract**: advisory roles (architecture, review, pm)
   get read-only filesystem (add a `filesystem_ro` tool id or a `readOnly` flag on the
   grant) and no shell exec — writing is what `code` roles are for. Prompt text is not
   an access control.
5. **Sibling scope conflicts**: record per-child touched paths (from file_change events);
   when a second child's mandate overlaps a sibling's touched paths in the same session,
   include the sibling's file list + final report in its brief. Cheap version first:
   always inject "files already changed this session" into every child brief.
6. **Role-fit check**: before spawning, validate role choice against the classifier topic;
   if the task classifies `coding` and the LLM picked an advisory role, rewrite to `code`
   (log it). Deterministic guard beats prompt hints for small orchestrator models.

### Phase 3 — event/transcript layer, adopt pi patterns (~1–2 weeks)

1. **One typed tool-event schema for all executors** (built-in, CLI, MCP):
   `tool_execution_start/update/end`, each carrying `toolCallId`, `toolName`, typed
   `input`, and on `end` a typed `result` + `status`. Kill the parallel vocabularies
   (`cli_tool_use`/`cli_tool_result`/`tool_call`/`tool_call_complete`/`action`+data.type).
   The web UI keeps exactly one handler. Assert at agent end that every start has an end;
   synthesize a failed `end` for orphans.
2. **Per-edit unified patches**: the write/edit tools (and the codex adapter, from
   `apply_patch` items) emit `details.patch` (unified diff) per change. The Files/Changes
   tab renders from recorded patches; `git diff` in the correct repo root becomes the
   verification layer, not the only source.
3. **Parse codex natively**: handle all codex JSONL item types (`apply_patch`, `mcp_tool_call`,
   usage/tokens) in `parseCodexEvent`; wire token usage into `totalTokens` so CLI runs stop
   reporting 0.
4. **JSONL transcript per agent** with `id`/`parentId` entries (message, tool call/result,
   model change, compaction, child spawn/result) — replay/resume/audit for free, and the
   MCP `get_agent_events` output becomes the same file. pi's session-format.md is the
   template.
5. **Iteration budget graceful exit** (hermes): at maxIterations/timeout, run one final
   no-tools turn: "summarize what you did and what remains" — never end a worker with a
   bare error string.

### Phase 4 — coding-agent strategy (decide, then ~1 week)

The codex child actually did excellent work (its final report listed every change,
correctly). The failure was **visibility and orchestration**, not capability. So:

1. **Route `code` role to a CLI harness by default** (codex or claude); local ollama models
   are for cheap non-code roles. The qwen3.5:9b automation run (29m, 51 iterations,
   broke a sibling's work, hallucinated keystore config) is the argument.
2. **Consider pi RPC as the coding-agent boundary**: instead of scraping codex JSONL with
   regexes, run `pi` (already in the family — pi-tui is a dependency) in RPC mode as the
   coding executor: id-correlated commands, typed event stream, per-edit patches,
   `get_last_assistant_text` for the structured final. Keep the codex adapter, but the
   contract both must satisfy is the Phase-3 event schema. Evaluate with one spike:
   same chore-wars task via pi RPC vs current codex adapter, compare event fidelity.
3. **Verification step for coding children**: after a `code` child completes, run a cheap
   deterministic check in its workspace (git status + diff summary + optionally
   build/lint command from repo config) and attach it to the ChildResult so the
   orchestrator/user sees *evidence*, not claims.

### Expert/role UX (parallel, small)

- Rename the field in the UI: "Specialist type (tool bundle)" with the 16 (later ~6)
  options and one line of explanation; show the resolved lane + effective model next to
  the override dropdown ("Override: — using lane `writing` → deepseek-v4-flash").
- Models page: show which lane the orchestrator reads (`chat`) and the effective
  orchestrator model right on the page; a "default model" that is silently outranked by
  a lane binding must say so.

### Test/QA gates to add with the fixes

- Unit: codex adapter fixture replay (real JSONL from run `d602903f`) → assert titles,
  ids, pairing, file_change count and absolute paths.
- Unit: auto-collect with two 5k-char child outputs → final message contains ≥N chars of
  each child's content.
- Unit: experts PATCH with `modelPreference: null` → 200 and cleared.
- E2E (existing swarm suite): orchestrator turn with detached child → final answer
  contains child output; stopped child → terminal event present; dev-mode session →
  `/files` and `/changes` resolve against projectPath.

---

## Part 3 — Provider & CLI audit (2026-07-04)

Four parallel audits: (a) octipus Gemini call path, (b) pi-mono's Gemini provider,
(c) all remaining octipus API providers + registry/failover, (d) CLI pipeline in both
repos. Load-bearing claims spot-verified against source. Goal: **gemini flash-lite must
work as orchestrator** — it is big enough; the integration is what's broken.

### 3.1 Gemini path — confirmed bugs (why flash-lite "can't tool call")

Call path: orchestrator → `agent-worker.ts:1320-1326` → `GeminiProvider.complete()`
(OpenAI-compat endpoint, `gemini-provider.ts:12`). Streaming is unused for agent tool
calls. The toolshim engages only after a *successful* completion returned prose
(`agent-worker.ts:815-829`) — so every `call_shim_…` means the API call worked and the
integration or the prompt produced prose.

- **G1 — `providerRaw` replay undoes `sanitizeMessages`** (`gemini-provider.ts:53-70`):
  `keptCalls` filters tool calls to those with responses, but `{ ...msg }` preserves
  `providerRaw`, and `formatMessagesRaw` (`:198-201`) sends `providerRaw` verbatim —
  including the dropped calls. That recreates the exact "function_call not followed by
  function_response" 400 the sanitizer exists to prevent. Fix: when
  `keptCalls.length !== msg.toolCalls.length`, strip or filter `providerRaw`.
- **G2 — tool schemas sent unsanitized** (`gemini-provider.ts:103,253`): MCP/meta-tool
  JSON schemas (`$schema`, `additionalProperties`, `oneOf/anyOf`, `default`) go in raw.
  A correct sanitizer already exists (`sanitizeSchemaForGemini`,
  `gemini-envelope.ts:139-176`) but is wired only into the custom-gemini provider
  (`:188`). The compat layer silently mangles unsupported keywords → degraded schemas →
  prose instead of tool calls. Fix: run every `t.function.parameters` through the
  sanitizer in `GeminiProvider` (and extend it per P42 below).
- **G3 — `tool_choice` hardcoded `'auto'`** (`gemini-provider.ts:104,254`;
  `litellm-client.ts:354`): `CompletionOptions` has no `toolChoice` field, so an
  orchestrator that *must* call tools can't request `required`/`ANY`. For a small model
  this is the single biggest "prose instead of tool call" lever. Fix: add
  `toolChoice?: 'auto'|'required'` to `CompletionOptions`, map per provider.
- **G4 — unguarded `JSON.parse` of tool args** (`gemini-provider.ts:167-168`): empty or
  truncated arguments throw raw `SyntaxError`; the litellm path repairs
  (`repairTruncatedJson`, `litellm-client.ts:440-463`), the Gemini path doesn't. Fix:
  replicate the guard (empty → `{}`, repair, then ClassifiedError).
- **G5 — shim fires without checking `finishReason`** (`agent-worker.ts:815-829`): a
  `length`-truncated turn or MALFORMED_FUNCTION_CALL surfaced as prose goes to the
  toolshim instead of a native retry. This is the mechanism that produces `call_shim_…`
  for capable models. Fix: on `finishReason !== 'stop'|'tool_calls'`, retry (optionally
  with more maxTokens) before shimming.
- **G6 — `temperature: model.defaultTemperature || 0.7`** (`agent-worker.ts:1307`):
  a configured 0 becomes 0.7; high temperature measurably hurts small-model tool-call
  fidelity. Fix: `??`.
- **G7 — streaming loses `thought_signature`** (`gemini-provider.ts:234-304`): latent
  today (agents use `complete()`), but any streamed Gemini 3 tool call can't round-trip
  its signature → 400/degradation next turn.

Risks: empty tool-call ids trusted (`:165,283` — empty id → the whole tool round gets
silently stripped by sanitizeMessages → model repeats the call; synthesize `call_${idx}`
like `gemini-compat-provider.ts:163`); no thinkingConfig control — flash thinking can eat
the whole 4096 maxTokens → empty content → nudge loop (`agent-worker.ts:868-887`); no
provider-level retry or caller abort on `complete()` (`:119-124`); `responseFormat`
silently dropped (`:108,258`); stale capability metadata (`capabilities.ts:54-56`
`systemRole:false` contradicts the provider sending native system role); shim-recovered
turns create signature-less assistant history that can poison subsequent native calls
(`agent-worker.ts:1225` → warn at `gemini-provider.ts:206-209`) — one shim event
compounds the symptom.

### 3.2 What pi-mono does for Gemini (adopt these)

All in `pi-mono/packages/ai/src/providers/` (google.ts / google-shared.ts):

1. **`parametersJsonSchema` instead of `parameters`** (`google-shared.ts:272-288`) —
   Gemini's field that accepts full JSON Schema unmodified; sidesteps schema
   lobotomization entirely. Only the legacy path strips meta keys (`$schema`, `$defs`,
   …, `:237-262`). *Applies to the native API; on the compat endpoint G2's sanitizer is
   the equivalent.*
2. **History hygiene over retries** — pi has *no* in-provider retry for
   MALFORMED_FUNCTION_CALL; instead: empty text/thinking parts filtered
   (`google-shared.ts:134,142`), orphaned tool calls repaired with synthetic
   `"No result provided"` results (`transform-messages.ts:155-218`), errored/aborted
   assistant turns dropped from replay (`:186-194`). Dirty history is the primary cause
   of Gemini tool-calling 400s/degradation.
3. **thoughtSignature round-trip with strict validation** (`google-shared.ts:51-65`):
   captured off `functionCall` parts, re-attached only for same provider+model and only
   if valid base64; never faked; deleted on cross-model handoff
   (`transform-messages.ts:128-131`).
4. **Gemini quirks normalized**: `stopReason` forced to `toolUse` whenever toolCall
   blocks exist — Gemini reports `STOP` for tool turns (`google.ts:205-210`); ids
   omitted toward Gemini (matching is name+position), unique internal ids synthesized
   with a monotonic counter (`google.ts:176-182`); consecutive functionResponses merged
   into one user turn (`google-shared.ts:213-222`); exhaustive finishReason mapping with
   compile-time `never` check (`google-shared.ts:309-336`).
5. **Per-tier thinking config** (`google.ts:410-501`): Gemini 3 uses `thinkingLevel`
   (`thinkingBudget: 0` is an error there); flash-lite's minimal budget is 512, not 128;
   Gemini 3 Pro can't disable thinking. Wrong thinking config silently destroys
   flash-lite tool emission — the budget burns instead of the call.
6. **Unicode sanitization** (`utils/sanitize-unicode.ts:22-26`): unpaired UTF-16
   surrogates stripped from all text/system/tool-result content — otherwise binary-ish
   tool output kills the request at JSON serialization.

### 3.3 Cross-provider audit — top priorities

Condensed; severities per the 2026-07-04 audit. The ones that bite now:

- **A1 — litellm thought-strip eats valid JSON** (`litellm-client.ts:374-382`): the
  JSON-style regex deletes `{"thought":…}` substrings wholesale, and any response
  *starting* `{"thought":` is blanked to `''` — exactly the shape a JSON-mode/ReAct
  orchestration asks a small model to produce. Skip stripping when
  `responseFormat: json_object`; anchor to whole-content matches. *(verified)*
- **A2 — stream routing broken twice** (`litellm-client.ts:498` heuristic
  `getProvider()` instead of DB-first `resolveProvider()`; `:495-509` catch swallows
  mid-stream errors and silently re-streams via proxy → duplicated partial output;
  `providers/index.ts:281` stream fallback condition is the inverse of complete()'s
  `canFallbackToLiteLLM`). *(index.ts:281 verified)*
- **A3 — circuit breaker opens on model-output errors** (`providers/index.ts:240-243`):
  `recordFailure` fires for TOOL_CALL_INVALID etc.; one flaky small model emitting bad
  JSON 5× opens the circuit for the whole provider lane for 30s+. Skip breaker recording
  for non-transport ClassifiedErrors. Small-model killer.
- **A4 — custom OpenAI-compat provider auth is dead** (`custom/openai-compat-provider.ts:202-210`):
  `buildHeaders()` never called → `auth.type: 'header'|'query'` endpoints always get
  Bearer → 401; `pathOverride` ignored and `/v1` double-appended (`:25` vs `:204`).
- **A5 — custom-gemini streaming yields nothing** (`gemini-compat-provider.ts:141-144`):
  `:streamGenerateContent` without `?alt=sse`, but the parser only accepts SSE lines.
- **A6 — empty-`arguments` tool calls throw in all 8 OpenAI-style parsers**
  (anthropic:92, openai:88, deepseek:150, grok:87, mistral:121, ollama:199,
  openrouter:93, litellm-client:440): `JSON.parse('')` on zero-arg tool calls. The 8-way
  copy-paste of the parse/repair block is the underlying smell — extract one shared
  helper (also fixes mistral's missing truncation repair, `mistral-provider.ts:117-134`).
- **A7 — stale `model:mid` cache defeats provider/endpoint edits**
  (`model-registry.ts:356-369`): `invalidateCache` never deletes `model:mid:*` keys that
  feed `resolveProvider()` — a changed provider/apiKeyRef keeps routing to the old
  target for up to 5 min.
- **A8 — Ollama shadows cloud models** (`ollama-provider.ts:113-120` + registration
  order `providers/index.ts:101-110`): `mistral-*`, `grok-*`, `o4-mini` etc. missing
  from CLOUD_PREFIXES → heuristic routing sends them to local Ollama → 404.
- **A9 — no cancellation anywhere** (`interface.ts:15-18`): no `AbortSignal` in
  `CompletionOptions`; `AgentWorker.stop()` can't cancel in-flight requests (30-min
  DeepSeek / 60-min Grok timeouts run to completion after the caller gave up).
- **A10 — tool-message pairing enforced only on the litellm path**
  (`litellm-client.ts:136-181` `sanitizeToolMessages`): every direct provider formatter
  lacks it (`tool_call_id || ''` in anthropic:276, deepseek:349, grok:270,
  openrouter:321; `|| 'call_0'` in anthropic-compat:231 collapses parallel results).
  Hoist once into `transformMessagesForProvider`.

Notable singles (fix as touched): OpenAI o-series/gpt-5 get `max_tokens`+`temperature`
they reject (`openai-provider.ts:16-17,37-46`; prefixes miss `o4-`, `:16`); ollama
stream() promotes `reasoning` deltas into `content`, contradicting complete()'s
deliberate separation (`ollama-provider.ts:427-432`); ollama-native ids `call_0..n`
collide across turns (`:350-354,580`); mistral requires exactly-9-alphanumeric tool ids
— replayed cross-provider ids 400 (`mistral-provider.ts:314-350`), and it sends
non-standard `reasoning_content` on assistant messages (`:337,345-347`); deepseek stream
drops `reasoning_content` (breaks reasoner round-trip) and skips template-leak detection
(`deepseek-provider.ts:204-269,238-268`); `<think>` stream filter breaks on chunk-split
tags and an unclosed tag swallows the rest of the stream (`litellm-client.ts:553-589`);
`message-transform.ts:61` gates thinking-strip on an unrelated idMap condition so it
~never runs for non-anthropic; voyage fetches have no timeout (`voyage-provider.ts:57-68`);
anthropic/gemini-compat 180s *total-duration* abort kills long streams mid-tool-call
(`anthropic-compat-provider.ts:87`, `gemini-compat:80`); gemini-compat reports `stop`
instead of `tool_calls` on function-call turns (`:170-180,220-227`) and drops
thought_signature when streaming (`:188-192`); `parseToolContent` scalar results 400
(`gemini-envelope.ts:120-123`); empty text blocks sent to Anthropic-compat 400
(`anthropic-compat-provider.ts:256`); no Retry-After handling in any direct-fetch
provider; `usage.cacheReadTokens/cacheCreationTokens` never populated
(`litellm-client.ts:58-59`).

### 3.4 CLI pipeline — additional findings (beyond 1.4/1.5)

All Part-1 line numbers verified still current. New, by severity:

**High**
- **C1 — Claude adapter emits no tool results at all**: `parseClaudeEvent`
  (`cli-adapters.ts:495-589`) ignores `type:"user"` events, which carry the tool_result
  blocks (`tool_use_id`, content, `is_error`). P1.5's web fix is useless for Claude
  until these are parsed.
- **C2 — codex adapter handles only `command_execution` + `agent_message`**
  (`:610-634`): native `file_change` items (the structured apply_patch output — the
  direct fix for 1.5), `mcp_tool_call`, `web_search`, `error`, `turn.failed` are all
  dropped. Codex errors vanish silently.
- **C3 — Claude `result.subtype`/`is_error` ignored** (`:555-585`):
  `error_max_turns`/`error_during_execution` are reported as success.
- **C4 — non-zero exit with partial output = success** (`cli-agent-worker.ts:589`):
  rejects only if no text accumulated; stderr is never surfaced anywhere.
- **C5 — async `close` handler can hang the agent forever** (`:533,596-602`): un-caught
  DB error in the handler → `executeCLI` promise never settles → agent stuck "running".
- **C6 — child inherits full server env** (`:452-453`): DB creds + API keys exposed to
  a subprocess running with `bypassPermissions`/`--dangerously-skip-permissions`.

**Medium**
- **C7 — SIGKILL escalation is dead code** (`:227-231`): `ChildProcess.killed` is true
  the moment SIGTERM is *sent*; the escalation branch can never fire — a
  SIGTERM-ignoring CLI leaks.
- **C8 — two timeout mechanisms, divergent errors** (`:459` spawn timeout vs `:479-491`
  hardTimeout): spawn-timeout-first surfaces as "exited with code null" (or as success
  per C4) instead of "timed out".
- **C9 — codex start/result field mismatch** (`:615-617` vs `:650`): result hardcodes
  `toolName:'shell'` and uses `result` where the TUI reads `output`
  (`tui-pi/gateway-adapter.ts:319-320`) — start/end can't correlate even where results
  ARE handled.
- **C10 — Claude file changes cover only Write/Edit** (`:528`): MultiEdit,
  NotebookEdit, and Bash writes invisible; `detectFileChangeFromCommand` runs only for
  codex (`:624`).
- **C11 — `detectToolFromCommand` false positives** (`:184-186`): `2>/dev/null`,
  `->`, `>&2` all title the row `write_file`; `rm -r -f x` captures the flag as path
  (`:201`); paths with spaces break every regex.
- **C12 — cwd failure falls back to `process.cwd()`** (`:348-350`): a write-enabled CLI
  agent can end up running inside the octipus server repo itself.
- **C13 — secrets hygiene**: MCP config with `OCTIPUS_API_KEY` written 0644 to shared
  tmp (`cli-adapters.ts:98-99`), reused stale up to 1h across token/port rotation
  (`:77-79`); full prompt dumps accumulate unboundedly in `~/.octipus/prompts`
  (`cli-agent-worker.ts:365-390`); AGENTS.md backup/restore race between concurrent
  agents in one cwd (`:394-423`) — last restorer wins, can clobber the user's real file.
- **C14 — permissionMode semantics fork** (`cli-adapters.ts:312` claude
  `bypassPermissions` vs `:431,437` codex `--sandbox workspace-write`): a claude-style
  value on a codex row is an invalid arg → exit 1 before doing anything.

**Low**: stdin EPIPE unhandled (`cli-agent-worker.ts:464-466`); stop destroys the
stream before kill so final stats are lost and abort resolves as soft success
(`:212-214,578-580`); agy/vibe have `bufferOutput:true` → zero events/iterations/tokens
(`cli-provider.ts:139,279` — vibe's JSON does contain `tool_calls` that could be
post-parsed); per-line JSONL parse failures logged at debug with no counter — a CLI
version banner silently degrades to "(no response)"; `execCli` one-shot path repeats
the issues in miniature (no cwd, unbounded buffers, `maxTokens*100`ms timeout heuristic,
`shell:true` on Windows contradicting agy's no-shell rule, `cli-provider.ts:465-499`).

**Iteration / token tracking (the "show tool calls in iterations" ask)**
- **C15 — three unsynchronized iteration counters**: server increments per tool event
  (`cli-agent-worker.ts:314-321`, bridged as `agent.iteration` for the TUI but ignored
  by web), web chat independently re-counts `cli_tool_use` (`page.tsx:1031`), DB
  `iterations` written only at completion (`:159-163`) so mid-run restores read 0.
  Claude's real `num_turns` arrives in `result` stats and goes nowhere. "Iteration"
  currently means "tool-call count", not turns.
- **C16 — token budget enforcement is post-hoc**: `onTokenUsage` fires only on Claude's
  final `result` / codex's final `turn.completed` (`cli-adapters.ts:583,677`); the
  budget-kill (`cli-agent-worker.ts:322-333`) can only trigger after the run is over.
- **C17 — web `cli_tool_use` drops tools for untracked agents** (`page.tsx:1026-1038`,
  no stub unlike `:1114-1131`); ids are `Date.now().toString()` (`:1033`) — same-ms
  collisions; duplicate file_change entries (adapter event + web re-derivation via
  `CLI_FILE_TOOL_MAP`, `:1040-1075`, which still maps extinct gemini-cli tool names).
- **C18 — totalTokens 0 root cause confirmed** (`cli-provider.ts:79`): total sums
  top-level `data.input_tokens/output_tokens` while input/output read nested
  `data.usage.*` — nested-usage payloads yield nonzero parts, zero total.

### 3.5 pi agent/RPC contract (the adoption target — validates Phase 3/4)

Protocol docs exist and are accurate: `packages/coding-agent/docs/rpc.md`,
`docs/session-format.md`.

- **Event schema** (`packages/agent/src/types.ts:374-389`): `agent_start/end`,
  `turn_start/end{message, toolResults}`, `message_start/update/end`, and
  `tool_execution_start/update/end` — every tool event carries `toolCallId` + `toolName`;
  `end` carries `result` + `isError`; `update` carries the *accumulated* partial result
  (clients replace, not append). Errors are data, not stream breaks:
  `stopReason: "error"|"aborted"` + `errorMessage` on the message.
- **RPC mode** (`pi --mode rpc`, strict JSONL over stdio, `rpc-types.ts:19-206`): ~28
  commands with echoed correlation `id` (`prompt` with
  `streamingBehavior: steer|followUp`, `steer`, `abort`, `set_model`, `compact`,
  `get_session_stats`, `fork`, …); host writes a command, gets the ack, consumes events
  until `agent_end`. Reverse-RPC for interactive UI prompts.
- **Per-edit diffs**: generated inside the edit tool (`edit-diff.ts:266-388`), ride
  `tool_execution_end.result.details.diff` and persist in the session JSONL
  automatically. (Line-numbered custom format, not @@-hunks.)
- **Usage**: every assistant message carries
  `usage{input, output, cacheRead, cacheWrite, totalTokens, cost{...}}` — per-turn usage
  on the wire for free; session aggregate via `get_session_stats`.
- **Session JSONL**: header + tree-structured entries (`id`/`parentId`), enabling
  in-file forking and cold replay identical to the live stream — the property octipus's
  REST restore path is missing.

### 3.6 Plan amendments from the audit

**New Phase 1G — Gemini/provider correctness (do before Phase 2.1; ~2-3 days).**
This is the actual "make flash-lite orchestrate" work:

1. G3: `toolChoice` in `CompletionOptions` + per-provider mapping; the orchestrator
   requests `required` when it must delegate.
2. G2: wire `sanitizeSchemaForGemini` into `GeminiProvider`; extend it to strip
   `$ref`/`oneOf`/`$schema` (`gemini-envelope.ts:139-176` currently only strips
   `default`/`additionalProperties`).
3. G1: strip/filter `providerRaw` when sanitizeMessages drops calls.
4. G5: check `finishReason` before text-recovery/shim; retry `length`/malformed
   natively first.
5. G4 + A6: one shared tool-args parse/repair helper (empty → `{}`,
   `repairTruncatedJson`, ClassifiedError) used by all providers.
6. G6: `??` instead of `||` for temperature/maxTokens defaults.
7. Thinking budget for the Gemini flash tier (pi's table: flash-lite minimal = 512;
   never `thinkingBudget: 0` on Gemini 3) + raise orchestrator maxTokens so thinking
   can't starve the tool call.
8. Adopt pi history hygiene in `GeminiProvider.sanitizeMessages`: filter empty content,
   synthesize error-results for orphaned calls (instead of dropping whole rounds on
   empty ids), drop errored partial turns; synthesize `call_${idx}` ids when the API
   returns none.
9. A1: fix litellm thought-strip (skip under json_object, anchor whole-content).
10. Toolshim ids → `crypto.randomUUID()` (was P1.6; fold in here).

Acceptance: flash-lite as orchestrator completes the FIFA-session scenario with zero
`call_shim_…` events across 10 runs; conformance test replays a recorded flash-lite
multi-turn tool history through `formatMessagesRaw` and asserts no orphaned
`tool_calls` reach the wire.

**New Phase 1P — provider robustness quick wins (independent, parallelizable):**
A2 (stream routing + no silent proxy re-stream), A3 (breaker ignores model-output
errors), A4 (custom auth/pathOverride), A5 (`alt=sse`), A7 (`model:mid` invalidation),
A8 (CLOUD_PREFIXES), A10 (hoist `sanitizeToolMessages` into
`transformMessagesForProvider`), A9 (thread `AbortSignal` through `CompletionOptions`
— prerequisite for Phase 2.2's timeout work).

**Phase 1 CLI amendments:** P1.5 now includes C1 (parse Claude `type:"user"`) and C9
(codex field unification); P1.4 includes C11; add C3+C4 (error results reported as
success), C5 (hanging close handler), C7 (kill escalation via PID-alive check or
protocol abort), C18 (totalTokens). C6/C12/C13 (env leakage, cwd fallback, secrets
hygiene) become a small security PR of their own — do not widen CLI-agent exposure
before C6.

**Phase 3 amendments:** the typed tool-event schema (3.1) should be pi's shape —
`tool_execution_start/update/end` with `toolCallId` — but mapped onto the *existing*
rich `tool_call`/`tool_call_complete` contract the web already renders
(`tool-executor.ts:427-439`) rather than a third vocabulary. C15's fix folds in: emit
turn events from codex `turn.started/completed` and Claude `num_turns`, server as the
single iteration source, delete the web re-count (`page.tsx:1031`). Per-turn usage
events (pi's model) replace final-only accounting (C16), which also makes the CLI
budget-kill able to fire mid-run.

**Phase 4 amendments:** pi RPC mode is confirmed real and documented (28 commands,
steer/abort mid-run, per-edit diffs, per-turn usage) — the spike is worth pulling
earlier; protocol-level abort also cleanly fixes C7. Nearest-term alternative: drive
`claude -p --input-format stream-json` / codex proto as persistent sessions instead of
one-shot spawns.

---

## Suggested order of execution (superseded — see revised table below)

| Step | Items | Size |
|------|-------|------|
| Now | Phase 0 config; P1.1 (422) | minutes |
| PR 1 | P1.2 + P1.3 (relay) with tests | S |
| PR 2 | P1.8 + P1.9 (workspace root + paths) with tests | S |
| PR 3 | P1.4–P1.7 (CLI events + UI) with fixture test | M |
| PR 4 | Phase 2.1 + 2.2 (capability floor, timeout budget) | M |
| PR 5 | Phase 2.3–2.6 (roles, grants, scope) | M–L |
| PR 6+ | Phase 3 event schema → patches → transcript | L (staged) |
| Spike | Phase 4.2 pi-RPC vs codex adapter comparison | S |

## Revised order of execution (2026-07-04, incl. Part 3)

| Step | Items | Size |
|------|-------|------|
| Now | Phase 0 config; P1.1 (422) | minutes |
| PR 1 | **Phase 1G — Gemini/flash-lite orchestration fixes** + conformance test | M |
| PR 2 | P1.2 + P1.3 (relay) with tests | S |
| PR 3 | P1.8 + P1.9 (workspace root + paths) with tests | S |
| PR 4 | P1.4–P1.7 + C1/C3/C4/C9/C18 (CLI events + UI) with fixture test | M |
| PR 5 | **Phase 1P — provider robustness (A2–A10)** | M |
| PR 6 | **CLI security/stability: C5/C6/C7/C12/C13** | S |
| PR 7 | Phase 2.1 + 2.2 (capability floor, timeout budget — needs A9) | M |
| PR 8 | Phase 2.3–2.6 (roles, grants, scope) | M–L |
| PR 9+ | Phase 3 event schema (pi shape on existing tool_call_complete contract) → patches → transcript | L (staged) |
| Spike | Phase 4.2 pi-RPC vs codex adapter — pull earlier if PR 4 fights the codex JSONL | S |

Rationale for PR 1 first: the QA conclusion "flash-lite can't orchestrate" is
unproven until G1–G8 are fixed — the capability floor (Phase 2.1) must not be
calibrated against a broken provider path.
