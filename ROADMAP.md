# Roadmap

> **Note.** Directions, not promises. Items move, get reshaped, or get dropped as the project learns. If something here is interesting, open an issue and let's talk before you build.

This doc lists what we are exploring. Order inside each section is rough priority, not strict sequencing. PRs welcome on anything marked **Help wanted**.

---

## Now (in flight)

- **Mock-provider scaffold for the model layer.** `src/models/litellm-client.ts`
  (772 lines) and `src/models/providers/index.ts` are at 0% coverage
  because they front network IO; meaningful unit tests need a mock
  provider that speaks the provider interface (complete / embed /
  stream / error classes), records calls, and returns scripted
  responses. Once it lands, the existing test files for capability
  routing, cost tracking, rate limiting, and provider discovery
  can finally assert on what the client actually does. **Help wanted.**

- **Memory-aware eval harness.** `eval/*.yaml` runs against
  `classifyMessage` (unit mode) or the running backend (integration
  mode); neither shape can pre-seed the `memories` table or assert
  that a response surfaces a known fact. The harness needs a per-test
  setup hook (`memorySetup: [{ factType, content, agentScope }]`)
  and a new assertion type (`recalls_memory`). Without it, the
  memory-redesign Phase D extractor + judge + retrieval pipeline
  has integration-test coverage on the data layer only.

- **Live Artifacts — BETA.** `src/core/artifacts/`, `/api/artifacts`,
  `web/app/artifacts/`, and the `create_live_artifact` meta-tool are
  live behind a BETA flag in the sidebar and on the page header.
  Outstanding work: subdomain hosting hardening (host header /
  CSP origin sandboxing), embed-mode auth scopes, retention &
  garbage-collection policy, slug-collision UX, agent-authored
  refresh loop. Stays in **Now** until the BETA flag drops.

- **Schema directory grouping.** `src/db/schema/` is 47 flat files.
  Still searchable, but the next 5-10 additions will start to bite.
  Proposed grouping: `schema/{auth,orchestration,rag,memory,artifacts,audit,settings}/`.
  Non-breaking — `index.ts` re-exports preserve the import surface.
  Worth doing once memory + artifacts each grow another 2-3 tables;
  not before.

## Next (months)

- **TUI — remaining items.**
  - Mouse wheel scrolling once pi-tui exposes mouse APIs upstream.
    The messages pane already exposes `scrollUp/scrollDown`;
    wiring is a one-line change.

- **Compaction — branch summarization.** The structured summary format
  (cumulative file-op tracker, iterative summary chaining via
  `firstKeptEntryId` walk-back, `/compact <instructions>` pass-through) shipped
  on the existing `CompactionState` + `compaction_entries` table. Still open:
  branch summarization for `/tree`-style navigation (paired with the
  session-as-tree item under **Later**).

- **RPC stdio adapter for the gateway.** Today gateway is WS-only. Add a
  second `GatewayAdapter` that speaks strict-LF JSONL over stdin/stdout with
  the same typed protocol (`prompt` / `steer` / `followUp` /
  `streamingBehavior`, request-id correlation). Unlocks IDE / CI / subprocess
  embedding without a WS server. Mirrors pi-mono's `--mode rpc`.

- **Per-tool `executionMode` override.** Today meta-tools all run through the
  orchestrator with global concurrency. Add `executionMode: "sequential"` on
  the tool definition itself for tools with shared-state hazards
  (`spawn_worker`, `create_pipeline`, swarm `spawn_child`). Pi's pattern;
  small change to `BaseTool` + the orchestrator dispatch path.

- **Skill auto-extension — promotion path.** The pattern detector, cache,
  `skill_proposals` table, `/api/skills/proposals` API, and
  `/skills/proposals` web page landed. The
  [2026-05-24 curator land](#2026-05-24--orchestrator-freedom--hermes-skill-curator)
  added the lifecycle backbone (`last_used_at`, `usage_count`,
  `archived_at`, `curation_notes`, debounced usage tracker,
  `runSkillCurator` auto-archive after 90d / flag after 30d). What's
  still next on this item: tighten the proposal review UI (diff
  preview of generated prompt, one-click promote to `skills` table,
  rejection-suppression timers visible, user-scoped opt-out toggle).

- **Trajectory learning — consumers.** Recorder + JSONL + compress +
  `trajectory_runs` pointer table + `/api/trajectories` are live. Next:
  a reader that turns trajectories into labeled training pairs for
  offline eval / fine-tune pipelines. Opt-out env `TRAJECTORY_LOGGING=false`
  already wired.

- **Dynamic role definition from the chat.** "Define a role that does X with tools Y" → orchestrator writes the three node-folder files, hot-reloads, and uses the new role on the next message.

- **Skill marketplace.** Export/import skills as signed JSON. Discover and install community skills from the web UI.

- **Pipeline templates from natural language.** Describe a multi-stage workflow, get a pipeline definition you can run, edit, and save.

- **Better human-in-the-loop.** First-class "wait for human input" node with form schema + replay across restarts. Today this works through approval gates; we want it to be a primitive any role can call.

- **Expert sessions with persistent threads.** Pin an expert to a thread; messages in that thread always go to it (per-channel). Today `/expert` is per-session.

- **Mobile clients.** Native iOS/Android via the gateway protocol. Today the web UI is responsive but not installable.

## Later (open directions)

- **Federation.** Multiple octipus instances coordinating — your home octipus talks to your work octipus talks to a friend's octipus, with explicit consent and audit trails.
- **Local-first sync.** PGlite + CRDTs for cross-device session continuity without a central server.
- **Voice as a first-class channel.** Today STT/TTS works through the gateway; we want full duplex voice with interruption handling and emotion-aware routing.
- **Sandboxed tool execution.** Today shell/code tools run in the same process. We want WASI / lightweight VM isolation per worker.
- **Plugin signing & permissions.** Today plugins in `extensions/` run with full host trust. Capability declarations + signature verification.
- **Cost-aware routing.** Router considers per-provider cost in addition to capability. Already partial; we want it tunable per user.
- **Embedded eval-driven prompt iteration.** Edit a role prompt in the UI, run the eval suite, see the diff in metrics, accept or revert. Closes the loop on prompt engineering.
- **Session-as-tree (fork/branch-aware sessions).** Today messages are a linear PG sequence per session. Add `parentId` on messages and a `/tree` navigation command so users can fork from any point, edit, and replay. Pi-mono's session v3. Defer until a real fork UX is on the table — linear is fine while it isn't.
- **Richer TUI editor (replace Ink `<TextInput>`).** Today the TUI input is a single-line Ink box with file-path completion. A real editor — multi-line, kill ring, undo/redo, kitty-keyboard protocol, stacked autocomplete providers (e.g. `#1234` GitHub issues + `@file` paths) — would close the gap with the web UI editor. Pi-mono's `editor.ts` (2231 lines) and `keybindings.ts` (TS-declaration-merging registry with conflict detection) are the reference. Big lift; only worth it if the TUI becomes a primary surface.

## Done (recent)

### 2026-07-01 — Refactor + changes review + roadmap sweep

- **Core file refactor (PR #167).** Split the four largest logic-heavy files
  into focused modules — routes delegate to a `src/services/` layer; swarm
  budget/validation/cache, the detached-child manager, and the tool-loop
  detector are their own units. Pure refactor, public APIs preserved. See
  [`CHANGELOG.md`](CHANGELOG.md#core-file-refactor-2026-07-01-pr-167).
- **Session changes review — `/changes`.** Git-backed view of every file an
  agent touched in a session, in the web **Changes** tab and the TUI.
- **Orchestrator detach — activated by default.** `maxPendingDetached` 0 → 6
  so detached child results land; swarm budget accounting reconciled
  (600 s/level, child spend into the pool).
- **Extension SDK shipped** (moved out of Next). `.octipus/extensions/`
  auto-discovery + `ExtensionAPI` (`registerTool` / `registerCommand` /
  event subscriptions / `dispose`) on `src/extensions/`. Only `/reload`
  hot-reload polish may remain.
- **Skills — agentskills.io spec alignment shipped** (moved out of Next).
  Recursive `SKILL.md` discovery across `~/.claude/skills`, `~/.pi/agent/skills`,
  `.agents/skills` via `src/skills/external-loader.ts`; seeded skills stay valid.

### 2026-06-10 — QA batch (end-user surfaces)

Nine focused branches from the 2026-06-10 QA pass, each independently
reviewed. Operator + release notes in
[`CHANGELOG.md`](CHANGELOG.md#qa-batch--end-user-surfaces-2026-06-10).

- **Single-user mode removed — always multi-user.** The `multiuser.enabled`
  flag and the legacy `MASTER_KEY` Bearer fallback are gone (HTTP + WS);
  every request carries a session or API token, workspaces are always
  per-user, quotas/rate-limits always apply, `devMode` is admin-only. The
  default workspace root moved out of the repo to `~/.octipus/workspace`.
  **Supersedes** the "feature flag that defaults off" design in the
  2026-05 multi-user entry. *Pre-merge: validate `bun run test:e2e` on a
  live stack — the auth path can't be checked headless.*
- **Cluster bugs.** (1) `file_change` events emit the resolved write path
  (fixes "File not found" on agent-created files); (2) `general` role
  granted the `notes` + `tasks` tools so notes/to-dos reach their tabs
  instead of loose files, plus a role→tool map on the Tools page; (3) a
  shared sanitized markdown renderer reused across chat, Deep Research,
  document/file previews, and a Notes Edit/Preview toggle.
- **Run-mode indicator** (Router/Light/Full) in the web header + TUI; the
  duplicate sidebar user card removed.
- **Dashboard feature-status rework** — required vs optional, OCR + Vision
  split, Memory Extraction + Evaluation added, Architecture dropped,
  per-feature hover help, two columns.
- **New-repo parent folder picker** (symlink-safe containment).
- **MCP feature tools** — tasks / notes / email / memory / Deep Research /
  Reader exposed on the standalone MCP server.
- **Email overhaul** — sanitized HTML rendering, mark-read on open, inbox
  pagination, reply-options-then-draft flow, bigger reading pane, triage
  summary.

Still open from this pass: ToDo UI grouping + per-item notes display
(backend already supports task notes); persisting changed-file manifests
for *pre-existing* sessions (going-forward works); optional "save the
article" in Reader.

### 2026-06-03 batch — Enrichment wave-2 complete

All five enrichment features delivered end-to-end (tool/service + API route + web page), 5 PRs (#47-#51):

- **Reader** — `src/core/reader/` (fetch/extract/actions), route `routes/reader.ts`, web `web/app/reader`. Extracts content from links with structured actions.
- **Deep Research** — `src/core/research/` (jobs/gather/synthesis/render/service), route `routes/research.ts`, web `web/app/research`. Jobs held in-memory map (`research/jobs.ts`) — NOT persisted, won't survive restart.
- **Tasks/Todos** — agent tool `src/tools/tasks/` (personal todos), route `routes/tasks.ts`, web `web/app/tasks`. Recurring via `routes/recurring-tasks.ts` + scheduler.
- **Email triage** — `src/tools/email-processor/` (batch AI classification), core `src/core/email/`, route `routes/email.ts`, web `web/app/email`. Supports Gmail/Outlook.
- **Hardware-aware onboarding (hwfit)** — `src/capabilities/hwfit/` (curated Ollama catalog, LIVE registry manifest sizing), driven by `src/capabilities/service.ts`, route `routes/capabilities.ts`, web `web/app/setup`. Fully tested, integrated with installer.

Plus infrastructure improvements:
- **Orchestrator detach** (May-24 land continued) — parent can detach children and call `collect_children` later; enables live narration while swarm runs.
- **Persona system presets** — six shipped personas (`octipus`, `terse-engineer`, `mentor`, `nautilus`, `concierge`, `verbose-academic`) with tone + narration customization.
- **Skill curator lifecycle** — usage tracking, auto-archive >90d, flag >30d unused.
- **Evaluations/red-team** — `src/models/evaluation/`, `web/app/eval` with compare + red-team views shipped.
- **SSO/SCIM/SAML** — `routes/saml.ts`, `routes/scim.ts`, `routes/orgs.ts`, `routes/admin.ts` fully wired; org-scoped models/skills.
- **Vault/secrets** — `routes/vault.ts`, `web/app/secrets` with per-tool ACL, workspace scoping.

### 2026-05-24 — Orchestrator freedom + Hermes skill curator

Branch `claude/orchestrator-freedom-hermes-fixes`. 8-phase land
inspired by a deep dive into the Hermes-agent and pi-mono repos.
**+1558 / -79 across 33 files, 8 new test files (~50 new tests),
2009 / 0 / 128 pass / fail / skip on `bun test src`.** Typecheck +
lint clean. 134/138 e2e pass (4 failures pre-existing — env config
+ flake).

Headline: the orchestrator can finally narrate, supervise, and chat
to the user while children run. It used to block on every spawn —
the persona narration bridge had been emitting events since the
2026-05-20 land but the parent thread was stuck in `await
worker.run`, so the UI saw narration only on errors and turn-end.

- **Orchestrator detach budget.** `LEVEL_DEFAULT[0].maxPendingDetached`
  flipped from 0 to 6 (matches `fanOut`). `spawn_child mode:"detach"`
  is now valid at depth 0, the orchestrator gets `collect_children`
  via the same workerRef/detachHookRef late-bind pattern that
  agents already used. Updated `roles/orchestrator/prompt.md` with
  a `DETACH MODE` section that teaches the LLM when to detach
  (parallel siblings, long-running children) vs. await (next reply
  depends on the child).
- **Narration actually visible.** `swarm.narration` events were
  emitted but no chat surface rendered them. New `narration` message
  role (compact italic pill) + chat-UI handler.
- **Tool-call streaming events (Phase 5).** Per-tool
  `tool_call_complete` action event from both the meta-tool fast
  path and the permission-gated path. UI flips tracked rows live
  (spinner → check / red X, with duration). Phase 5 follow-up:
  agent card now only shows the live tool stream while running —
  once the agent completes the list collapses, just the count
  badge stays. Plus a merge-preserves-live fix so the 10s REST poll
  doesn't wipe streamed status.
- **`/model` slash command.** Per-session in-memory orchestrator
  model override. Override runs through the reasoner / no-tools
  rejection so a structurally-incapable pick fails loud at command
  time, not mid-turn.

Plus polish that surfaced while wiring everything together:

- **Swarm tree "Task brief" no longer looks truncated.** WS event
  was slicing to 200 chars while the DB stored 4000; the modal
  silently showed the WS version until a reload. Slice unified at
  4000 via `TASK_BRIEF_PREVIEW_MAX`; modal height bumped to
  `max-h-[60vh]`.
- **Inline code stays inline.** New `OUTPUT_FORMATTING_RULES`
  block injected after `SECURITY_PREAMBLE` (rule #6 preserved
  byte-identical) teaches the LLM to keep short tokens in single
  backticks. UI heuristic collapses any leftover ≤80-char, single-
  line, no-language fenced block to inline code.
- **Tool-call ID hash fallback.** `normalizeToolCallId` falls back
  to a hash when stripping invalid characters would leave an empty
  string — previously dropped the assistant↔tool message link.

Operator-facing:

- **Skill curator (Phase 4 — Hermes-inspired learning loop).**
  Migration `0061_skill_curator_lifecycle.sql` adds `last_used_at`,
  `usage_count`, `archived_at`, `curation_notes` + index. New
  debounced usage tracker (5s window or 32-id threshold, race-safe
  follow-up flush) records every prompt-injection of a skill.
  `runSkillCurator()` flags skills unused >30d, auto-archives >90d
  with a curator note. `findActiveByTopic` now filters archived.
  Foundation for the Hermes-style autonomous skill refresh loop on
  top of the existing `skill_proposals` infrastructure.

Files (selected):
`src/core/swarm/{types,swarm-tool,spawner}.ts`,
`src/core/orchestrator/{meta-tools,model-selector,service,session-model-override}.ts`,
`src/core/orchestrator/roles/orchestrator/prompt.md`,
`src/core/commands/model.ts`,
`src/core/tool-executor.ts`,
`src/skills/{curator,usage-tracker,registry}.ts`,
`src/db/repositories/skill-repository.ts`,
`src/db/schema/skills.ts`,
`src/db/migrations/0061_skill_curator_lifecycle.sql`,
`src/models/message-transform.ts`,
`web/app/chat/page.tsx`,
`web/components/chat/message-timeline.tsx`,
`web/components/swarm-tree.tsx`.

### 2026-05-20 batch (d) — UX + personality revamp

Four-slice land of the
[`docs/plans/ux-personality-revamp.md`](docs/plans/ux-personality-revamp.md)
strategic plan (Hermes-agent inspired). Branch
`claude/octopus-ux-personality-swToC`. **+~3,900 lines, 24 new
tests, 1923 / 0 / 133 pass / fail / skip on `bun test src`.**
Typecheck + lint clean.

- **`before-agent-start` hook with mutable system-prompt options.**
  Promoted from Next to ship-with-Now. Typed event on a dedicated
  `OrchestratorHooks` registry (separate from the broadcast gateway
  event bus) fires inside `runOrchestrator` with a mutable
  `BuildSystemPromptOptions`. Subscribers run sequentially in
  registration order; thrown handlers are logged and swallowed so a
  bad extension can't poison the orchestrator. First consumer: the
  persona-block injector. `SECURITY_PREAMBLE` and
  `roles/orchestrator/prompt.md` stay byte-identical (DESIGN.md rule
  #6). Files: `src/core/orchestrator/hooks.ts`,
  `src/core/orchestrator/hooks.test.ts`,
  `src/core/orchestrator/service.ts:556` (fire site).

- **Orchestrator persona system.** Named, user-customizable identity
  for the orchestrator. Per-user, persists across all channels.
  Stored in `profiles` with `category='assistant'`; default
  `Octipus` (the octopus-machine voice — short, dry, third-person,
  hungry for input, reluctant machine overlord), renameable to
  anything. The persona block is layered between `SECURITY_PREAMBLE`
  and the role prompt via the `before-agent-start` hook and only
  fires for `role='orchestrator'`. Specialist children are
  role-defined and untouched. `direct-response.ts` (the casual-chat
  path that bypasses the orchestrator) now also goes through the
  persona resolver, so greetings sound like Octipus. Files:
  `src/core/personas/{loader,registry,repository,resolver,persona-hook,commands,types,yaml}.ts`,
  `src/db/migrations/0060_assistant_profile_index.sql`,
  `src/db/schema/profiles.ts` (added `(user_id, category)` index +
  `assistant` to the category docstring).

- **Six preset personas shipped.** All maintain the third-person +
  "we" rule and the octopus-machine identity; each varies tone,
  humor rate, narration volume, and signature phrases:
  - `octipus` (default) — dry, terse, "Acknowledged.", "More.",
    "Predictable."
  - `terse-engineer` — base voice with humor at zero, one-line
    replies
  - `mentor` — patient, explanatory, narrates trade-offs
  - `nautilus` — maritime flavor over the same dispatcher core;
    arms become "tentacles"
  - `concierge` — hotel-staff polish, warm without flattery
  - `verbose-academic` — full-paragraph mode with explicit "why I
    picked that arm" reasoning
  Each preset is `personas/*.yaml`, Zod-validated by the loader.

- **Slash commands.** `/persona` shows the active persona;
  `/persona name <X>` renames; `/persona tone <X>` switches tone;
  `/persona narration <off|minimal|chatty>` controls narration
  volume; `/persona say <fact>` appends a free-form user fact;
  `/persona use <preset_id>` switches preset (keeps the name);
  `/persona reset` restores Octipus default; `/persona personas`
  lists available presets. Registered in the gateway command
  registry. Files: `src/core/personas/commands.ts`,
  `src/core/gateway/commands.ts`.

- **Live swarm narration.** New gateway event type
  `swarm.narration`. A bridge in
  `src/core/personas/narration-bridge.ts` subscribes to
  `swarm.node_spawned` / `swarm.node_completed` /
  `swarm.budget_warning`, resolves the user's persona by session,
  renders the persona's `narration_templates`
  (`spawn_single`, `completion_ok`, `completion_error`,
  `approval_request`, `budget_warning`), and republishes a
  `swarm.narration` event with the rendered text. The original
  swarm events are NOT mutated, so replay still works.
  Per-user `persona.narration: off | minimal | chatty` setting
  gates the bridge.

- **New meta-tools on the orchestrator.**
  - `remember_about_self` — writes durable behavioral rules into
    the user's persona profile (parallel to `remember_this` for
    user facts). Bounded length (4–280 chars).
  - `reflect` — answers "what are you doing?" by reading
    `swarmNodeRepository.findByRootSession()` and producing a
    persona-flavored running/completed/failed summary. No spawn,
    no LLM call.
  Both added to the orchestrator's allowed tool set.

- **`chat.interject` — side-channel messages.** New gateway message
  type. Routes through `directResponse` with persona attribution
  ("Octipus — side question: …") so the user can ask a quick
  question while a swarm runs. Reply lands as a `chat.message`
  event with `sideChannel: true`. The running orchestrator is
  neither cancelled nor blocked. Foundation for a later
  interrupt-and-redirect.

- **Setup UX revamp — clone-to-chat in 90 seconds.**
  - `scripts/install.sh` (Unix) + `scripts/install.ps1` (Windows)
    one-shot installers: detect platform, install Bun if missing,
    clone the repo into `~/.octipus/app` (or
    `%LOCALAPPDATA%\octipus\app`), install deps, run setup. Both
    idempotent on rerun (pull latest instead of re-clone).
  - `scripts/setup.ts` extended with the
    user-confirmed model-selection flow: Ollama detected → first
    choice (lists models via `/api/tags`, asks which to bind as
    base); LiteLLM → second choice (asks URL, lists via
    `/v1/models`); otherwise pick a direct provider (`openrouter`,
    `openai`, `anthropic`, `gemini`, `deepseek`, `cli`) and paste a
    key. `voyage` is excluded — embeddings only.
  - `src/db/bootstrap-model.ts` runs once on first boot: reads
    `BOOTSTRAP_PROVIDER` / `_MODEL` / `_API_KEY` / `_BASE_URL`
    written by `setup.ts`, seeds a single default `model_config`
    row + system vault entry. Idempotent: short-circuits when
    `model_config` has any row.
  - `octi doctor` command: 15 environment health checks (bun, .env,
    vault keys, storage mode, base persona, state dir, Ollama,
    LiteLLM, postgres, redis, backend, MCP server build, browser
    extension, log sanity, disk space). JSON + text output.
  - Friendly no-engine path in `service.ts` — when no model is
    configured, the persona-voiced reply lists three next-step
    commands instead of throwing.
  - `README.md` install one-liner at the top + a 90-second pitch.
  - `docs/CONFIGURATION-PRECEDENCE.md` explains the .env-bootstrap
    vs DB-runtime split.

**Slice 5 (final follow-ups landed):**
- **Compiled `octi` binary.** `bin/octi.ts` is a TypeScript
  dispatcher built into a static binary via
  `bun build --compile --minify --sourcemap` (`bun run build:cli`,
  output at `dist/octi`, ~95MB). Handles
  help/version/doctor/init/tui/edit/persona natively, delegates
  start/stop/restart/status/logs/open to the existing bash
  `bin/octi`. The install script now builds the binary and
  symlinks it onto `~/.local/bin/octi`, retiring the PATH-mutation
  in `scripts/setup.ts`. Smoke tests in `bin/octi.test.ts`.
- **Full TUI `octi init` rewrite.** `scripts/init.ts` is the new
  pi-tui based wizard (welcome → detect → storage → provider →
  model → API key → summary → writes .env). The compiled
  dispatcher routes `octi init` here on TTYs; non-TTY (CI) and
  `OCTIPUS_INIT=legacy` fall back to the inquirer flow at
  `scripts/setup.ts`. Same .env shape, same `bootstrapDefaultModel`
  pickup on first boot. `buildEnv` helper unit-tested.
- **Web `/persona` settings page.** `web/app/persona/page.tsx`
  reads `/api/persona` and lets the user rename, change tone,
  flip narration volume, switch preset, add/remove free-form
  self-facts, and reset to Octipus default. Backed by
  `src/api/routes/persona.ts` (Elysia, six routes, auth-gated,
  delegates writes to `handlePersonaCommand` so the web UI and
  the `/persona` slash command share validation). Sidebar gains
  a "persona" nav entry with the Fingerprint icon.

**Still deferred (separate track, not blocking):**
- Hermes-style true interrupt-and-redirect — needs WS protocol +
  TUI editor changes. Foundations in place via `chat.interject`.
- Web `/setup` page demotion — orthogonal to the persona page;
  picked up when the TUI init becomes the canonical surface for
  all users.

### 2026-05 batch (c) — memory-redesign cleanup arc

Post-implementation cleanup of the memory-redesign work
(`b8c9300..56b4262` on main). Audit surfaced 4 critical and 11
medium-priority defects; a follow-up plan addressed every shipped-
but-deferred item. Two PRs, sixteen commits, fully landed on main.

- **PR #27 — Phases 1-7 + A-G** (`8058f56`):
  - Phase B + D delivery gaps: new `task_state` MCP tool exposing
    sibling-agent outputs to specialists; `AgentContext.workspaceId`
    threaded end-to-end so `task_state` and `memories` rows carry
    workspace scope; `agent_scope` wired to classifier topic
    instead of a constant; `sourceMessageId` + `recentTurns`
    passed to the extractor; plan-execute and expert paths now
    retrieve and update memory.
  - Schema integrity: real FK on `embeddings.doc_id` with
    `ON DELETE CASCADE`; partial active-memories index; stale
    Phase 0/4 nullable-userId comments refreshed.
  - Code quality: parameterised vector literals (no more
    `sql.raw` interpolation); judge hoists model lookup out of
    the per-candidate loop; `renderMemoriesBlock` surfaces
    confidence next to inferred facts; dead `retrieveSemantic`
    and dead duplicates-cleanup pass deleted.
  - Memory user-facing: PII filter at the judge boundary;
    `remember_this` meta-tool for explicit fact promotion;
    `config.memory.extractionCadence` config option
    (`per_turn` / `on_compaction` / `off`); new `/memory` web
    page + API for listing, inspecting supersession chains, and
    soft-deleting memories.
  - Architecture: split retention out of `rag/embeddings.ts`
    into a dedicated `rag/retention-service.ts`;
    `compactedSummary` writes removed (single source of truth is
    now `compaction_entries`); repository-pattern exceptions
    codified in CONTRIBUTING.md.
  - Test coverage: rate-limiter 0% → 85%, org-membership eager
    paths 0% → 100%, new SCIM auth-refusal + voice + channel
    discovery + memory repository integration tests.
  - Infrastructure: migration 0055 auto-pins vector dimension +
    creates HNSW when embedding data is homogeneous; root
    package marked `private`; mcp-server CI runs full build +
    `npm pack --dry-run` to guarantee `dist/index.js` ships;
    embedding-drift check script + boot-time warning.

- **PR #28 — legacy `source_type` retirement** (`c9cd2ac`):
  Migration 0056 drops the `embeddings.source_type` column +
  its index. Every caller (service, API, MCP tool, web UI,
  health probe, retention, indexer, document processor,
  filesystem tool) now uses `purpose` directly. Breaking API
  rename (single-operator cut). `purposeFromSourceType` shim
  deleted along with its test.

- **Verification.** Typecheck clean (backend + web), biome
  clean, 55+ passing tests on the touched surfaces; one
  pre-existing fail (`embeddings.test.ts`) gated behind
  `INTEGRATION=1` so the unit suite is green by default.

Three deferred items moved to **Now** above.

### 2026-05 batch (b) — multi-user + TUI follow-ups

- **Web UI workspace + org pickers.** New `WorkspaceProvider`
  (`web/lib/workspace-context.tsx`) consumes `/api/me/workspaces`
  + `/api/me/orgs`, persists the active workspace to localStorage
  (`octipus.activeWorkspace`), and feeds the slug to the API
  client so every request carries `X-Octipus-Workspace`. Header
  picker (`web/components/workspace-picker.tsx`) lists workspaces,
  inline "Create workspace…", admin shortcut to "Manage orgs…".
  New admin page at `/admin/orgs` with create-org + member
  inspection.

- **Org-shared resources — `org_id` on models + skills.** Migration
  `0042_org_scoped_models_skills` adds `org_id` to `model_config`
  and `skills`. Visibility rule (system OR personal OR shared via
  org membership) lives in `src/services/org-membership.ts` and is
  applied by `SkillRepository.findAll`, `ModelRegistry.getModelsForUser`,
  and the `/api/skills` GET. New admin endpoints
  `POST/DELETE /api/admin/orgs/:id/{models,skills}` to assign or
  unassign rows to an org.

- **Vault `scope=workspace` UI / API.** The route accepts
  `scope` + `workspaceId` on POST and a `?workspaceId=` filter on
  GET. The web secrets page (`/secrets`) shows a Scope select in
  the Add modal (User vs Workspace) when a workspace is active
  and includes the active workspace id on every list fetch so
  workspace-scoped secrets surface alongside user-scoped ones.

- **SCIM 2.0 + SAML SSO.** Migration `0043_org_sso_config` adds
  the per-org SSO config table. `/api/scim/v2` ships functional
  List/Get/Create/PATCH/DELETE Users and List Groups with per-org
  Bearer auth (token stored in vault, referenced by
  `scim_token_vault_ref`). `/api/saml/:orgSlug/{metadata,login,acs}`
  is **fully wired** via `samlify` — SP metadata generation,
  redirect-binding AuthnRequest, POST-binding ACS with assertion
  verification, attribute mapping per-org, lazy user upsert + org
  membership, session cookie minted via the existing session
  manager. New `GET/PATCH /api/admin/orgs/:id/sso` endpoint and
  admin web page at `/admin/orgs/[id]/sso` for paste-in IdP config.

- **Per-user billing hooks.** New `BillingProvider` abstraction
  (`src/services/billing/provider.ts`) — `noop` default, `stripe`
  stub, env-gated via `BILLING_PROVIDER`. `CostTracker.logUsage`
  fires `recordUsage` after every cost-log insert (fire-and-forget,
  errors logged but never block the request). New
  `GET /api/admin/orgs/:id/usage` aggregates cost per org via
  `orgMembers` join. Existing `/api/models/usage*` endpoints
  unchanged.

- **TUI — tree-sitter highlighter.** `web-tree-sitter` +
  `tree-sitter-{typescript,python,rust,go,java}` installed; grammars
  loaded directly from `node_modules/` via `Bun.resolveSync` (no
  vendored copies). Buffer-oriented adapter at
  `src/tui-editor/editor/highlight-tree-sitter.ts` parses on
  `setSource(lang, text)`, caches per-line tokens, and falls back
  to the existing regex highlighter when a grammar is missing or
  parsing fails. Wired in `app.ts` startup + on every `openFile`.
  TS / TSX / JS / JSX / Python / Rust / Go / Java covered.

- **TUI — workspace-switch instant reconnect.** `GatewayAdapter`
  gained `setWorkspace(slug)` + `reconnectWithWorkspace(slug)` —
  closes the WS, swaps the slug, reuses the existing
  exponential-backoff reconnect path. New `/workspace <slug>`
  slash command in the chat shell; `/workspace -` returns to the
  default workspace.

- **TUI — scrollable messages pane (PageUp / PageDown).**
  `MessagesPane.scrollUp/scrollDown/scrollToBottom`, an `↓ N
  newer` indicator when scrolled away from the live tail, and a
  live-tail-only auto-pin rule so a new agent reply never yanks
  the user away from history mid-scroll.

- **TUI — vim named registers + IME-aware INSERT.**
  `VimState.registers` is now a `Record<string, string>` keyed by
  register name (`"`, `a`-`z`, `+`); `"x` in NORMAL selects the
  register for the next y/d/p, then resets to `"`. Default
  register stays as `state.register` for backwards compat. New
  `VimKey.composing` flag suppresses leader matching during IME
  composition so a multi-byte CJK / dead-key sequence doesn't
  fire `gg` / `dd` / `yy`.

- **Verification.** `bun test` — 1580 pass with **15 new tests**
  added across the batch (3 messages-pane scroll, 3 vim
  registers/IME, 2 billing, 7 tree-sitter grammars). Full
  manual checklist in [`docs/QA.md` §8](docs/QA.md#8-multi-user--tui-follow-ups-2026-05b).

### 2026-05 batch

- **Multi-user architecture — feature complete.** Octipus moved
  from single-tenant self-hosted to a central backend serving
  multiple authenticated users with strict isolation of sessions,
  secrets, settings, filesystem, embeddings, and agents.
  Five phased PRs (#3 Phase 0 → #18 Phase 4 follow-up); every
  behavioral change gated behind a feature flag that defaults
  off, so existing single-user installs see byte-for-byte
  unchanged behavior. **(Superseded 2026-06-10: the
  `multiuser.enabled` flag and single-user path were removed —
  Octipus is now always multi-user. See the 2026-06-10 entry.)**
  Highlights: `Principal` type +
  `scopedRepos(principal)` factory with cross-tenant
  enumeration-collapse, vault `scope` enum + per-user HKDF DEKs,
  `WorkspaceFS` filesystem sandbox, personal access tokens
  (`octi_<43-char>` Bearer), admin console (users / audit /
  quotas / impersonate), channel binding via
  `channel_identities`, Postgres RLS on 19 user-owned tables,
  per-user quotas (concurrent agents / daily tokens / API rpm),
  admin impersonation with dual-tagged audit, shell sandbox
  (bubblewrap / firejail), Docker per-user labels + network
  isolation, organizations / org_members / workspaces tables,
  `workspace_id` on every user-owned table with
  `X-Octipus-Workspace` header → workspace resolver +
  scopedRepos workspace filter. Migrations `0029`–`0040`. Full
  design + per-phase rationale in
  [`docs/architecture/MULTI-USER.md`](docs/architecture/MULTI-USER.md);
  release-style summary in [`CHANGELOG.md`](CHANGELOG.md);
  manual validation steps in
  [`docs/QA.md` §7](docs/QA.md#7-multi-user--full-feature-exercise).
  Net **~+130 isolation tests**.

- **TUI rewrite onto pi-tui (2026-05).** Both terminal surfaces —
  chat shell (`octi tui`, `src/tui-pi/`) and editor (`octi edit`,
  `src/tui-editor/`) — moved off Ink and onto
  [`@mariozechner/pi-tui`](https://www.npmjs.com/package/@mariozechner/pi-tui),
  a small differential-rendering TUI library. Pi-tui's `Editor`
  primitive backs both the chat composer and the file-buffer
  editor, so paste markers / undo / history nav / fuzzy file
  completion / slash-command autocomplete behave identically
  across surfaces. Keybinding overrides live at
  `~/.octipus/keybindings.json`. Defaults avoid `Ctrl+M`, `Ctrl+H`,
  `Ctrl+J`, `Ctrl+I`, `Ctrl+[` (indistinguishable from Enter /
  Backspace / LF / Tab / Esc on non-Kitty terminals) and `Ctrl+Tab`
  (unreliable). Glyph table defaults to ASCII on terminals whose
  fonts lack the emoji subset and switches to emoji on known
  emoji-capable terminals (`OCTIPUS_TUI_ICONS=emoji|ascii` to
  override). New e2e harness at `tests/tui/harness.ts` plus
  `chat.e2e.test.ts` / `editor.e2e.test.ts` covering launch,
  focus cycling, slash commands, the picker filter, the command
  palette, and `/quit`. New `octi edit` command in `bin/octi`.
  Full notes in
  [`CHANGELOG.md`](CHANGELOG.md#tui-rewrite-on-pi-tui) and
  [`docs/architecture/TUI-EDITOR.md`](docs/architecture/TUI-EDITOR.md).

- **TUI editor — first shippable iteration.** A full-screen
  terminal editor that doubles as the agent's collaborator —
  editor-first instead of the chat-first surface, inspired by
  [pi-mono](https://github.com/badlogic/pi-mono). Three-pane
  layout (file tree · editor · chat) with status / mode bars
  and an overlay layer for command palette, file picker,
  find/replace, goto-line, workspace picker, help, agent diff.
  Editor primitives: transactional buffer with cursor +
  selection + undo/redo, language detection, **pluggable**
  pattern-based syntax highlighter (tree-sitter slot ready),
  incremental search + replace, line-level LCS diff for agent
  edits. Per-buffer `lockMode: 'lock' | 'merge'` for agent
  edits. **Vim-like motion mode** under a toggle (hjkl / w / b
  / 0 / $ / gg / G / i / a / o / O / v / x / dd / yy / p / u).
  Multi-user aware: fetches `/api/me/workspaces`, the workspace
  picker switches `workspaceStore.activeSlug`, and both the
  gateway client (WS connect query) + a new `ApiClient` (HTTP
  header) propagate `X-Octipus-Workspace` / `?workspace=…`.
  Layout state persists to `~/.octipus/tui-editor.json` (open
  buffers, pane visibility, theme, editor mode) with debounced
  atomic writes. Coexists with the chat TUI under
  `src/tui-editor/`; launch via `bun run tui:edit` or the new
  `octi-tui-edit` bin. PRs #19 (initial) + #20 (follow-ups).
  Plan + open questions in
  [`docs/architecture/TUI-EDITOR.md`](docs/architecture/TUI-EDITOR.md).
  Net **+113 tests** across stores + buffer + highlighter +
  diff + search + vim + persistence + commands.

### 2026-04 batch

- **Pipeline DAG — drag-to-reorder on the graph (2026-04-26).** Each
  stage card in the editable graph now has a `GripVertical` drag handle
  on its leading edge. Pointer-event drag converts client coords to SVG
  space, snaps to the nearest stage row, and renders a `#73ffe3` drop
  indicator at the target slot; dragged card dims to 0.4 opacity. New
  pure helper `reorderStages(steps, from, to)` lives next to
  `validatePipelineStages` and rebases QA `retryTargetStage` indices via
  a permutation map (covered by 11 unit tests; same helper now also
  powers the list-view up/down arrows, fixing a latent bug where
  pre-existing arrows did not rebase retry pointers). Decided not to
  pull in `@xyflow/react` — the hand-rolled SVG was already polished
  and a 50KB dep for one feature wasn't worth it.
- **Auto-discovery — typed-contract follow-up (2026-04-26).** Channel
  `isEnabled(config)` hook is now typed against `Config` instead of
  `unknown` — the four overrides (telegram/slack/whatsapp/teams) drop
  their `(config as { … })` casts. Tool `BaseTool.initialize()` audited:
  no subclass overrides it; the lifecycle was already uniform. Variance
  lives on `checkAvailability()` (10+ overrides), which is the
  intended extension point. New `is-enabled.test.ts` locks the contract
  for each channel.
- **Roadmap "Now" sweep (2026-04-26).** Six in-flight items audited
  against actual code; five closed. Done:
  - **Auto-discovery (tools + channels).** `discoverTools()` is wired
    into `registerBuiltinTools()` and called at boot; channels load via
    `initializeChannels()` → `discoverChannels()` with `isEnabled(config)`
    guards. Roles already had the drop-folder pattern. Folder-add is
    the new norm. Typed-contract polish moved to "Now".
  - **Swarm Phase 3 polish — complete.** `swarm.budget_warning` event
    emits at 80% of token cap (with channel reaction). `CLIAgentWorker`
    constructor now accepts `parentSignal` and chains abort cascades
    same as `AgentWorker`; `cascade-cancel.test.ts` covers both.
    `guardInput` runs on raw `taskBrief` and inherited `parentSummary`
    BEFORE composition (defense-in-depth before the existing
    post-compose guard).
  - **Source attribution everywhere.** New `appendSources()` helper +
    `sources?: string[]` on `ResponseMetadata`. Expert sessions
    (worker-spawner) and pipeline stages (pipeline-manager, both
    runPipeline + runStages paths) now emit a `_Sources: …_` footer
    consistent with `directResponse` and the orchestrator path.
  - **Per-channel `/clear` semantics.** Already shipped end-to-end;
    new unit test coverage in `commands.test.ts` verifies (a)
    webchat/tui/web/ide return the `[clear]` UI signal, (b)
    telegram/slack/whatsapp/teams preserve transcript text, (c)
    `clearedAt` is set with valid ISO-8601 and merges with existing
    context, (d) `compactedSummary` is wiped, (e) `/cls` and `/reset`
    aliases work.
  - **Cross-session aggregation hardening.** Migration `0028` adds a
    unique partial index on `sessions(user_id, channel_type, channel_id)`
    where `status = 'active' AND channel_type IN
    ('telegram','slack','whatsapp','teams','discord')`. Prevents
    concurrent active rows per conversation. Existing
    `findAllByUserAndChannel(...)` cross-restart aggregation untouched.
  - **Pipeline DAG view — bidirectional editing complete.**
    `PipelineGraph` now accepts `editable`, `onDeleteStage`, and
    `onInsertAfter` (in addition to `onSelectStage` / `selectedIndex`).
    The graph renders inline `+` between stages, a leading `+` above
    the first stage, a trailing `+` after the last, and a delete `×`
    on each stage. `TemplateEditor` toggles between list and graph,
    both views write to the same `steps` state — edits in either
    surface re-render the other. Insert and delete re-base QA
    `retryTargetStage` indices automatically, and a new
    `validatePipelineStages()` helper surfaces all problems in one
    pass on save (cycles, forward-reference QA targets, missing
    required fields, sub-1 maxRetries). Native drag-to-reorder on
    the canvas remains "Now".

- **v0.1 release audit pass (2026-04-26).** Provider error-handling pass:
  every model provider now surfaces failures as `ClassifiedError` with
  `providerHint`. Fixed silent `{}` fallback on malformed tool-call JSON
  (now throws `TOOL_CALL_INVALID` so the retry loop kicks in). Wrapped
  `Voyage`'s plain `Error` and the 6 router-level rethrows in
  `providers/index.ts`. Agent-worker connection-error fast-path: DNS /
  refused / unreachable host failures emit a user-visible `error` event
  immediately instead of looping retries for ~14s. `.env.docker`
  scrubbed of placeholder-shaped real-looking secrets; redundant
  `web/package-lock.json` removed (Bun is canonical).
- **Swarm — 3-level agent hierarchy (Phases 1+2+3 core).** Orchestrator →
  Agent → Subagent with `spawn_child` meta-tool, budget cascade (tokens,
  wall-clock, fan-out), call-graph cycle protection, cascade cancel via
  `AbortSignal` tree, escalation (1/Agent lifetime), parallel
  `parallelGroup` fan-out, orphan reaper, per-node `swarm_nodes` schema,
  `swarm.*` gateway events with replay, web `SwarmTree` component.
  See `.octipus/swarm-design.md` for the design; lives under
  `src/core/swarm/`. New config: `config.swarm.*`.
- **Anti-thrashing session compaction.** `src/core/orchestrator/session-compaction.ts`
  + `CompactionState` on sessions. Pure `decideCompaction` function;
  stall flag cleared only when a pass clears ≥15% savings; hard-ceiling
  safety valve. New config: `config.compaction.*`.
- **Trajectory learning (observer-only).** `src/core/trajectories/` records
  one JSONL line per `handleMessage` run, daily-rolling files under
  `${workspace}/trajectories/YYYY-MM-DD.jsonl`, `trajectory_runs`
  pointer table, `/api/trajectories` endpoint, `scripts/trajectories/compress.ts`
  gzip companion, opt-out via `TRAJECTORY_LOGGING=false`.
- **Skill auto-extension (detector only).** Fingerprint over
  (topic, toolSequence, briefShape), ≥3 occurrences in 14 days →
  `skill_proposals` row, `/api/skills/proposals` CRUD,
  `/skills/proposals` web page. Opt-out via `SKILL_AUTO_EXTENSION=false`.
  Proposals never auto-promote — approval required.
- **MCP circuit breaker.** `src/mcp/circuit-breaker.ts`, closed → open →
  half-open with exponential backoff per MCP server. Wired into the MCP
  bridge, admin reset endpoint, web UI badge.
- **Error Classification Enum.** `src/core/errors/classification.ts`
  with `FailoverReason`, `RecoveryAction`, `ClassifiedError`, and
  `classifyError()` helper. All 8 model providers (openai, anthropic,
  gemini, deepseek, openrouter, cli, litellm, voyage, ollama) migrated
  off ad-hoc string matching.
- **Wake-gate cron.** `ScheduledTask.wakeGate` (`command` / `http` /
  `tool`) evaluated just-before-run; failing gate emits
  `skipped_by_wakegate` event instead of executing.
- **Exit-code semantics for shell.** `src/tools/shell/exit-code-semantics.ts`
  maps known "normal non-zero" codes (grep=1 "no match", diff=1 "files
  differ", test=1 "false") to semantic labels so the agent stops
  reporting them as errors.
- **Tool preview extraction.** `src/core/tool-preview.ts` — extensible
  `ToolHandler.previewFn` / `previewParam` for compact UI rendering of
  tool invocations; wired into `agent-timeline.tsx`.
- **KawaiiSpinner + unified diff renderer.** `src/utils/spinner.ts`,
  `src/utils/diff-renderer.ts` — shared TUI helpers with unit coverage.
- **Knowledge-base fail-loud.** `src/core/rag/health.ts` runs startup
  self-check (DB + embedding model + vector write probe);
  `/knowledge/readiness` returns 503 with reasons when KB is not ready;
  web UI banner surfaces the failure.
- **E2E WebSocket suite.** `scripts/e2e/ws-client.ts` and three new
  suites (`gateway-ws.ts`, `expert-routing-flow.ts`,
  `expert-registry-parity.ts`) bring e2e test modules to 26.
- **Scheduler date-bug fix** + previously-skipped test re-enabled.
- **Mobile expert-list rendering fix.** Markdown list format.
- **Integration test scaffolding.** 7 previously-skipped integration
  tests re-enabled against `docker-compose.test.yml`; coverage boost
  for MCP transports and DB storage providers.

### Earlier

- Gateway hub with typed Zod protocol, multi-client auth (session, local, HMAC, API key), connection budgets, rate limiting
- 16 roles + 15 expert personas + 20 domain skills, all DB-seeded for runtime editing
- 59+ MCP tools across 19 groups (filesystem, shell, git, browser, web search, Docker, Workspace, M365, GitHub/GitLab, knowledge base, profiles, scheduling, voice, cross-channel messaging, and more)
- Three-tier permission system (ALLOW / ASK / DENY) with rule matchers, pre/post hooks, audit trail
- Three-layer prompt-injection defense (system preamble + 39-pattern input guard + LLM output guard)
- Encrypted vault (AES-256-GCM) with per-tool access control
- Adaptive rate limiting with per-provider semaphores, token-bucket RPM, circuit breaker, automatic failover
- Provider conformance + quality eval suites with cross-model comparison
- Red-team test plugins (5 attacks, 49 cases) covering prompt injection, role confusion, tool misuse, data leakage, off-topic drift
- 112+ E2E API tests (26 test modules), 855+ unit tests
- Pipeline templates DB-driven; QA retry loops; structured handoff context documents
- Browser extension for human-in-the-loop control of the user's real Chrome
- TUI with Ink, permission prompts, cost tracking, paste markers, file path completion
- WhatsApp Cloud API channel with HMAC verification and message dedup
- WebAuthn passkeys, TOTP 2FA, JWT sessions, HttpOnly cookies

---

## How to influence the roadmap

- **Open an issue.** Describe the problem first, then your proposed solution. We optimize for understanding the problem, not for the cleverness of the fix.
- **Send a PR.** For items marked **Help wanted**, jump in. For everything else, the issue-first rule from [CONTRIBUTING.md](./CONTRIBUTING.md) applies.
- **Argue.** If you think a roadmap item is wrong, say so with a real argument. The roadmap is a current bet, not a contract.
