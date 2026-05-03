# Roadmap

> **Note.** Directions, not promises. Items move, get reshaped, or get dropped as the project learns. If something here is interesting, open an issue and let's talk before you build.

This doc lists what we are exploring. Order inside each section is rough priority, not strict sequencing. PRs welcome on anything marked **Help wanted**.

---

## Now (in flight)

- **Multi-user architecture — Phases 0–3 landed (2026-05).**
  Octipus is moving from single-tenant self-hosted to a central backend
  serving multiple authenticated users with strict isolation of
  sessions, secrets, settings, filesystem, embeddings, and agents. Full
  plan: [`docs/architecture/MULTI-USER.md`](docs/architecture/MULTI-USER.md).

  **Integration state.** All work is gated behind feature flags
  (`MULTIUSER`, `MULTIUSER_AUDIT_SHADOW`, `MULTIUSER_ENFORCE_PERMISSIONS`)
  that default off. Existing single-user installs see byte-for-byte
  unchanged behavior; the new code paths only activate when an operator
  flips the flag. **1107 pass / 9 fail / 62 skip** on the merge branch
  (the 9 are the same pre-existing `StdioTransport` MCP tests from
  before the work started); net **+92 isolation tests** added across
  the phases. Branch:
  `claude/multi-user-architecture-plan-baDCd`.

  **Done so far.**
  - Phase 0 (commit `90347f7`): `Principal` type +
    `principalFromUser`/`principalFromMasterKey`/`ANONYMOUS_PRINCIPAL`/
    `SYSTEM_PRINCIPAL`, server-side derivation alongside legacy `user`,
    shadow-mode audit middleware (`audit_log` row per state-changing
    request, never blocks), schema additions for nullable owner columns
    on `embeddings`, `agent_events`, `swarm_nodes`, `hook_executions`,
    plus `users.org_id` (migration `0029`).
  - Phase 1a (commits `9d1f859`, `c3330b8`, `15a773d`, `f5251a7`):
    `scopedRepos(principal)` factory binding 8 entities (sessions,
    messages, agents, documents, notifications, trajectories, hooks,
    pipelines). Cross-tenant reads return `null`/`[]` to prevent UUID
    enumeration; mutations check ownership in WHERE and strip
    caller-smuggled `user_id`. **Two complete-bypass auth gaps closed**:
    `PUT/DELETE /api/pipelines/templates/:id` had no auth check at all
    (any user could mutate any template, including system presets);
    `GET /api/chat/approvals/pending` was global; `markRead` on
    notifications accepted any id; trajectories listed every user's
    runs. 11 routes converted across 4 commits.
  - Phase 1b (commits `3e60b77`, `07ee462`): vault `scope` enum
    (`system`/`user`/`workspace`) with backfill + strict reads (kills
    the `getSystemSecret` fallback that scanned every user's secrets);
    per-user data-encryption keys via `HKDF(masterKey, salt=userId,
    info=scope:userId)` with opportunistic v1 → v2 re-encryption on
    read; `scripts/rotate-vault-keys.ts` for batch rotation;
    `WorkspaceFS` per-user filesystem sandbox with traversal /
    absolute-path / symlink-escape blocks; `src/tools/filesystem`
    rewired through `WorkspaceFS.forAgent(context)` so flat
    (single-user) and per-user nested layouts share one call site.
    Migrations `0030` + `0031`.

  **Done so far (continued).**
  - Phase 1c (PR #4): `permissionManager.approve/deny` cross-tenant
    guard — pre-PR any caller with a leaked `requestId` could resolve
    another user's pending permission request. The legacy
    `isSystemUser` bypass in `BaseTool.executeWithMiddleware` now
    gates on `multiuser.enforcePermissions`. Closes Phase 1.
  - Phase 2a backend (this PR): personal access tokens. New
    `api_tokens` table (migration `0032`); `octi_<43-char-base64url>`
    bearer format with SHA-256 hash storage; `.derive()` accepts
    api-token Bearer between session validation and the legacy
    `MASTER_KEY` fallback; `/api/auth/api-tokens` CRUD with
    cross-tenant safety. Lets CI / MCP / scripted clients
    authenticate as a real user once `MULTIUSER=true` is flipped.

  **Done so far (continued).**
  - Phase 2b/2c/2d (this PR): API tokens web UI, admin console
    (`/admin/users` + `/admin/audit`), and channel binding —
    `channel_identities` table (migration `0033`), 6-char one-time
    code redemption flow, web `/link-account` page. Lazy backfill
    from legacy `users.channelBindings` JSONB column on first read.

  **Done so far (continued).**
  - Phase 2e: channel adapters swap to
    `channelBindingManager.findUserRecordByExternalId`. O(1) on the
    new `(channel_type, external_id)` unique index, with the
    manager's JSONB fallback + lazy backfill so legacy bindings keep
    resolving. `channels/linking.ts` is now a thin bridge over the
    manager; codes live in `channel_link_codes` (Postgres, 15-min
    TTL) instead of Redis. Phase 2 is closed.
  - Phase 3a: master-key rotation tooling.
    `rotateVaultRowMasterKey(rowId, oldMaster, newMaster)` helper +
    `scripts/rotate-master-key.ts` walker (`--dry-run`, `--batch=N`).
    Idempotent re-runs return `'skipped'` for rows already rotated.
    Cross-user isolation preserved across the rewrite — alice's DEK
    still can't decrypt bob's row.
  - Phase 3b (this PR): Postgres Row-Level Security on the
    highest-value tables (sessions, vault, api_tokens,
    channel_identities). New `withRlsPrincipal(principal, fn)` /
    `withRlsBypass(fn)` wrappers; `multiuser.rlsEnabled` flag
    (default off). Policies use the "bypass on missing GUC" pattern
    so existing code paths keep working when the flag flips on.
    PGlite ignores RLS — embedded installs unaffected; external
    Postgres needs a non-superuser app role for enforcement to
    actually fire.

  - Phase 3b-2 (this PR): extend RLS to the remaining user-owned
    tables. Migration `0035` covers documents, agents, agent_events,
    embeddings, hooks, hook_executions, pipelines, pipeline_stages,
    notifications, trajectory_runs, swarm_nodes, recurring_tasks,
    skill_permissions, permission_requests, plus messages and
    pipeline_stages via FK subqueries. Every user-owned table in the
    schema now has a policy — 19 in total.
  - Phase 3c-1 (this PR): per-user quotas — schema + read-side
    QuotaManager + admin REST + `/admin/quotas` web tab. Three
    dimensions (concurrent agents, daily tokens, API calls/min);
    each has a per-user override that falls back to the global
    config default. **No enforcement yet** — operators can see +
    set caps, and 3c-2 wires the runtime gates.
  - Phase 3c-2 (this PR): runtime quota enforcement.
    `QuotaExceededError` thrown by three gates, all conditional on
    `multiuser.enabled`:
    1. `agent-manager.spawn()` — concurrent-agents check after the
       global cap.
    2. `agent-worker` pre-LLM-call — daily token aggregate check
       next to the existing per-agent budget.
    3. `rate-limit` middleware — per-user API calls/min sliding
       window for `/api/*` (auth `/api/auth/*` IP layer unchanged).
    Phase 3c is now complete.
  - Phase 3d (this PR): admin impersonation. New
    `impersonation_sessions` table (migration `0037`), short-lived
    "act as" window keyed by SHA-256 of the admin's session token.
    Auth-derive middleware swaps the request's identity to the
    target user; audit-shadow middleware dual-tags every state-
    changing request under both actor and target. Web banner +
    "Act as" button on `/admin/users`.
  - Phase 3e (this PR): shell sandbox via bubblewrap/firejail.
    `security.shellSandbox = 'off' | 'auto' | 'required'` (default
    off). `wrapCommand(argv, opts)` returns wrapped argv when a
    runner is on PATH; the shell tool's local-operations.exec
    pipes through it. Pairs with WorkspaceFS (Phase 1b-3) for
    full filesystem-level + process-level isolation.
  - Phase 3f: Docker per-user isolation. Opt-in
    `security.dockerIsolation = 'off' | 'enforce'`. Convention:
    every container carries `octipus.user_id=<uuid>` label; every
    user gets an `octipus_user_<id>` bridge network. The Docker
    tool's list filters by the label; targeted ops verify ownership
    via `docker inspect` and surface mismatches as "container not
    found" so attackers can't enumerate other users' containers.
  - Phase 3g: org / workspace grouping scaffolding.
    Migration `0038` adds `organizations`, `org_members`, and
    `workspaces` tables with RLS policies. New
    `OrgWorkspaceManager` handles CRUD with admin gating on orgs,
    per-user CRUD on workspaces, and the same cross-tenant
    enumeration-collapse pattern as scopedRepos. Feature flag
    `multiuser.orgWorkspaces` (default off); when on, REST surface
    `/api/me/workspaces` + `/api/admin/orgs` lights up. **Phase 3
    complete.**
  - Phase 4 (this PR): workspace_id adoption. Migration `0039`
    adds nullable `workspace_id` to sessions / documents / hooks
    with composite `(user_id, workspace_id)` indexes; FK uses ON
    DELETE SET NULL so workspace deletion falls back to user-level
    scope rather than cascading. New `resolveWorkspace(principal,
    header)` maps `X-Octipus-Workspace` (slug or uuid) to a
    workspace owned by the principal — cross-tenant headers
    collapse to the user's default. ScopedSessionRepo /
    ScopedDocumentRepo / ScopedHookRepo filter on workspace_id
    when set (NULL rows stay visible — un-backfilled data keeps
    working) and stamp the principal's workspaceId onto new rows.
    `scripts/backfill-workspace-id.ts` walks every user, ensures
    a default workspace, and updates rows with NULL
    `workspace_id`. All gated on `multiuser.orgWorkspaces`; off
    keeps every existing call site untouched.

  **Next (optional follow-ups).**
  - Vault `scope=workspace` wiring (vault has its own per-row DEK
    + scope enum that warrants a focused PR).
  - Workspace pickers in the web UI.
  - Org-shared resources (system models, shared skills) routed
    through `org_members`.
  - Workspace adoption on the rest of the user-owned tables
    (`agents`, `notifications`, `trajectory_runs`, `pipelines`,
    `embeddings`, `agent_events`, `swarm_nodes`).

- **TUI editor (in flight, 2026-05).** A full-screen terminal
  editor that doubles as the agent's collaborator —
  editor-first instead of the current chat-first surface.
  Inspired by [pi-mono](https://github.com/badlogic/pi-mono).
  Multi-pane layout (file tree / editor / chat), real
  multi-line editing with cursor + selection + undo, command
  palette, in-buffer diff overlays for agent edits, inline
  permission prompts, multi-user workspace awareness. Shipping
  alongside the existing chat TUI (`src/tui/`) under a new
  `src/tui-editor/` so neither surface blocks the other. Full
  plan: [`docs/architecture/TUI-EDITOR.md`](docs/architecture/TUI-EDITOR.md).

## Next (months)

- **Skill auto-extension — promotion path.** The pattern detector, cache,
  `skill_proposals` table, `/api/skills/proposals` API, and
  `/skills/proposals` web page landed. Next: tighten the proposal
  review UI (diff preview of generated prompt, one-click promote to
  `skills` table, rejection-suppression timers visible, user-scoped
  opt-out toggle).

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

## Done (recent)

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
