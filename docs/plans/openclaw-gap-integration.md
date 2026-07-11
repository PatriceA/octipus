# Plan: OpenClaw gap integration

Source: `docs/OPENCLAW-COMPARISON.md` (July 2026). This plan covers the
gaps ranked "worth closing" there, mapped onto the actual extension
points in the codebase (all file references verified 2026-07-11).
Each workstream is independently shippable; sequencing and effort at
the bottom.

Workstreams:

- **WS1 — CI & security engineering** (blocking audit, CodeQL/semgrep, release automation, install smoke)
- **WS2 — Heartbeat / proactive loop**
- **WS3 — Plugin SDK maturation** (contract, validation kit, npm/git install)
- **WS4 — Observability** (prom-client metrics, OTel traces, runId propagation)
- **WS5 — `tool_search` meta-tool** (catalog search over role tool sets)
- **WS6 — OpenAI-compatible HTTP API** (`/v1/chat/completions`, `/v1/models`)
- **WS7 — Channel additions** (email inbound first; Signal, Matrix after)
- **WS8 — Provider gaps** (local-runtime presets; subscription OAuth)

Explicit non-goals (per the comparison doc): channel breadth race,
media generation, device nodes, personal-account WhatsApp, i18n.

---

## WS1 — CI & security engineering

**Current state:** `.github/workflows/ci.yml` is the only workflow — 4
jobs (backend, web, desktop, mcp-server), no matrix. `bun audit --prod`
runs with `continue-on-error: true`. No CodeQL, no semgrep, no
dependency review, no release workflow, no git tags, `package.json`
pinned at `0.1.0` while CHANGELOG says v0.2.

**Plan:**

1. **Make `bun audit` blocking.** Remove `continue-on-error`; add an
   ignore mechanism for accepted advisories (documented allowlist file
   checked by a small wrapper script in `scripts/`, so exceptions are
   reviewable in diffs rather than silently tolerated).
2. **CodeQL** — new `.github/workflows/codeql.yml`, language
   `javascript-typescript`, on PR + weekly cron. Zero code changes.
3. **Semgrep/opengrep** — new job in `ci.yml` (or standalone workflow)
   running the community `p/typescript` + `p/security-audit` rulesets;
   start `continue-on-error: true` for one week to triage, then flip to
   blocking. Add `.semgrepignore` for tests/fixtures.
4. **Workflow hygiene** — run `zizmor` (GitHub Actions auditor) once,
   fix findings, then add as a lint job. Pin `oven-sh/setup-bun` to a
   Bun version instead of `latest` (today a Bun release can break CI
   for unrelated PRs).
5. **`dependency-review-action`** on PRs (flags newly-introduced
   vulnerable/unlicensed deps).
6. **Install smoke test** — new job: run `scripts/install.sh` in a
   clean container + `octi setup --non-interactive` with
   `OCTIPUS_SETUP_STORAGE=embedded` (PGlite, no services needed),
   then `octi doctor` and one `POST /api/chat` against a mock provider.
   This is the single highest-value test we don't have: it exercises
   what every new user runs first. Add a macOS runner variant (smoke
   only, not the full suite) for cross-OS coverage.
7. **Release automation** — tag-driven `release.yml`: on `v*` tag,
   run full CI, extract the version's CHANGELOG section into GitHub
   Release notes, attach build artifacts, `npm publish` the
   `mcp-server` package (its pack dry-run check already exists in CI).
   Sync `package.json` version with the tag as part of the release
   script. Keep manual CHANGELOG curation (it's good).

**Files:** `.github/workflows/{ci,codeql,release}.yml`, `scripts/`
(audit wrapper, release script), `package.json`.

**Testing:** the workstream *is* tests. Verify semgrep/CodeQL runs are
< 10 min so they don't dominate PR latency.

---

## WS2 — Heartbeat / proactive loop

**Goal:** a periodic agent turn per user that reviews standing
context (open tasks, unread notifications, goals) and acts or stays
silent — OpenClaw's `heartbeat` + "standing orders", adapted to a
multi-user platform (per-user gating, quotas, quiet hours).

**Current state — read this before designing:**

- The *live* scheduler is `src/core/cron-runner.ts`: `startCronLoop()`
  ticks every 60s and executes due rows from the **`hooks` table only**
  (`trigger='schedule'`), firing `hookManager.trigger(...)`
  fire-and-forget (`cron-runner.ts:254-269`).
- `src/core/scheduler.ts` (Redis queue `Scheduler` class, with an
  already-built **wake-gate** primitive: `WakeGate`,
  `evaluateWakeGate`, `registerWakeGateToolEvaluator`) is **not wired
  into boot** — referenced only from the core barrel and artifact
  cleanup.
- The `recurring_tasks` table (`src/db/schema/recurring-tasks.ts`) is
  **dead weight**: only its API routes reference it; cron-runner never
  processes it.
- Hooks can already start orchestrated agent runs:
  `executeSpawnAgent` (`src/hooks/actions.ts:175`) calls
  `getOrchestratorService().handleMessage(sessionId, userId, message,
  'hook')` and `resolveHookSessionId` (actions.ts:153) reuses one
  session across firings.

**Design decision:** build heartbeat on the hooks/cron-runner path (it
is alive, tested, and already session-sticky) and port the wake-gate
concept over as a plain function — do **not** wire up the unused Redis
`Scheduler` for this. Separately, fold the dead `recurring_tasks`
table into hooks (migration + route shim) as a cleanup pre-step so we
don't build a third scheduling system.

**Plan:**

1. **Cleanup pre-step:** migrate `recurring_tasks` rows into `hooks`
   (`trigger='schedule'`, action `spawn_agent|execute_tool|webhook`
   maps 1:1), keep `/api/recurring-tasks` routes as a thin shim over
   hooks, drop the table in a later migration.
2. **New trigger type `heartbeat`** in `src/hooks/triggers.ts` (a
   schedule hook variant, system-managed one per user who enables it)
   plus a `heartbeat` config block in DB settings: interval, quiet
   hours (tz-aware), max runs/day, target channel for notifications.
3. **Gate before spawn** (cheap first, per the deterministic-first
   doctrine in DESIGN.md): before `executeSpawnAgent`, a
   `evaluateHeartbeatGate(userId)` checks — quiet hours → skip; user
   quota (`user-quotas`) exhausted → skip; then a *deterministic*
   "anything pending?" probe (due tasks in `tasks`/`task-state`,
   unacted notifications, hook backlog). Only if the probe finds
   candidate work does an LLM turn run. Empty probe = no tokens spent.
4. **Heartbeat prompt:** new orchestrator entry channel `'heartbeat'`
   (channel string already flows through `handleMessage`). Message =
   rendered checklist of the probe findings + standing instructions.
   Standing instructions live in a per-user note (reuse the `notes`
   tool/table, a pinned `HEARTBEAT` note) rather than a new table —
   mirrors OpenClaw's `HEARTBEAT.md` semantics with zero new schema.
5. **Silence is the default:** the heartbeat role prompt must end
   turns without user-visible output unless something crossed an
   action/notify threshold; deliver notifications through the existing
   `notify` action path (`actions.ts:414`, channel bindings).
6. **Safety rails:** per-run token budget via the existing swarm
   budget config; heartbeat runs are `origin='heartbeat'` in
   `agent-events` for auditability; kill switch = disable the hook.

**Files:** `src/core/cron-runner.ts`, `src/hooks/{triggers,manager,actions}.ts`,
`src/db/schema/hooks.ts` (+ migration), `src/core/orchestrator/service.ts`
(channel constant), `src/api/routes/hooks.ts`, web settings page, new
`docs/HEARTBEAT.md`.

**Testing:** unit tests for gate logic (quiet hours, quota, empty
probe); integration test: seed a due task → tick cron → assert
orchestrated run with heartbeat channel; e2e module in `scripts/e2e/tests/`.

---

## WS3 — Plugin SDK maturation

**Current state:** two parallel mechanisms —

- `src/plugins/` manifest plugins from `<cwd>/extensions/`
  (`loader.ts:126`): `plugin.json` + entry module; **tools only**
  (wrapped as one `PluginTool extends BaseTool`, `plugin-tool.ts:6`);
  vault-backed secret resolution per calling user (`resolveSecrets`,
  plugin-tool.ts:72) — this part is genuinely good.
- `src/extensions/` host runtime from `~/.octipus/extensions/`
  (`loader.ts:35`): factory gets `ExtensionAPI` = `on(event)`,
  `registerCommand`, `notify`, `onDispose` (`types.ts:17`).

Neither has a versioned contract, contract tests, or remote install.
One example plugin exists.

**Plan (three phases):**

1. **Phase 1 — one contract.** Extract a published-shape package
   `@octipus/plugin-sdk` (new top-level `plugin-sdk/`, mirroring how
   `mcp-server/` is packaged): the types from `src/plugins/types.ts` +
   `src/extensions/types.ts`, unified into one manifest —
   `plugin.json` gains `apiVersion` (semver contract version) and a
   `capabilities` block: `tools` (existing), `commands`, `events`
   (subsuming what `src/extensions/` offers today). The loader
   (`src/plugins/loader.ts`) validates `apiVersion` against the range
   the host supports and refuses with a clear error otherwise.
   `src/extensions/` becomes a thin consumer of the same manifest
   (keep `~/.octipus/extensions/` as a search path; deprecate the
   bare-factory format with a warning, don't break it).
2. **Phase 2 — contract validation kit.** `octi plugin validate
   <dir>`: loads the manifest, type-checks the module shape
   (`validateModule`, loader.ts:77 already exists — extend it),
   dry-runs `initialize` with a mock `PluginContext`, executes each
   declared tool against its declared parameter schema with generated
   fixtures, checks secret declarations resolve. Ship the same checks
   as a test helper (`import { validatePlugin } from
   '@octipus/plugin-sdk/testing'`) so plugin authors run it in their
   own CI. Add a CI job running it over everything in `extensions/`
   (this is OpenClaw's "plugin contract shards" at our scale).
3. **Phase 3 — remote install.** `octi plugin install <spec>` where
   spec is `npm:pkg@version`, `github:owner/repo[#ref]`, or a local
   path/archive. Fetch → verify manifest + `apiVersion` → run the
   Phase-2 validator → copy into `extensions/` → record
   `{spec, resolvedVersion, integrityHash}` in a `plugins.lock`
   file → hot-reload via existing `reloadPlugin` (loader.ts:208).
   Security posture (must be explicit in docs): installing a plugin is
   executing third-party code in-process; require an interactive
   confirmation showing declared tools + secrets, and gate the whole
   feature behind an admin permission. **No registry/marketplace yet**
   (that's the roadmap item; it needs signing, which stays deferred).

**Deliberately not doing:** plugin-provided channels/providers. Both
have working drop-folder conventions in core
(`src/channels/discovery.ts`, `ProviderRouter` in
`src/models/providers/index.ts:125`) and opening them to third-party
code multiplies the trust surface. Revisit after signing exists.

**Files:** new `plugin-sdk/`, `src/plugins/{loader,types,plugin-tool}.ts`,
`src/extensions/{loader,api,types,registry}.ts`, `bin/octi.ts`
(subcommands), `extensions/example-plugin/` (update to new manifest),
`docs/PLUGINS.md`, new CI job.

**Testing:** the validation kit self-tests; contract-run
`extensions/` in CI; e2e: install a fixture plugin from a local
tarball, call its tool through a role.

---

## WS4 — Observability (Prometheus + OpenTelemetry)

**Current state:** `GET /metrics` (`src/api/routes/metrics.ts:70`,
gated by `METRICS_TOKEN`) hand-renders 8 gauges; no `prom-client`, no
OTel deps, and **no trace/correlation IDs anywhere in `src/`** — logs
carry ad-hoc `sessionId`/`agentId` only. Provider calls already
measure `latencyMs` + token counts (`ProviderRouter.complete/stream`,
`src/models/providers/index.ts:194/287`).

**Plan:**

1. **Metrics first (small, immediately useful).** Add `prom-client`;
   replace the hand-built exposition in `renderMetrics()` with a
   registry, keeping existing metric names (`octipus_up`,
   `octipus_db_up`, …) so any existing dashboards survive. Add:
   - `octipus_orchestrator_runs_total{channel,role,status}`
   - `octipus_classifications_total{topic,method="deterministic|llm"}`
   - `octipus_tool_executions_total{tool,status}` + duration histogram
     (hook: `BaseTool.executeWithMiddleware`, `base-tool.ts:97`)
   - `octipus_llm_requests_total{provider,model,status}` + latency
     histogram + `octipus_llm_tokens_total{provider,model,direction}`
     (hook: the existing `ProviderRouter` timing points)
   - `octipus_swarm_spawns_total{role,depth}` (hook:
     `SwarmSpawner.spawnChild`)
   - `octipus_channel_messages_total{channel,direction}` (hook: UMI
     message handler / `umi.send`, `src/channels/index.ts:467/764`)
2. **Run/trace correlation.** Introduce a `runId` generated in
   `OrchestratorService.handleMessage` (`service.ts:82`), carried via
   `AsyncLocalStorage` and stamped into every child logger
   (`createChildLogger` in `src/utils/logger.ts`) and into
   `agent-events`. This is a prerequisite for tracing and improves
   log forensics on day one.
3. **OTel traces.** `@opentelemetry/api` + NodeSDK with OTLP exporter,
   configured from DB settings (endpoint, headers, sample rate) —
   consistent with the ".env holds only secrets" rule. Span tree:
   `orchestrator.handleMessage` → `classifier` → `agent.run`
   (orchestrator-runner) → `tool.execute` (tool-executor middleware) →
   `llm.complete` (ProviderRouter). The swarm's existing
   `call-graph.ts` node ids map onto span links for fan-out. Exporter
   off by default; zero overhead when disabled (use the OTel no-op
   API).
4. **Docs:** `docs/OBSERVABILITY.md` with a docker-compose snippet
   (Prometheus + Grafana + Tempo/Jaeger) and a starter dashboard JSON.

**Files:** `src/api/routes/metrics.ts`, new `src/core/telemetry.ts`,
`src/utils/logger.ts`, `src/core/orchestrator/{service,orchestrator-runner}.ts`,
`src/core/tool-executor.ts`, `src/tools/base-tool.ts`,
`src/models/providers/index.ts`, `src/core/swarm/spawner.ts`,
`src/channels/index.ts`, `package.json`.

**Testing:** unit-test metric emission with a scraped registry;
integration: one chat round-trip → assert counters moved and every log
line of the run shares the `runId`.

---

## WS5 — `tool_search` meta-tool

**Current state:** a role's full allowlist goes into every model call
— `getToolsForRole` (`src/core/orchestrator/roles.ts:166`) →
`getToolHandlersForTools` (`src/tools/registry.ts:143`), plus per-user
connector tools (`worker-spawner.ts:277-294`). The **MCP lazy bridge
is the in-repo precedent**: roles with `'mcp'` get only
`mcp_list_tools`/`mcp_call_tool` instead of the expanded catalog.
Skills already do embedding-based discovery
(`skills.descriptionEmbedding`, `scripts/backfill-skill-embeddings.ts`)
via `getEmbeddingService()` (`src/core/rag/embeddings.ts`).
`scripts/measure-tool-payload.ts` exists to quantify the win.

**Design:** generalize the MCP lazy pattern to builtin tools, scoped
by the role allowlist (search never widens permissions — it only
defers *description* loading; the permission middleware in
`BaseTool.executeWithMiddleware` still gates execution).

**Plan:**

1. **Embed the catalog.** At registry init (or via a backfill script
   copying `backfill-skill-embeddings.ts`), embed
   `name + '\n' + description` for every registered tool handler,
   purpose `'tool'`, keyed by handler name + description hash so
   re-embeds only happen on change. Store in the existing
   `embeddings` table.
2. **Meta-tools** (factory-returns-`ToolHandler` pattern copied from
   `createSpawnChildTool`, `src/core/swarm/swarm-tool.ts:202`):
   - `tool_search(query, limit)` — hybrid rank (embedding cosine +
     keyword) **restricted to the caller's role allowlist ∩ capability
     gate**; returns id, one-line description, parameter summary.
   - `tool_describe(id)` — full parameter schema.
   - `tool_call(id, args)` — dispatches through
     `getToolRegistry().findTool(...)` + the standard middleware, same
     shape as `mcp_call_tool`.
3. **Role opt-in.** New role config field `toolCatalogMode:
   'full' | 'search'` (default `'full'`). In `'search'` mode
   `getToolsForRole` returns only the three meta-tools + the role's
   top-N "core" tools (pinned in role config). Start by flipping the
   two fattest roles (measure with `measure-tool-payload.ts`), watch
   evals, then expand.
4. **Evals are the acceptance gate:** run the existing eval suites
   against `'search'`-mode roles; a regression in task success blocks
   rollout regardless of the token savings. Small-model behavior
   matters (`prompt.lite.md` roles) — provide a flat/lite variant like
   `spawn_child` has (`swarm-tool.ts:276`).

**Files:** new `src/core/orchestrator/tool-catalog.ts` (meta-tool
factory + search), `src/core/orchestrator/{roles,meta-tools}.ts`,
`src/tools/registry.ts` (search over handlers),
`scripts/backfill-tool-embeddings.ts`, role `config.ts` files, eval
suite additions.

**Testing:** unit: search respects allowlist/capability gate;
permission ASK still triggers through `tool_call`; eval: before/after
task-success on converted roles; payload-size assertion in CI using
the measure script.

---

## WS6 — OpenAI-compatible HTTP API

**Current state:** `POST /api/chat` (`src/api/routes/chat.ts:27`) is
non-streaming JSON over `OrchestratorService.handleMessage`. Streaming
exists only over WebSocket (`/gateway`); **no SSE helper for chat**
(SSE code exists only in MCP transports and the log stream). API
tokens (`octi_…`, `src/security/api-tokens.ts`) validate but **scopes
are stored, not enforced** (`validate`, api-tokens.ts:154).

**Plan:**

1. **Scope enforcement first** (small security fix with standalone
   value): make `ApiTokenManager.validate` return scopes and add a
   `requireScope(scope)` guard; enforce `api:chat` on the new
   surface and (after a deprecation note) on `/api/chat`.
2. **Mount `/v1` route group** in `src/api/server.ts` alongside the
   `/api` group, sharing the same `.derive()` auth (Bearer `octi_`
   tokens are the expected credential; browser sessions also work).
3. **`GET /v1/models`** — list from the model registry plus virtual
   entries `octipus/<role>` for the 16 roles and `octipus/orchestrator`
   (full classify→route pipeline).
4. **`POST /v1/chat/completions`** — translation layer:
   - `model: octipus/orchestrator` (default) → `handleMessage` with
     channel `'api'`; `octipus/<role>` → forced role; a raw registry
     model id → direct `ProviderRouter.complete` passthrough
     (single-turn proxy, no tools) for users who want Octipus as a
     keyed gateway.
   - Session mapping: stateless by default (each request's `messages`
     array is the context, matching OpenAI semantics); honor an
     optional `user`/`x-octipus-session` header for sticky sessions.
   - Response: map `{response, metadata}` → one `chat.completion`
     object with real token usage from the cost tracker.
5. **Streaming in two steps.** Step 1: `stream: true` returns SSE that
   chunks the *final* text (correct protocol, not token-true) — needs
   only a small `sse.ts` helper (Elysia supports generator responses).
   Step 2 (separate PR): token-true streaming by subscribing to the
   run's gateway event stream (the same events `/gateway` WS clients
   consume) keyed by the WS4 `runId`, bridging agent output deltas
   into SSE chunks. Do not block step 1 on step 2.
6. **Error mapping:** OpenAI error envelope (`invalid_request_error`,
   `rate_limit_exceeded` from the existing rate-limit middleware, 401
   from auth-guard) so off-the-shelf SDKs behave. Document with a
   `curl` + `openai` Python/TS example in `docs/API.md`.

**Files:** new `src/api/routes/openai-compat.ts` + `src/api/sse.ts`,
`src/api/server.ts`, `src/security/api-tokens.ts`,
`src/api/middleware/auth-guard.ts` (public-path audit: `/v1` must be
auth-required), `docs/API.md`.

**Testing:** contract tests using the official `openai` SDK pointed at
a test server (non-stream + stream, models list, error shapes); e2e
module in `scripts/e2e/tests/openai-compat.ts`.

---

## WS7 — Channel additions (email inbound → Signal → Matrix)

**Current state:** adapters are drop-folders under `src/channels/`
implementing `BaseChannel` (`interface.ts:22` — `connect`,
`disconnect`, `send`, `isEnabled(config)`); discovery is automatic
(`discovery.ts:27`); inbound flows through the UMI `message` handler
(`index.ts:467`) into the orchestrator. Email today is **outbound/
triage only** via Gmail REST + MS Graph with OAuth
(`src/core/email/providers.ts`) — no IMAP, no inbound loop. There is a
channel-adapter guide (`docs/guides/channel-adapter.md`).

**Priority: email first** — the OAuth plumbing, triage service, and
reply-send (`sendReply`, ASK-gated) already exist; only the inbound
edge is missing, and it's the adapter with the most platform-user pull.

1. **Email adapter** (`src/channels/email/`):
   - Inbound: polling first — a 60s loop (piggyback on the cron tick
     or the adapter's own timer) calling Gmail `history.list` / Graph
     delta per linked user; Pub/Sub push is a later optimization, not
     v1 (it needs GCP topic setup that self-hosters won't have).
   - Session mapping: email thread id → session (same pattern as
     `resolveSession`); sender identity → user via channel bindings /
     `linking.ts`.
   - Outbound `send()`: reuse `sendReply` path (keeps the ASK
     permission gate — replying to email is outward-facing).
   - Guardrails: allowlist of sender domains/addresses per user
     (default: only the linked account's own addresses), never
     auto-reply to bulk/no-reply senders, loop protection
     (`In-Reply-To` chain depth + rate cap). Email is an
     injection-rich channel; inbound bodies must go through the
     existing input guard like every channel message.
2. **Signal adapter** (`src/channels/signal/`): integrate via
   `signal-cli-rest-api` (containerized JSON-RPC/REST + SSE receive) —
   linked-device mode, so the platform doesn't own the number.
   Credentials/config in DB settings; `isEnabled` checks endpoint
   configured. Ship a `docker-compose` overlay for the sidecar.
3. **Matrix adapter** (`src/channels/matrix/`): `matrix-js-sdk` bot
   (access-token login, E2EE via crypto store; start with
   non-E2EE rooms, add encryption in a follow-up). Matrix's federated
   room model maps cleanly onto session-per-room.

Each adapter follows the guide + gets: unit tests for message
translation, an e2e module, `docs/CHANNELS.md` section, and settings
UI wiring (channels are DB-configured like Slack/Telegram today).

**Testing:** adapter contract tests against `BaseChannel` (a reusable
harness here would also serve WS3's contract kit); email loop
protection unit tests are non-negotiable.

---

## WS8 — Provider gaps

Two sub-items, different risk profiles:

1. **First-class local runtimes (llama.cpp, LM Studio, vLLM, SGLang)
   — low risk, mostly UX.** The transport already exists:
   `CustomOpenAICompatProvider` explicitly supports vLLM/self-hosted
   endpoints (`src/models/providers/custom/openai-compat-provider.ts`)
   but requires hand-editing a `model_config` row. Add **presets**: a
   small registry (id, label, default endpoint, path override, auth
   default, health-check probe) surfaced in `octi setup` and the
   models web UI — "LM Studio → http://localhost:1234/v1" one-click,
   plus model autodiscovery via the endpoint's `/v1/models` to
   populate the registry. No new provider classes. Extend the provider
   conformance suite to run against a mocked local endpoint.
2. **Subscription OAuth (ChatGPT/Codex-plan style) — decision
   required before build.** Technically: extend `OAuthManager`
   (`src/security/oauth.ts` — PKCE engine already generic,
   string-keyed providers) with a device-code flow, store
   tokens in the vault, add a provider class that authenticates
   completions with the OAuth token instead of an API key. But using
   consumer-subscription auth for a *multi-user server* is exactly
   the pattern that violates provider ToS (it's defensible in
   OpenClaw's single-user context; much less so here, since one
   subscription would back many users). **Recommendation: build the
   device-code OAuth plumbing (it's also needed for future
   connectors) but ship subscription-auth providers only in
   single-user/embedded mode, gated and documented.** If that
   restriction isn't acceptable, drop the item.

**Files:** `src/models/providers/custom/*`, new
`src/models/providers/presets.ts`, `src/security/oauth.ts`,
`src/setup/` wizard step, models UI page, `docs/CUSTOM-PROVIDERS.md`.

---

## Sequencing & effort

Rough effort in engineer-weeks (implementation + tests + docs).
Independent tracks; suggested order optimizes for
infrastructure-before-features and small-wins-first.

| Phase | Workstream | Effort | Depends on |
|---|---|---|---|
| 1 | WS1 CI/security (items 1-5) | 1w | — |
| 1 | WS4 metrics + runId (items 1-2) | 1w | — |
| 1 | WS6 scope enforcement (item 1) | 2d | — |
| 2 | WS6 OpenAI API (non-stream + SSE step 1) | 1.5w | WS6.1 |
| 2 | WS2 heartbeat (incl. recurring-tasks cleanup) | 2w | — |
| 2 | WS1 install smoke + release automation (items 6-7) | 1w | WS1 phase 1 |
| 3 | WS5 tool_search | 2w | eval suite green |
| 3 | WS4 OTel traces (item 3) | 1w | WS4 runId |
| 3 | WS7 email adapter | 2w | — |
| 4 | WS3 plugin SDK (phases 1-2) | 2.5w | — |
| 4 | WS6 token-true streaming (step 2) | 1w | WS4 runId |
| 4 | WS8 local-runtime presets | 1w | — |
| 5 | WS7 Signal, Matrix | 1.5w each | channel harness (WS7.1) |
| 5 | WS3 remote install (phase 3) | 1.5w | WS3 phases 1-2 |
| 5 | WS8 subscription OAuth | 1w | **product decision** |

Total ≈ 20 engineer-weeks for everything; phases 1-2 (≈ 6 weeks)
deliver the highest-leverage subset: hardened CI, metrics + run
correlation, a usable OpenAI-compatible API, and the heartbeat loop.

## Open decisions

1. **WS8 subscription OAuth** — accept the single-user-mode-only
   restriction, or drop? (Owner call; ToS exposure.)
2. **WS2** — is a pinned note the right home for standing
   instructions, or does product want a first-class "goals" object
   (OpenClaw has `create_goal`/`update_goal`)? Note is the cheap v1;
   schema can follow usage.
3. **WS7** — email adapter default posture: reply-drafts-only (ASK on
   every send) vs. allowlisted auto-send. Plan assumes ASK-gated.
4. **WS5** — which two roles convert to `'search'` mode first (pick
   from `measure-tool-payload.ts` output).
