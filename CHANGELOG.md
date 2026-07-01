# Changelog

Notable changes worth calling out for operators and integrators.
The format draws from [Keep a Changelog](https://keepachangelog.com)
without forcing strict semver — Octipus is pre-1.0; "minor" / "major"
labels reflect blast radius, not contract guarantees.

## Unreleased

### Core file refactor (2026-07-01, PR #167)

- **Programmer-visible:** Split the four largest logic-heavy files
  (`api/routes/models.ts`, `core/orchestrator/service.ts`, `core/swarm/spawner.ts`,
  `core/agent-worker.ts`) into focused sibling modules — routes now delegate to
  a `src/services/` layer, and swarm budget/validation/cache plus the
  detached-child manager and tool-loop detector are their own units. No
  behavior change; every public API and import surface preserved.

### Session changes review — `/changes` (2026-07-01)

- **User-visible:** Review the file changes an agent made during a session. A
  git-backed `/changes` view surfaces every touched file, with a new web
  **Changes** tab and the same set rendered in the TUI client.

### Orchestrator detach — activated + hardened (2026-07-01)

- **Operator-visible:** Detached subagents are now collected by default
  (`maxPendingDetached` 0 → 6) instead of being discarded in await-mode, so
  long-running child results actually land. Swarm budget accounting reconciled:
  canonical wall-clock is 600 s (10 min) per level, and child spend feeds the
  shared pool.

### QA batch — end-user surfaces (2026-06-10)

Findings from the 2026-06-10 QA pass, delivered as nine focused branches
(each independently reviewed). Highlights:

- **Single-user mode removed — always multi-user.** The `multiuser.enabled`
  flag and the legacy `MASTER_KEY` Bearer fallback are gone; every request
  must carry a session or API token. A single-user install simply never
  creates a second user. Workspaces are always per-user; the default
  workspace root moved out of the repo tree to `~/.octipus/workspace`
  (gitignore-leak fix). **Operator action:** anyone authenticating via
  `MASTER_KEY` must mint an API token (`POST /api/tokens`) or log in. Run
  `bun run test:e2e` against a live stack before deploying. Supersedes the
  feature-flag note in the 2026-05 multi-user entry below.
- **Agent file-writes resolve correctly in the UI.** `file_change` events now
  carry the path the tool actually wrote (post session-relocation), fixing
  "File not found" when clicking an agent-created file.
- **Notes / to-dos route to their real features.** The `general` role now has
  the `notes` and `tasks` tools (+ prompt routing), so "write a note" / "add
  a to-do" hit the Notes / Tasks tabs instead of dropping a loose markdown
  file. The Tools page shows which roles can use each tool.
- **Markdown renders everywhere.** A shared sanitized renderer backs chat,
  Deep Research reports, document/file previews, and a new Notes
  Edit/Preview toggle.
- **Run-mode indicator.** The web header and TUI status bar show
  Router / Light / Full (derived from the default-model size); the duplicate
  user card was removed from the sidebar.
- **Dashboard feature-status rework.** Required vs optional per feature,
  OCR + Vision shown separately, Memory Extraction + Evaluation added,
  Architecture dropped, per-feature hover help, two-column layout.
- **New-repo parent folder.** "Create new repository" lets you pick the
  parent folder (root / additional paths) with a destination preview;
  symlink-safe containment.
- **MCP feature tools.** tasks, notes, email, memory, Deep Research, and
  Reader are now exposed on the standalone MCP server.
- **Email overhaul.** HTML bodies render (server-side sanitized), messages
  mark read on open, inbox paginates (Load more), "Draft reply" proposes
  directions for you to choose before drafting, bigger reading pane, triage
  shows a result summary.

### Streamlined setup (2026-05-26)

One way in. The six divergent setup paths (`install.sh`, inquirer
`scripts/setup.ts`, pi-tui `scripts/init.ts`, `bin/octi start`,
`web/app/setup/page.tsx`, `docker-entrypoint.sh`) collapse into a
single `octi setup` wizard. After it runs, the service is runnable
and the user picks TUI or web — both surfaces consume the same
backend; neither owns onboarding.

User-visible:

- **`octi setup`** is the only wizard. Walks storage → secrets →
  backend boot → admin account → provider+key → default model →
  capabilities install (Playwright, MCP, browser ext, …). Supports
  `--non-interactive` (env-var driven, for CI / Docker builds) and
  `--remote <url>` (configure a running container from your host).
- **`.env` is secrets only** — `MASTER_KEY`, `JWT_SECRET`,
  `SESSION_SECRET`, storage targeting, `API_HOST`/`API_PORT`, and
  one-shot `BOOTSTRAP_*` vars consumed at first boot. Everything
  else (ports, channels, workspace, providers, feature flags) lives
  in the `settings` table / vault and is editable via the API at
  runtime.
- **`octi capabilities`** lists installed/missing optional tools.
  Sub-commands: `octi capabilities install <id>` and
  `octi capabilities install --all` to fix gaps after first run.
- **Web `/setup` is gone.** First-run onboarding happens in the
  terminal; the legacy route redirects to `/chat` once the system
  is set up, or shows a one-paragraph CLI hint otherwise.
- **Docker reports its own capabilities.** Playwright Chromium and
  the MCP server build are pre-baked in the image; the
  `capabilities` table reflects that on first boot. The entrypoint
  prints a one-shot `octi setup --remote` hint when the system has
  not been set up yet.

Internal:

- **Shared probe utilities** (`src/setup/probes.ts`) and a canonical
  provider registry (`src/setup/providers.ts`) replace three
  duplicated copies.
- **Capability service** (`src/capabilities/service.ts`) persists
  every tool's `checkAvailability()` result into a new
  `capabilities` DB table. The orchestrator gates `getToolsForRole`
  against this table at spawn time, so an agent that requires
  Playwright but lacks it logs a clear
  `octi capabilities install browser` hint instead of failing deep
  in a tool call.
- **Settings registry** (`src/config/settings-registry.ts`) gained
  explicit `*.apiKey` entries for OpenAI / Anthropic / Gemini /
  DeepSeek so the wizard can route keys into the vault through the
  existing `PATCH /api/settings/:key` handler.
- **Deleted**: `scripts/setup.ts` (715 LOC inquirer wizard) and the
  five `web/components/setup/*.tsx` step components. The
  `@inquirer/prompts` dev-dep dropped with them.

### Orchestrator freedom + Hermes-inspired curator (2026-05-24)

Branch `claude/orchestrator-freedom-hermes-fixes`. 8-phase land
inspired by a deep-dive into the Hermes-agent and pi-mono repos.
Headline: the orchestrator can now narrate, supervise, and chat to
the user while children run — it used to block on every spawn. Plus
a Hermes-style skill curator, a `/model` slash command, and a pile
of UX polish that surfaced while wiring everything together.

User-visible:

- **Orchestrator can talk while children work.** `spawn_child mode:
  "detach"` is now valid at depth 0 — the orchestrator fires up to
  six parallel agents, narrates progress, takes side-channel
  questions, then synthesizes via `collect_children` (or the
  framework auto-collects before the final reply). Previously every
  spawn was a blocking await: persona-narration events fired but the
  UI only saw them after the worker finished, so it looked like
  narration only triggered on errors. Now narration appears live.
- **Narration actually appears in chat.** The persona-narration
  bridge has been emitting `swarm.narration` events since the
  2026-05-20 ship but no surface rendered them — chat went silent
  during waits. New `narration` message role + chat-UI handler
  surfaces them as compact inline italics.
- **Tool-call streaming in the agent card.** Per-tool
  `tool_call_complete` events flip rows from spinner → check (or
  red X) the moment a tool returns, with duration + result preview.
  While the agent is running you see the live stream of what it's
  doing; once the agent finishes the inline list collapses and the
  tool count badge stays in the agent header. Survives the 10s
  REST poll without flickering.
- **Inline code stays inline.** LLM outputs like "the container is
  ` octipus-pg `" rendered as full-width fenced blocks. New
  formatting rule in every role prompt + a UI heuristic that
  collapses short single-line fenced blocks (≤80 chars, no
  language) to inline code.
- **Swarm-tree "Task brief" shows the full brief.** The WS event
  used to slice the preview to 200 chars while the DB stored 4000 —
  the modal looked truncated until a hard reload. Slice unified at
  4000; modal height bumped from `max-h-72` to `max-h-[60vh]`.
- **`/model` slash command.** Switch the orchestrator model for
  the current session without editing config. `/model <id|name>`
  to set, `/model clear` to revert, `/model list` to browse,
  `/model` to show the active override. Bad picks (reasoner,
  no-tools, known-unreliable for orchestration) get rejected at
  command time, not mid-turn. In-memory; resets on restart.

Operator-visible:

- **Skill curator (Phase 4 — Hermes-inspired learning loop).**
  Skills now track `last_used_at`, `usage_count`, `archived_at`,
  `curation_notes` (migration `0061_skill_curator_lifecycle`).
  A debounced in-process tracker (5s window or 32-id threshold,
  race-safe follow-up flush) records every prompt-injection of a
  skill. `runSkillCurator()` flags skills unused >30d, auto-archives
  unused >90d with a note. `findActiveByTopic` now filters archived.
- **Cross-provider tool-call IDs survive edge cases.**
  `normalizeToolCallId` falls back to a hash when stripping
  invalid chars would leave an empty string — earlier those silently
  dropped the assistant↔tool message link. Added idempotency and
  length-cap tests.
- **Orchestrator detach budget is configurable per level.**
  `LEVEL_DEFAULT[0].maxPendingDetached`: 0 → 6 (matches `fanOut`).
  Override per deployment via `config.swarm.levelDefaults.orchestrator`.

Internal:

- New: `src/skills/{curator,usage-tracker}.ts`,
  `src/core/orchestrator/session-model-override.ts`,
  `src/core/commands/model.ts`,
  `src/core/orchestrator/meta-tools-detach.test.ts`,
  `src/core/tool-executor-events.test.ts`.
- Reshape: `ModelSelector.selectForOrchestration(sessionId?)` runs
  both the default model and the session override through the same
  suitability gate.
- Roadmap items closed by this branch: **Skill auto-extension —
  promotion path** (curator covers archive lifecycle; promotion UI
  remains).
- Tests: 2009 / 0 / 128 pass / fail / skip across 200 unit files;
  134/138 e2e pass (4 failures pre-existing — env config + flake).

### UX + personality revamp (2026-05-20)

Branch `claude/octopus-ux-personality-swToC`. Five-slice land of the
full plan at `docs/plans/ux-personality-revamp.md` (Hermes-agent
inspired). User-visible:

- **Orchestrator now has an identity.** Per-user, persists across
  every channel. Default is `Octipus` — an octopus-machine that
  refers to itself in the third person, uses "we" for the swarm,
  and gives short dry replies. Rename via `/persona name <X>`;
  change tone/narration/free-form facts via `/persona ...`. Six
  preset YAMLs ship under `personas/` (`octipus`, `terse-engineer`,
  `mentor`, `nautilus`, `concierge`, `verbose-academic`). Specialist
  children stay role-defined — persona is host-level only.
- **Live swarm narration.** New `swarm.narration` event mirrors
  `swarm.node_spawned` / `node_completed` / `budget_warning` with
  persona-rendered text ("Octipus dispatches a research arm.",
  "qa arm failed. Predictable."). Per-user `persona.narration: off
  | minimal | chatty` setting.
- **Side-channel messages.** New gateway message type
  `chat.interject` lets the user ask a quick question while a
  swarm runs. Reply lands as `chat.message` with `sideChannel: true`
  and persona attribution. Running orchestrator is neither cancelled
  nor blocked.
- **Friendly no-engine path.** First message before a model is
  configured no longer throws — replies in the persona voice with
  three concrete next steps (`bun run setup`, `octi doctor`, web
  Models page).
- **Casual chat is persona-aware.** `directResponse` (the
  greetings/small-talk path that bypasses the orchestrator) now
  uses the same persona resolver — so "hi" gets an Octipus reply
  too, not a generic friendly-assistant string.

Operator-visible:

- **One-shot installer.** `curl -fsSL .../install.sh | bash` (Unix)
  or `iex (irm .../install.ps1)` (Windows) clones, installs deps,
  builds the compiled binary, symlinks it onto PATH, runs setup.
- **Compiled `octi` binary.** `bun run build:cli` produces a static
  ~95MB executable at `dist/octi`. Retires the PATH-mutation
  `scripts/setup.ts` used to do. Handles
  help/version/doctor/init/tui/edit/persona natively; delegates
  start/stop/restart/status/logs/open to the bash dispatcher.
- **`octi init`.** New pi-tui based setup wizard. Welcome →
  service auto-detect → storage mode → provider (Ollama first if
  detected, then LiteLLM, then direct provider — Voyage excluded)
  → model picker → API key → summary → writes .env. Falls back
  to `bun run setup` (the inquirer flow) on non-TTY.
- **`octi doctor`.** 15 environment health checks: bun, .env,
  vault keys, storage mode, base persona, state dir, Ollama,
  LiteLLM, postgres, redis, backend, MCP server build, browser
  extension, log sanity, disk space. JSON + text output.
- **First-boot model bootstrap.** `src/db/bootstrap-model.ts` reads
  `BOOTSTRAP_PROVIDER` / `_MODEL` / `_API_KEY` / `_BASE_URL` from
  `.env` (written by `bun run setup` / `octi init`), seeds a
  default `model_config` row, stores the API key in the vault.
  Idempotent.

Programmer-visible:

- **`before-agent-start` hook.** New typed mutable-context hook in
  `src/core/orchestrator/hooks.ts`. Fires inside `runOrchestrator`
  with `BuildSystemPromptOptions` — handlers can prepend, append,
  or substring-replace the system prompt. The persona-block
  injector is the first consumer. `SECURITY_PREAMBLE` and
  `roles/orchestrator/prompt.md` stay byte-untouched (DESIGN.md
  rule #6). Extensions can subscribe — see PLUGINS.md.
- **New meta-tools on the orchestrator:**
  - `remember_about_self` — writes durable behavioral rules into
    the per-user persona profile (parallel to `remember_this`).
  - `reflect` — answers "what are you doing?" by reading the live
    swarm tree, no spawn, no LLM call.
- **New REST routes** at `/api/persona` (GET resolved, GET
  /presets, PATCH, POST /facts, DELETE /facts/:idx, POST /reset).
  See API.md.
- **Schema:** new `category='assistant'` rows in `profiles`,
  composite `(user_id, category)` index added by migration 0060.
- **Docs:** `docs/CONFIGURATION-PRECEDENCE.md` explains the
  `.env`-bootstrap vs DB-runtime split; `personas/octipus.yaml`
  is the canonical voice spec; full design at
  `docs/plans/ux-personality-revamp.md`.

1929 / 0 / 133 pass / fail / skip on `bun test src`. Typecheck +
lint clean.

### Legacy `source_type` retirement (2026-05-17, PR #28)

Completes the column-retirement flagged after the memory-redesign
cleanup arc. Phase A (migration 0049) added `purpose` as the
canonical categorisation column; `source_type` carried alongside
it during the soft-migration window. This drops `source_type`
entirely.

**Breaking — single-operator cut. External callers, MCP-tool
prompts, and the web UI all switch in lockstep.**

- **Schema.** Migration 0056 drops `embeddings_source_type_idx` and
  the `source_type` column. Idempotent. The Phase A backfill already
  mirrored every value onto `purpose`, so no information is lost.
- **Service.** `EmbeddingService.store / indexText / indexStructured /
  search / ftsSearch / hybridSearch / listAll / readById /
  deleteBySource` now take or return `purpose: EmbeddingPurpose`
  instead of `sourceType: string`. `getStats()` returns `byPurpose`.
  `SearchResult.sourceType` → `purpose`. The `purposeFromSourceType`
  shim is removed.
- **API.** `POST /knowledge/search`, `POST /knowledge/index`, and
  `GET /knowledge` rename the request field `sourceType` → `purpose`.
- **MCP tool.** `search_knowledge` argument renames `source_type` →
  `purpose` with an updated description listing the canonical values
  (`document`, `code`, `message`, `image_description`,
  `knowledge_artifact`, `ephemeral`). `read_knowledge` return field
  renames as well.
- **Web.** `/knowledge` page renames every visible reference — types,
  state, query strings, the "Source Type" picker label (now
  "Purpose"), the color/icon registries. New colors for
  `image_description`, `knowledge_artifact`, and `ephemeral`.
- **Other callers.** `rag/health.ts` probe row uses
  `purpose='ephemeral'` + a unique `sourceId` for cleanup;
  `retention-service.ts` orphaned-doc and legacy-ephemeral filters
  use `purpose`; `indexer.ts`, `documents/processor.ts`, and
  `tools/filesystem/index.ts` pass `purpose` directly.

### Memory-redesign cleanup follow-up — Phases A-G (2026-05-16, PR #27)

Seven follow-up phases on top of the original Phase 1-7 audit fixes.
Plan in `.octipus/memory-redesign.md`; commits `fbf2a8f..e416263`.

- **Phase A — clear desk.** Drop unused `SCIM_PATCH_SCHEMA` (biome
  lint); gate the Whisper-dependent voice tests on `WHISPER_BINARY`
  + `WHISPER_MODEL_PATH`; gate the LiteLLMClient-dependent
  embeddings tests on `INTEGRATION=1` so the unit suite is green
  by default; mark `.octipus/memory-redesign.md` as shipped;
  update `docs/QA.md` for the deleted permanent `qa-demo` channel.
- **Phase B — memory finish-the-job.** `recordAgentCompletion`
  derives `task_state.task_kind` from the role (`review` → `review`,
  `qa`/`security` → `finding`, else `agent_output`); new
  `TaskStateRepository.reapOrphans` drops typed-output rows whose
  session was deleted; new `scripts/check-embedding-drift.ts` +
  `db:check-embedding-drift` npm script + boot-time warning when
  the `embeddings` or `memories` table carries multiple distinct
  `embedding_version` values.
- **Phase C — memory user-facing.** PII filter at the judge
  boundary (redact-not-drop, confidence knocked down 0.2 on
  redaction); new `remember_this` orchestrator meta-tool for
  explicit fact promotion through the same judge pipeline; new
  `config.memory.extractionCadence` (`per_turn` / `on_compaction`
  / `off`); new `/memory` web page + `GET/DELETE /api/memory`
  endpoints + supersession-chain viewer + soft-delete (sets
  `valid_until`, preserves audit trail).
- **Phase D — architecture cleanup.** Split retention out of
  `rag/embeddings.ts` (1100+ lines) into
  `rag/retention-service.ts`; remove `compactedSummary` writes
  in favour of the `compaction_entries` log; readers fall back
  to `compactedSummary` only for sessions compacted before this
  change; mark `SessionContext.compactedSummary` `@deprecated`;
  codify the repository-pattern exceptions list in
  `CONTRIBUTING.md`.
- **Phase E — test coverage.** New `scim.test.ts` (8 auth-refusal
  tests against every endpoint); `voice.test.ts` (3 tests for
  unauth + malformed body); `channels/discovery.test.ts` (4 tests
  verifying the shipped channel folders load + uniqueness).
- **Phase F — vector index strategy.** Migration 0055 reads the
  prevailing embedding dimension across `embeddings` and
  `memories`; if homogeneous, `ALTER COLUMN TYPE vector(N)` +
  `CREATE INDEX USING hnsw (vector_cosine_ops)`; if empty,
  no-op; if drifted, `RAISE NOTICE` and skip. Restores HNSW
  performance without locking the deployment into a specific
  embedding model.
- **Phase G — infrastructure & docs.** README documents
  Bun-only server runtime explicitly; mcp-server CI now runs
  `bun run build` + asserts `dist/index.js` exists + `npm pack
  --dry-run` confirms the artefact ships in the tarball.

### Memory-redesign cleanup — Phases 1-7 (2026-05-16, PR #27)

Audit of the just-shipped memory-redesign work surfaced 4 critical
and 11 medium-priority defects. Phases 1-7 closed them.

- **Phase 1 — Phase B + D delivery gaps.** Phase B shipped writers
  but no readers — new `task_state` MCP tool
  (`list_recent_session_tasks`, `read_task_state`) added to the ten
  roles that already carry `knowledge`. `AgentContext.workspaceId`
  typed and threaded from orchestrator → swarm → worker so
  `recordAgentCompletion` finally populates the `workspace_id` FK
  that was previously NULL on every row; `swarmNodeId = agent.id`
  filled too. Memory scope wired to `classification.topic` instead
  of the constant `'orchestrator'`. `updateMemoriesAfterTurn`
  receives the just-persisted user message id and the last three
  turns. Plan-execute and expert paths now fire memory.
- **Phase 2 — schema cleanup.** Migration 0054 adds the real FK on
  `embeddings.doc_id` with `ON DELETE CASCADE` (Phase C declared the
  column but not the FK); recreates
  `memories_user_scope_type_active_idx` as a partial index
  (`WHERE superseded_by IS NULL`); refreshes the stale Phase 0/4
  nullable-userId comments on `embeddings`.
- **Phase 3 — code quality.** Replace `sql.raw` vector-literal
  splicing with parameterised binds in `memories.searchSimilar` and
  `rag.hybridSearch`. Memory judge uses the canonical
  `buildEmbeddingVersion` helper and hoists the embedding-model
  lookup out of the per-candidate loop. `renderMemoriesBlock`
  surfaces confidence next to inferred facts (`p<0.9`). Dead
  `retrieveSemantic` removed (silent factType default violated
  fail-loud). Dead "duplicates" cleanup pass removed (Phase A unique
  index makes duplicate inserts impossible).
  `cosineSimilarity` / `l2Distance` typed `column: AnyPgColumn`.
- **Phase 4 — test coverage.** 9 integration tests for
  `MemoryRepository` (supersede atomic, user isolation,
  `OR(NULL, scope)` filter, retrieveTop ordering, supersession
  chains, non-finite vector rejection, empty vector early-return);
  9 unit tests for confidence rendering + extractor boundary cases.
- **Phase 5 — small cleanup.** Delete dormant
  `src/channels/qa-demo/`; log on the `discovery.test.ts` teardown
  failure instead of a bare `catch {}`.
- **Phase 6 — npm posture.** Root package marked `private: true`
  with `license` + `repository`; mcp-server now ships `dist/` via
  `files: ['dist', 'README.md']` and a `prepublishOnly` script;
  versions synced.
- **Phase 7 — focused coverage.** `rate-limiter.ts` 0% → 85% via 13
  unit tests; `org-membership.ts` eager paths 0% → 100% via 5 tests.

### Memory-redesign — final wiring (2026-05)

Closes the two deferred "ships disabled" pieces left from the phase
batch so nothing in `.octipus/memory-redesign.md` remains a leftover.

- **Memory layer is now wired into the orchestrator turn.**
  `OrchestratorService.handleMessage` fetches the top-N active
  memories scoped to `(userId, agentScope='orchestrator')` once per
  turn and threads the rendered block into both the orchestrator's
  own system prompt and the `directResponse` system prompt via a new
  optional `extraSystemContext` parameter. After the response is
  produced, a fire-and-forget `updateMemoriesAfterTurn` extracts /
  judges / persists new facts. Auto-no-ops when (a) no model is
  bound to topic `memory_extraction` (extractor skips, no LLM call)
  or (b) the memories table is empty (retrieval returns empty,
  prompt unchanged). Zero behaviour change until the operator binds
  the extraction model.
- **`SearchResult` surfaces ancestor heading path.** `search`,
  `ftsSearch`, and `hybridSearch` now project `section_path` +
  `heading_level` so callers can render structural context next to
  a hit without a second query. `getAncestorHeadings` remains for
  callers that need the full ancestor row objects (abstracts etc).

### Memory-redesign Phase D — memories layer (2026-05)

Atomic, updatable long-term memories. Distinct from RAG embeddings
(content chunks) and `task_state` (per-session workflow). One row =
one fact about the user with ADD/UPDATE/DELETE/NOOP semantics driven
by an LLM judge.

- **New table `memories`** (migration `0053`) with self-FK
  `superseded_by` (never destructive — updates insert a new row and
  link the old). `memories_active` view filters superseded + expired
  so callers don't have to remember the predicate.
- **`src/core/memory/`** — `repository.ts` (typed CRUD, vector-scoped
  search, LFU-ordered retrieval), `extractor.ts` (LLM call: latest
  user turn → candidate facts, short-circuits on no-first-person
  turns), `judge.ts` (embed candidate, find closest existing match,
  LLM picks action, apply), `retrieval.ts` (turn-start hot list +
  `renderMemoriesBlock` for system-prompt injection).
- **ModelRegistry**: new topic `memory_extraction` (cheap model;
  extractor + judge bind to it).
- **Not auto-wired into the orchestrator.** The operator must first
  bind a model to `memory_extraction`; the wiring into
  `OrchestratorService.handleMessage` ships separately so per-turn
  LLM spend turns on deliberately.

### Memory-redesign Phase E — image-purpose tagging (2026-05)

Vision-derived rows in `embeddings` (vision-LLM caption + OCR for an
image upload) are now tagged `purpose='image_description'` at write
time, so the retention policy for images can diverge from the
document retention policy without a schema change. No vector model
or storage layer added.

### Memory-redesign Phase C — document hierarchy (2026-05)

A chunk now knows its section path. Retrieval can pull "Clause 4.2"
plus its ancestor headings into the prompt without extracting a
knowledge graph.

- **Migration `0052`** adds `parent_chunk_id` (uuid, self-FK
  ON DELETE SET NULL), `section_path text[]`, `heading_level
  smallint`, `doc_id uuid` to `embeddings`. GIN index on
  `section_path` for path queries.
- **`src/core/rag/markdown-chunker.ts`** walks Markdown, emits one
  chunk per heading and one per body block, threads `parentIndex`
  so callers can resolve `parent_chunk_id` after insert. ATX
  headings only; fenced code blocks pass through verbatim.
- **`EmbeddingService.indexText`** dispatches to the structural
  chunker when the content (or `metadata.filePath`) looks like
  Markdown. Other content types keep using the flat chunker.
- **`EmbeddingService.getAncestorHeadings(chunkId)`** walks the
  parent chain for retrieval-side ancestor injection (wiring into
  the orchestrator ships in a follow-up).

### Memory-redesign Phase A.5 — retention_policies (2026-05)

Per-purpose retention replaces the hardcoded 30-day sweep.

- **Migration `0051`** adds `retention_policies(purpose pk,
  max_age_days, lfu_min_access, lfu_min_age_days, notes, updated_at)`
  seeded with the defaults from
  `.octipus/memory-redesign-schema.sql`.
- **`EmbeddingService.cleanup`** now runs a per-purpose pass first
  (age cap OR cold-and-stale LFU per row). Result adds
  `byPurpose: Record<string, number>`. Legacy passes
  (orphaned-docs / short-entries / duplicates) remain as backstop
  for non-purpose rows.

### Memory-redesign Phase B.2 — LISTEN subscriber (2026-05)

Closes the deferred follow-up from Phase B. Sibling agents can now
react to peer completions without polling.

- **`src/db/task-state-listener.ts`** wraps a dedicated postgres-js
  connection (max=1, separate from the query pool — LISTEN ties up a
  socket). `subscribeTaskState(sessionId, handler)` returns an
  unsubscribe function; multiple subscribers on the same session
  share one upstream LISTEN via reference counting.
- Embedded (PGlite) mode returns a no-op subscriber — readers must
  poll. Same trade-off as the rest of embedded mode.
- Shutdown hook wired into SIGTERM/SIGINT so the dedicated
  connection closes cleanly on process exit.

### Memory-redesign Phase B — workflow state out of RAG (2026-05)

Sibling agents stop discovering each other's results through cosine
similarity over chunked text and start reading typed SQL rows.

- **New table `task_state`** (migration `0050`) with per-session
  LISTEN/NOTIFY trigger (`task_state_<session_id>`). Holds the typed
  durable record of agent work: inputs, outputs (jsonb), status,
  depends_on, error. Indexed by `(session_id, created_at)` for
  sibling-discovery reads.
- **`src/core/rag/auto-indexer.ts` deleted.** Agent outputs no longer
  land in the `embeddings` table — they were polluting cosine search
  (a 4 KB trace ranked against a one-line user preference). Replaced by
  `src/core/agent-task-recorder.ts`, which calls
  `TaskStateRepository.create` with the same skip-rules (orchestrator
  outputs and outputs < 100 chars are still skipped).
- **`TaskStateRepository`** added with create / complete / fail /
  updateStatus / getById / listSessionRecent / listByOwnerStatus /
  deleteDoneOlderThan. Long-lived LISTEN subscriber deferred to a
  follow-up so the connection-management story can land as its own
  reviewable change.
- **Knowledge tool + Web** drop `agent_output` from the
  `search_knowledge` source-type filter (and the Web Knowledge page
  loses the orange "Agent Output" stats tile / filter option). The RAG
  cleanup pass keeps the old branch but now matches
  `purpose='ephemeral' OR source_type='agent_output'` — steady-state
  count is expected to stay at 0.

### Memory-redesign Phase A — embeddings purpose + versioning (2026-05)

See prior batch c entry below for the artifacts/single-user batch.

- Adds `purpose`, `content_sha256`, `embedding_version`,
  `access_count`, `last_accessed_at` to `embeddings`. Migration `0049`
  truncates and adds NOT NULL columns plus a UNIQUE
  `(purpose, source_id, content_sha256)` dedup index.
- Write path: app-side SHA-256 + `embedding_version` (`<model>/<dim>`).
  ON CONFLICT (dedup key) DO UPDATE just refreshes `last_accessed_at`,
  so re-indexing unchanged content is a no-op.
- Read path: `search` / `ftsSearch` / `hybridSearch` fire-and-forget
  bump `access_count` + `last_accessed_at` on returned rows.

### Live artifacts + single-user fixes (2026-05 batch c)

Bug-fix and DX batch surfaced while bringing the live-artifacts feature
end-to-end in a single-user install.

- **Single-user mode now provisions a default workspace.** The artifacts
  feature (and any other workspace-scoped surface) previously 500'd in
  single-user installs because `resolveWorkspace` returned
  `workspaceId: null` when `multiuser.orgWorkspaces` was off. The flag
  is now correctly scoped to *multi-workspace switching*; real users
  always get a default workspace. `/api/me/workspaces` GET is no longer
  flag-gated (mutations stay gated).
- **Artifact pages render in iframes again.** The global
  `X-Frame-Options: DENY` middleware was overriding the per-artifact CSP
  and blocking the same-origin embed iframe. Artifact routes (`/a/*`,
  `/__artifacts__/*`) now skip the global XFO + generic CSP and rely on
  the per-artifact CSP with `frame-ancestors`.
- **Swarm token-budget changes now apply to running sessions.**
  `deriveChildBudget` re-reads `swarm.levelDefaults.*.tokens` from
  current config on every spawn instead of using the snapshot captured
  at root-node creation, so raising the cap via the settings UI takes
  effect on the next child spawn. Decreases still need a session
  restart (we never shrink a parent's effective cap below `used`).
- **Artifacts tool now reachable by agents.** The `artifacts` tool was
  registered but no role's `toolIds` included it, so orchestrator
  routing fell through. Added to `general` and `data` roles, with
  matching classifier keywords ("live artifact", "dashboard", "rss
  feed", etc.).
- **Tighter artifact tool descriptions + validation.**
  `create_live_artifact` / `update_live_artifact` now spell out the
  template ↔ source coupling rule, the visibility consequence
  (`workspace` returns 404 to anonymous viewers), and the auto-refresh
  wake-gate. `sources` param gains per-kind config examples; `kind` and
  `visibility` get enum constraints. The server cross-checks
  `{{data.<name>.…}}` references against attached sources and returns
  any mismatches in a new `warnings[]` field. Create now returns
  `embedUrl` + `outerUrl` + `visibility` + `warnings`.

### Multi-user + TUI follow-ups (2026-05 batch b)

Carry-overs from the May feature work — the Web UI / org-shared
resources / vault workspace / SSO / billing / TUI iteration v2
items the prior multi-user and pi-tui PRs deferred.

#### Web

- **Workspace + org pickers.** `WorkspaceProvider` now wraps the
  app under `AuthProvider`. Header gets a workspace combobox that
  lists the user's workspaces, supports inline "Create
  workspace…", and (for admins) shortcuts to `/admin/orgs`. The
  picker writes the active workspace id to `localStorage` under
  `octipus.activeWorkspace` and tells the API client the active
  *slug*, which is sent on every request as `X-Octipus-Workspace`.
- **Admin orgs page** at `/admin/orgs`: list, create, expand to
  view members. Uses the existing `/api/admin/orgs` surface; gated
  on `multiuser.orgWorkspaces` (returns 404 → page renders an
  inline "feature is disabled" hint).
- **Secrets page** wires the active workspace through: GET `/vault`
  passes `?workspaceId=<id>`, the Add modal exposes a Scope select
  (User / Workspace) when a workspace is active, and workspace-scoped
  secrets are listed alongside user-scoped ones.

#### Backend

- **`org_id` on `model_config` and `skills`** (migration `0042`).
  Visibility rule `org_id IS NULL OR user_id = U OR org_id IN
  org_members(U)` lives in `src/services/org-membership.ts` and is
  applied by `SkillRepository.findAll`, the `/api/skills` GET, and
  the new `ModelRegistry.getModelsForUser` (admins still see
  everything via the existing `getAllModelsIncludeDisabled`). New
  endpoints: `POST /api/admin/orgs/:id/{models,skills}` to assign
  rows to an org, `DELETE` to unassign.
- **Vault `scope=workspace` on the route.** POST accepts `scope`
  (`system | user | workspace`) + `workspaceId`; GET accepts
  `?workspaceId=` and forwards it to `vault.list`. The DEK
  derivation, encryption, and read path landed in Phase 4
  follow-up; this is the route surface that exposes them.
- **SCIM 2.0** at `/api/scim/v2`: List / Get / Create / PATCH /
  DELETE Users + List Groups, RFC-7643/7644 shapes. Per-org Bearer
  auth — the token is stored in vault under `scope='system'` and
  referenced by `org_sso_config.scim_token_vault_ref`. Auth-guard
  exempts `/api/scim/`; the routes do their own bearer check.
- **SAML SSO** at `/api/saml/:orgSlug/{metadata,login,acs}`,
  fully implemented via `samlify`. Migration `0043_org_sso_config`
  adds the per-org config (entityId, ssoUrl, x509Cert, attributeMap,
  plus the SCIM token ref). On a successful ACS the handler
  verifies the assertion signature, maps attributes via the org's
  `samlAttributeMap` (defaults match Okta/Azure AD/OneLogin),
  upserts the user, ensures `org_members` membership, and mints
  the same `session_token` HttpOnly cookie the password-login
  path uses. RelayState is honored but sanitized to same-origin
  paths. New `GET/PATCH /api/admin/orgs/:id/sso` endpoint and
  admin web page at `/admin/orgs/[id]/sso` for IdP paste-in
  config (entity ID, SSO URL, x509 cert, attribute map, SCIM
  toggle + vault-ref). Schema validator defaults to a noop;
  operators wanting strict XSD validation can install
  `@authenio/samlify-xsd-schema-validator` and set
  `SAML_SCHEMA_VALIDATOR=strict`.
- **Billing hooks.** `BillingProvider` interface
  (`src/services/billing/provider.ts`) with `noop` (default) and
  `stripe` (stub) implementations, env-gated by `BILLING_PROVIDER`.
  `CostTracker.logUsage` fires `recordUsage` after every cost-log
  insert — fire-and-forget so a billing outage never blocks chat.
  New `GET /api/admin/orgs/:id/usage` aggregates spend per org
  (joins `cost_log` to `org_members`).

#### TUI

- **Tree-sitter highlighter.** `web-tree-sitter` +
  `tree-sitter-{typescript,python,rust,go,java}` are dependencies;
  grammar `.wasm` files load directly from `node_modules/` via
  `Bun.resolveSync`. `setHighlighter()` is hooked at startup; the
  buffer-oriented adapter parses on `setSource(lang, text)` (called
  on every `openFile`) and caches per-line tokens. Falls back to
  the regex highlighter on grammar-load failure or for languages
  without a grammar (markdown, yaml, …).
- **Workspace-switch instant reconnect.** `GatewayAdapter` gained
  `reconnectWithWorkspace(slug)` — closes the WS, swaps the slug,
  reuses the exponential-backoff reconnect. New `/workspace
  <slug>` slash command (or `/workspace -` for the default).
- **Scrollable messages pane.** PageUp / PageDown move
  `scrollOffset` in 30-row pages; an `↓ N newer messages`
  indicator surfaces when the user is reading history. New
  messages auto-pin to the bottom *only* when the user is
  already there, so a long agent reply mid-scroll doesn't yank
  history away.
- **Vim named registers + IME-aware INSERT.** `VimState.registers`
  is a `Record<string, string>` keyed by register name. `"x` in
  NORMAL mode selects the register for the next `y` / `d` / `p`,
  then resets to the default `"` register. New `VimKey.composing`
  flag suppresses leader matching during IME composition so a
  multi-byte CJK / dead-key sequence can't fire `gg` / `dd` /
  `yy` mid-compose.

#### Migrations

- `0042_org_scoped_models_skills.sql` — adds `org_id` columns + indexes.
- `0043_org_sso_config.sql` — per-org SAML + SCIM config.

Both are additive and idempotent (`IF NOT EXISTS`); single-user
installs see no behavior change.

### Multi-user is the default

Multi-user isolation (`multiuser.enabled`, `enforcePermissions`,
`orgWorkspaces`) flipped from opt-in to default-on. The
`MASTER_KEY` Bearer fallback is suppressed by default — every
HTTP and WebSocket request now must carry either a real session
token (cookie, after logging in) or a personal `octi_…` api
token. Existing installs that want the legacy single-user path
can set `MULTIUSER=false` in `.env`.

#### Master key role
- Stays as the **vault encryption root** (HKDF derives per-user
  DEKs from it). Rotating the master key still goes through
  `scripts/rotate-vault-keys.ts`.
- No longer authenticates HTTP / WS clients on its own. The
  Bearer fallback remains only when `multiuser.enabled=false`.

#### MCP / CLI clients — automatic bootstrap token
- On startup (when multi-user is on), the backend mints a
  personal api token named `mcp-bootstrap` for the first active
  admin user and writes the plaintext to `~/.octipus/mcp-token`
  (mode 600). Idempotent — a second restart keeps the existing
  token if the file + DB row are still valid.
- `bin/octi` now reads `~/.octipus/mcp-token` first when
  regenerating `.mcp.json` and the user-scope `gemini mcp`
  registration. The .mcp.json regen is called twice during
  `octi start` — once before launching the backend (so legacy
  installs still work) and once after backend health (so the
  freshly minted bootstrap token lands in the file). Rotating
  the MCP key is now `rm ~/.octipus/mcp-token` then
  `octi restart`.

#### WebSocket gateway accepts api-tokens
- `connection-manager.ts:auth_method=api_key` previously matched
  only against `MASTER_KEY`. It now validates `octi_…` tokens
  against the `api_tokens` table (the same path the REST `.derive`
  middleware uses) and only honors `MASTER_KEY` when multi-user
  is off. The browser extension's WS connection now works with
  any personal api token from Settings → API Tokens.

#### Bug fixes from the QA exercise
See the previous Unreleased entries — this release rolls them in:
session 404 status leak, missing `multiuser.orgWorkspaces` registry
entry, env-var fallback dead in `settings-service.warmCache`, admin
sidebar nav, impersonation banner placement, and `session.token`
splicing for `/admin/impersonate/*`.



### TUI rewrite on pi-tui

Both terminal surfaces — the chat shell (`octi tui`,
`src/tui-pi/`) and the editor (`octi edit`, `src/tui-editor/`) —
were rewritten on top of [`@mariozechner/pi-tui`](https://www.npmjs.com/package/@mariozechner/pi-tui),
replacing the previous Ink (React for the terminal) implementation.

#### Why
- Pi-tui's differential renderer is materially faster on long chats
  and large file buffers (only changed cells are written; no virtual
  DOM diff).
- The same `Editor` primitive backs **both** the chat composer and
  the file-buffer editor, so paste markers, undo, history nav,
  fuzzy file completion (`@…`, `./…`), and slash-command
  autocomplete behave identically across surfaces.
- Pi-tui exposes a small `KeybindingsManager` we extend with app
  ids (`app.palette.open`, `app.tree.toggle`, …) and let users
  override via `~/.octipus/keybindings.json`.

#### Chat shell (`octi tui`)
- Status bar + welcome + scrolling messages pane (markdown for
  assistant, plain wrap for user/system).
- Composer with slash command + fuzzy file autocomplete.
- Activity line (live tool spinner with hold-on-completion).
- Permission prompt overlay, command palette (`Ctrl+P` / `F4`).
- TUI-local commands `/exit`, `/quit`, `/cost`, `/project`
  short-circuit before hitting the gateway; everything else flows
  through the standard slash registry.

#### Editor (`octi edit`)
- Three-pane layout (file tree / buffers / chat) with `Ctrl+B`,
  `Alt+J`, `Ctrl+\` toggling and `Alt+,` / `Alt+.` cycling buffers.
- File picker (`Ctrl+O`) with case-insensitive substring filter on
  the relative path.
- Find / replace overlays, diff overlay (accept/reject agent edits),
  workspace picker, MCP server list, scrollable hotkeys overlay (`F5`).
- Vim mode toggle (`editorMode: 'modeless' | 'vim'`) covering
  hjkl / w / b / 0 / $ / gg / G / i / a / o / O / v / x / dd / yy
  / p / u / Ctrl+R, with VISUAL-mode delete + yank.
- Persisted layout / cursor / open-buffer state at
  `~/.octipus/tui-editor.json`.
- New `octi edit` command in `bin/octi`.

#### Key-binding rationale (defaults avoid terminal collisions)
- `Ctrl+M`, `Ctrl+H`, `Ctrl+J`, `Ctrl+I`, `Ctrl+[` are
  indistinguishable from `Enter`, `Backspace`, `LF`, `Tab`, `Esc`
  on terminals without the Kitty keyboard protocol — none are
  bound by default. (`Ctrl+H` was previously `app.replace.open`
  and `Ctrl+M` was `app.mcp.list`; both silently ate `Enter` /
  `Backspace` in overlays.)
- `Ctrl+Tab` doesn't reach most terminals — buffer cycle moved to
  `Alt+,` / `Alt+.` (also `F2` / `F3`).
- `F1` is hijacked by many terminals as a help key — hotkeys
  overlay rebound to `F5`.

#### Glyphs
- Tree / status emojis replaced with a glyph table that defaults
  to ASCII (`[+]`, `·`, `❯`) on terminals whose fonts lack the
  emoji subset, and switches to emoji only when a known
  emoji-capable terminal is detected (`kitty`, `wezterm`,
  `iterm.app`, `vscode`, `apple_terminal`, `ghostty`). Override
  with `OCTIPUS_TUI_ICONS=emoji|ascii`.

#### E2E tests
- New harness at `tests/tui/harness.ts` (spawn under fixed
  `COLUMNS` / `LINES`, send raw bytes, ANSI-strip, `waitFor`).
- Suites `tests/tui/chat.e2e.test.ts`, `tests/tui/editor.e2e.test.ts`
  cover launch, focus cycling, slash commands, the picker filter,
  the command palette, and `/quit` exit code. Skipped when the
  gateway isn't reachable.

#### Notable bug fixes during the rewrite
- Chat submit dropped to a no-op because the editor's
  `submitValue()` clears state *before* invoking `onSubmit`, and
  the host then read back the (empty) state via
  `getExpandedText()`. Now uses the `rawText` argument the editor
  passes through.
- Editor pane height collapsed to the floor (5 rows) via a
  feedback loop where `setHeight(N)` was sourced from the previous
  render's `editorLines.length`. Heights now derive from
  `tui.terminal.rows` directly.
- Markdown hyperlinks (`OSC 8`) leaked into the visible-width
  count so cursor moves shifted the editor↔chat divider in by ~7
  cells. `SplitPane.fitTo` uses pi-tui's `visibleWidth` (CSI + OSC
  + wide-char aware).
- Hotkeys overlay shrank instead of scrolling — it now reads the
  terminal height (matching the 85% `maxHeight` in
  `overlays/registry.ts`), reserves rows for chrome, and emits a
  fixed-size viewport every render with a position indicator.

## 2026-05 — Multi-user feature complete

The multi-user architecture has reached feature completeness across
five phased PRs (0–4 + Phase 4 follow-ups). Every behavioral change
is gated behind a feature flag that defaults off; existing single-
user installs see byte-for-byte unchanged behavior until an operator
flips a flag.

Full design + per-phase rationale lives in
[`docs/architecture/MULTI-USER.md`](docs/architecture/MULTI-USER.md).
Manual validation steps in
[`docs/QA.md` §7](docs/QA.md#7-multi-user--full-feature-exercise).

### Added

- **Identity primitives.** `Principal` type + `principalFromUser` /
  `principalFromMasterKey` / `ANONYMOUS_PRINCIPAL` /
  `SYSTEM_PRINCIPAL`. Server `.derive()` produces it on every
  request alongside the legacy `user`.
- **Scoped repositories.** `scopedRepos(principal)` factory wraps
  eight entities (sessions, messages, agents, documents,
  notifications, trajectories, hooks, pipelines). Cross-tenant
  reads collapse to `null`/`[]` so attackers can't enumerate UUIDs.
- **Vault scoping.** `scope` enum (`system`/`user`/`workspace`),
  per-user data-encryption keys via
  `HKDF(masterKey, salt=userId, info=scope:userId)`, opportunistic
  v1 → v2 re-encryption on read,
  `scripts/rotate-vault-keys.ts` for batch rotation, master-key
  rotation tooling (`scripts/rotate-master-key.ts`).
- **Per-user workspace filesystem.** `WorkspaceFS.forAgent(ctx)`
  with traversal / absolute-path / symlink-escape blocks.
  Filesystem tools rewired through it so single-user (flat) and
  per-user (nested) layouts share one call site.
- **Personal access tokens.** `octi_<43-char-base64url>` Bearer
  format with SHA-256 hash storage. `/api/auth/api-tokens` CRUD
  + web UI under `/settings/api-tokens`. Lets CI / MCP /
  scripted clients authenticate as a real user.
- **Admin console.** `/admin/users`, `/admin/audit`,
  `/admin/quotas`, `/admin/impersonate`. User CRUD, audit log
  viewer with filters, per-user quota dashboard, "Act as" with
  banner.
- **Channel binding.** `channel_identities` table + manager with
  O(1) `(channel_type, external_id)` lookup. JSONB fallback +
  lazy backfill for legacy bindings. Web `/link-account` page
  + 6-character one-time codes.
- **Postgres Row-Level Security.** 19 user-owned tables get
  `enable rls + policy` with the "bypass on missing GUC" pattern.
  `withRlsPrincipal(principal, fn)` / `withRlsBypass(fn)`
  wrappers. Defense-in-depth alongside the application-layer
  scoping.
- **Quotas.** Per-user concurrent-agents / daily-tokens /
  API-rate caps. Admin REST + web; runtime enforcement in
  `agent-manager.spawn()`, `agent-worker` pre-LLM-call, and the
  rate-limit middleware. `QuotaExceededError` returned as `429`.
- **Admin impersonation.** `impersonation_sessions` table +
  `ImpersonationManager`. Server `.derive()` swaps the request's
  identity to the target user but stamps `principal.actorUserId`
  so audit can dual-tag (every state-changing request writes one
  row keyed under the actor and one under the target).
- **Shell sandbox.** bubblewrap / firejail wrapper
  (`security.shellSandbox = 'off' | 'auto' | 'required'`) for the
  shell tool. Pairs with WorkspaceFS for filesystem-level +
  process-level isolation.
- **Docker tool isolation.** Per-user `octipus.user_id=<uuid>`
  label + `octipus_user_<short-uuid>` bridge network.
  `list_containers` filters; targeted ops verify ownership via
  `docker inspect` and surface mismatches as "container not
  found" so attackers can't enumerate.
- **Org / workspace scaffolding.** `organizations` +
  `org_members` + `workspaces` tables.
  `OrgWorkspaceManager` with admin-gated org CRUD, per-user
  workspace CRUD, atomic default-promotion via tx, "cannot
  delete default" guard.
- **Workspace_id adoption.** Nullable `workspace_id` on every
  user-owned table (sessions, documents, hooks, agents,
  notifications, trajectory_runs, pipelines, embeddings,
  agent_events, swarm_nodes, vault). FK `ON DELETE SET NULL`
  so workspace deletion falls back to user-level rather than
  cascading. ScopedRepos filter on
  `(workspace_id = $1 OR workspace_id IS NULL)` and stamp the
  principal's workspaceId onto new rows.
- **Workspace resolver.** `X-Octipus-Workspace` request header
  (slug / uuid / `all` / `default`) maps to a workspace owned by
  the principal. Cross-tenant headers collapse to default.
- **Backfill script.** `scripts/backfill-workspace-id.ts` walks
  every user, ensures a default workspace, and updates rows
  with NULL `workspace_id` across all 11 user-owned tables.
  Idempotent (`--dry-run`, `--user=<uuid>`).
- **REST surface.** `/api/me/workspaces` + `/api/me/orgs`
  (caller-scoped) and `/api/admin/orgs` (admin) surface the
  org/workspace data.

### Configuration

New feature flags (all default off):

| Flag | Env | Default | Effect |
|------|-----|---------|--------|
| `multiuser.enabled` | `MULTIUSER` | `true` | Master switch. Strict scoped reads, audit logging, and MASTER_KEY bypass disabled. Opt out with `MULTIUSER=false` for the legacy single-user / MASTER_KEY path. |
| `multiuser.auditShadow` | `MULTIUSER_AUDIT_SHADOW` | `true` | Writes one `audit_log` row per state-changing API request (no behavioral effect). |
| `multiuser.enforcePermissions` | `MULTIUSER_ENFORCE_PERMISSIONS` | `true` | Orchestrator gate: every tool call goes through `checkToolCall`. The legacy `isSystemUser` bypass is honored only when this is `false`. |
| `multiuser.rlsEnabled` | `MULTIUSER_RLS` | `false` | Sets the RLS GUC on every authenticated query. PGlite ignores. Requires a non-superuser app role; opt-in. |
| `multiuser.orgWorkspaces` | `MULTIUSER_ORG_WORKSPACES` | `true` | Enables `/api/me/workspaces`, `/api/me/orgs`, `/api/admin/orgs`, the workspace resolver, and scopedRepo workspace filtering. |
| `security.shellSandbox` | `SHELL_SANDBOX` | `off` | `off` / `auto` / `required` — wraps shell-tool spawns in bubblewrap/firejail. |
| `security.dockerIsolation` | `DOCKER_ISOLATION` | `off` | `off` / `enforce` — Docker tool per-user labels + networks. |

### Tests

- 11 new test files added under `src/security/` and
  `src/db/repositories/` covering the multi-user changes
  (scoped repos, vault DEK + isolation, RLS gating, quotas,
  impersonation, shell sandbox, docker isolation, orgs,
  workspace resolver, workspace-scoped repos, channel
  bindings).
- 6 isolation test files under `src/api/routes/` for
  cross-tenant 404 collapse on every changed route.
- Total impact: ≈ +130 multi-user tests.

### Documentation

- [`docs/architecture/MULTI-USER.md`](docs/architecture/MULTI-USER.md)
  — design doc, threat model, per-phase implementation notes.
- [`docs/QA.md` §7](docs/QA.md#7-multi-user--full-feature-exercise)
  — manual validation steps for the full multi-user feature.
- This `CHANGELOG.md`.

### Out of scope (future)

- Web UI workspace + org pickers (REST surface is in place).
- Org-shared resources (system models, shared skills) routed
  through `org_members` — needs `org_id` on `models` and
  `skills` first.
- SCIM provisioning + SAML SSO.
- Per-user billing hooks.
