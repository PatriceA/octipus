# Roadmap

> **Note.** Directions, not promises. Items move, get reshaped, or get dropped as the project learns. If something here is interesting, open an issue and let's talk before you build.

This doc lists what we are exploring. Order inside each section is rough priority, not strict sequencing. PRs welcome on anything marked **Help wanted**.

---

## Now (in flight)

- **Daily-driver gaps.** What a developer / PO / consultant needs to run
  their day on Octipus, in six phases plus the *Octipus goes enterprise*
  track (the org-level connector that owns identity, content visibility,
  connectors and policy). Phase 0 shipped 2026-09-05 (#328): workspace-scoped
  memory, reader / email / research → to-dos, `pm` and `coding` tooled for
  their own prompts, a seeded Daily Briefing hook. Phase 1 shipped the same
  day: next-action ranking on the to-do list, an inbox page, a "while you
  were away" digest (dashboard + briefing), and heartbeat probes for red
  PRs and imminent meetings. Phase 3 the same day: research runs and
  document processing are `background_jobs` rows that survive a restart,
  claimed under a row lock, swept to `interrupted` at boot, and reported in
  the away digest. Phase 2 shipped 2026-09-06: to-dos have parents, blockers,
  estimates and an in-progress status, `/tasks` has a board with category
  lanes, and the `pm` role writes a whole plan as a backlog in one call.
  Phase 4 the same day: the `github` tool reads diffs, review threads, checks
  and job logs and answers threads; an *Address Review* stage closes the
  review loop in the Full Development Cycle; the repo registry indexes
  symbols with tree-sitter (`find_symbol`); the gateway runs over stdio as
  JSON lines (`--stdio`). Plan:
  [docs/plans/daily-driver-gaps.md](docs/plans/daily-driver-gaps.md).

- **Mock-provider scaffold for the model layer.** `src/models/litellm-client.ts`
  (988 lines) and `src/models/providers/index.ts` are at 0% coverage
  because they front network IO; meaningful unit tests need a mock
  provider that speaks the provider interface (complete / embed /
  stream / error classes), records calls, and returns scripted
  responses. Once it lands, the existing test files for capability
  routing, cost tracking, rate limiting, and provider discovery
  can finally assert on what the client actually does. **Help wanted.**


- **Live Artifacts — BETA.** `src/core/artifacts/`, `/api/artifacts`,
  `web/app/artifacts/`, and the `create_live_artifact` meta-tool are
  live behind a BETA flag in the sidebar and on the page header.
  Outstanding work: subdomain hosting hardening (host header /
  CSP origin sandboxing), embed-mode auth scopes, retention &
  garbage-collection policy, slug-collision UX, agent-authored
  refresh loop. Stays in **Now** until the BETA flag drops.

- **Schema directory grouping.** `src/db/schema/` is 57 flat files.
  Still searchable, but the next 5-10 additions will start to bite.
  Proposed grouping: `schema/{auth,orchestration,rag,memory,artifacts,audit,settings}/`.
  Non-breaking — `index.ts` re-exports preserve the import surface.
  Worth doing once memory + artifacts each grow another 2-3 tables;
  not before.

## Next (months) — field parity, then innovation

Ordered as four waves. Wave 1 is load-bearing: waves 2 and 3 are cheap once it
lands and expensive before it. Sources for the parity read: a gap analysis
against the LangGraph/LangSmith-shaped field, and an architecture read of
DeepSeek Harness (Cordis "everything is a plugin"). Both were checked against
this codebase before being written down — items already shipped here
(agentskills.io `SKILL.md` interop, full-duplex voice, the YAML eval harness,
structured handoffs) are deliberately absent, and DSH's runtime
self-introspection tool and resident-activation machinery were evaluated and
rejected (security foot-gun / unnecessary for a dispatcher that keeps arms
cheap).

### Wave 1 — foundations — SHIPPED (2026-08-19)

All four landed. What each actually became:

- **Dispatch waterfall.** `hooks.ts` gained `fireWaterfall` (around-middleware)
  plus `tool:before` / `tool:after` and `spawn:before` / `spawn:after`. Two
  semantics, deliberately different: the `before` events FAIL CLOSED (a throwing
  handler aborts the dispatch — a permission check that crashes must never read
  as "allowed") and short-circuit on the first handler that sets
  `ctx.shortCircuit` (deny, or a substituted result); the `after` events keep
  swallow-and-continue, so a tracing subscriber cannot turn a successful call
  into a failure. `spawnChild` is now a thin wrapper over `spawnChildInner` so
  its many return paths each report exactly once, untouched.
- **Graph runtime.** `pipeline_stages` is now `pipeline_nodes` + `pipeline_edges`;
  `current_stage_index` is gone (a graph has no single ordinal position — a
  backward edge or a loop body revisits nodes). `pipeline-graph.ts` holds
  compilation, validation and edge selection, all pure, so routing is testable
  without booting an agent. The QA retry loop is no longer a `while` nested in
  the stage loop: it is an ordinary bounded backward edge, with
  `audit_gate_failed` as a self-edge so an unaccountable REPORT re-runs the
  auditor alone instead of re-running work that was fine.
- **`foreach` nodes over a durable Plan.** A maximal run of consecutive steps
  declaring `loopOverPlan` becomes one loop body — the grouping IS the
  declaration, no nesting syntax. The loop re-reads `plan_items` every pass, so
  an item appended mid-run by a review or QA node (the new `plan` tool) or
  edited by the user (`/api/pipelines/:id/plan`) is picked up in the same run.
  Plan approval is asked ONCE, on the loop head, over a concrete item list.
  `validateGraph` refuses to run a template with an unreachable node or an
  unbounded cycle; every shipped preset is compile-tested. The `Full Development
  Cycle` preset now plans, then loops implement → test → review → QA per item.
- **Unified run event log.** `swarm_ledger` became `run_events` with a `subject`
  discriminator, carrying swarm node lifecycle (replay/reconcile unchanged),
  graph node transitions, edge traversals, plan item progress, and tool dispatch
  — the last from a single subscriber on the waterfall above, which is what
  building the seam first bought. Shape, timing and status only: argument values
  and results are never stored. Read at `GET /api/runs/:sessionId/events`.

### Wave 2 — visible parity — SHIPPED (2026-08-19)

All three landed. What each actually became:

- **Checkpoint, resume, and edit-state.** `pipeline_checkpoints` holds one
  materialized snapshot of the walker per node ENTRY — cursor, handoff chain,
  per-edge traversal counts, QA feedback in flight, the plan item being worked.
  That boundary choice is what makes pause, crash recovery and rewind the same
  mechanism: resuming re-enters the node that was interrupted (a worker turn is
  not itself resumable, and re-running one node is the cheap half), and
  rewinding is `POST /api/pipelines/:id/resume` with an older `fromSeq`, which
  drops the checkpoints after it because they describe a future being replaced.
  Pause is cooperative — the walker checks the request where it writes the
  snapshot, so a pause always lands somewhere resumable. Edit-state is
  `PATCH /api/pipelines/:id/checkpoints/:seq`, restricted to `previousOutput`:
  what the next node reads is the field a human can meaningfully rewrite, while
  hand-editing the counters would turn a resume into an unexplainable run. A
  boot sweep pauses pipelines left `running` by a dead process rather than
  auto-resuming them — restarting paid work unasked is the wrong default.
- **Trace and cost dashboard.** `GET /api/runs/:sessionId/trace` folds the
  wave-1 event stream into spans (`src/core/run-trace.ts`, pure), and
  `/runs/view?id=<sessionId>` renders duration, cost, tokens, an execution
  timeline and tool calls grouped by name. Cost is attributed by TIME WINDOW
  against `cost_log` rather than by a second counter threaded through the
  walker: a model call already records its session and its price, so the trace
  cannot disagree with the bill. Cost billed outside every span is reported
  separately instead of being silently spread over nodes. The OTel export path
  stays out of this — the in-app view is not blocked on the dependency proxy.
- **Human-in-the-loop as a first-class node.** `stageType: 'human_input'`
  compiles to a `human` node: no worker, no model, no cost. The question is the
  node's prompt template with the usual substitutions, and the answer becomes
  the node's output and the next node's input, so a person is just another
  participant in the chain rather than a flag on an agent. `humanFields`
  describes the answer shape for a client to draw a form; it is advisory,
  because validating a typed answer means a second round trip to someone who
  has already answered. Pause-before/pause-after needed no syntax — a node is
  placed where the pause belongs. Replay across restarts falls out of
  checkpointing: the snapshot precedes the ask, so an interrupted question is
  asked again on resume, which is the honest recovery when an in-memory
  approval promise dies with its process.

### Wave 3 — contracts, policy, cost

- **Arm capability contracts — SHIPPED (2026-08-20), role seams still open.**
  `role-contract.ts` asks, before a spawn is paid for, whether the arm can do
  the job. Two altitudes: `stageContractErrors` is static (the role's declared
  toolset, narrowed by the stage's own `toolIds`, against what the template says
  the stage is FOR) and runs beside `validateGraph`, so an impossible template
  is refused before the first node executes; `toolsetGaps` is runtime, checked
  in `spawnWorker` at the last point the tool list is still the one the worker
  will run with — after stage narrowing, capability gating, the read-only strip
  and the small-model cap, each of which can remove the tool the declaration
  depends on. Both judge against the sets the evidence gate counts with, so
  nothing is refused here that the gate would have passed.
  What is deliberately NOT built: declared *output schemas* and per-role depth
  limits (no role needs a different depth today, and a shape nobody varies is a
  knob with no user), and the **role seam** itself — swappable providers behind
  a role contract, so roles can be installed and replaced at runtime. That last
  one is the real remaining work here: `AgentRole` is a frozen 17-member union
  in `src/core/agent/types.ts` and every registry keys off it, so a
  runtime-installable role is a type-level change, not a config one.
- **Deterministic policy layer — approvals SHIPPED (2026-08-20).** The part of
  this that was genuinely scattered was the approval decision: whether an
  ASK-level tool call blocks for a human was decided twice, in the agent loop
  and in the tool middleware, as the same inline condition with a comment in
  each asking the other to be kept in sync. `security/approval-policy.ts` is now
  the one place, pure and exhaustively testable, and it can express what two
  inline conditions could not — `multiuser.unattendedDenyActions`, the actions
  an operator wants REFUSED rather than silently auto-approved when nobody is
  watching (empty by default: a list invented for everyone would break working
  runs).
  The rest of the original item was re-read against the code and mostly does not
  exist as a problem. Quotas are budgets, and they now live in two named places
  (`LEVEL_DEFAULT` for swarm, `pipelineTokenBudget` + a step's `maxTokens` for
  the graph). Sandbox selection is already one declarative knob
  (`security.shellSandbox`). The remaining guards — `spawn-validator`,
  `input-guard`, `output-guard`, `audit-coverage`, `pipeline-evidence-gate` —
  are each already a single pure module with its own tests; moving them behind
  the waterfall would buy a directory, not a property, and would put five
  load-bearing checks through a rewrite for it. Left where they are, on purpose.
  Still open: egress rules (there is secret scrubbing on tool results, but no
  declarative allow/deny for what a tool may reach).
- **Per-node token budgets in the graph — SHIPPED (2026-08-20).** Two bounds,
  because they answer different questions. A template step may declare
  `maxTokens`, persisted on the node row and handed to the worker as its cap —
  that bounds ONE visit. `agent.pipelineTokenBudget` (2M default, 0
  disables) is the pool for the whole run, checked at the node boundary against
  every node's cumulative spend. The pool is the load-bearing one: a `foreach`
  node is entered once per plan item and items can be appended mid-run, so the
  visit count is not known when the run starts and no per-visit cap can bound
  the run. Spend is charged in a `finally` — a stage that failed is charged for
  what it burned — and `pipeline_nodes.tokens_used` accumulates across visits,
  since a node the QA loop sent back three times cost all three visits.
  Still open: the planner→executor split still cannot reach a pipeline stage,
  and wall clock has no per-node bound — only the pipeline-wide worker timeout.
- **Eval: regression gating and memory-aware assertions — SHIPPED (2026-08-20).**
  `--baseline <path|latest>` compares a run to a previous results file PER TEST
  and exits 1 on a regression — a test that passed then and fails now — whatever
  happened to the aggregate, because one test fixed and one broken nets out to
  no movement. Recoveries, new tests and tests this run filtered out are
  reported and gate nothing.
  `memorySetup` + the `recalls_memory` assertion close the other half: facts are
  seeded for the test's user before the request and hard-deleted after it, so
  the extractor → judge → retrieval pipeline finally has coverage above its data
  layer. Seeded tests are integration-mode only (unit mode never reads the
  table) and need a real user UUID and a bound `embedding` model; a test that
  cannot be seeded is reported as failed with the reason rather than run without
  its facts. See `docs/EVALUATIONS.md`.
  Not wired into CI: gating there needs a committed baseline produced by a real
  run against real models, which is a decision about which models CI pays for.

### Wave 4 — after parity

- **Per-arm persona shadowing — SHIPPED (2026-08-20).** `/persona arm <role>
  <preset>` (and `PUT /api/persona/arms/:role`) binds a preset to one arm, so a
  blunt `review` can run under a playful host. Two properties are load-bearing:
  an UNBOUND arm still carries no persona block at all — workers never had one,
  and quietly sending every specialist the host's voice would change every
  worker prompt and its token cost as a side effect of a feature nobody switched
  on — and shadowing replaces the VOICE, not the identity, so the user's name,
  pronouns and self-facts carry over. Bindings are `arm:<role>` facts on the
  existing assistant profile, so there was no migration and `/persona reset`
  clears them.
- **Layout-grounded parsing — PDF SHIPPED (2026-08-20), GUI still open.** The
  text path threw the page geometry away (`items.map(i => i.str).join(' ')`),
  which is why a two-column paper arrived with its columns interleaved and a
  form arrived as one run of labels and values. `documents/pdf-layout.ts`
  rebuilds lines, column/cell gaps and paragraphs from the item transforms with
  no new dependency, and the 50-page cap now writes a truncation note instead of
  letting a partial index read as a complete one. Deliberately NOT attempted:
  a table recovered as a grid, true multi-column flow ordering, and
  GUI-screenshot understanding — the last belongs to the vision/OCR path, which
  never had this problem.
- **Native mobile clients — EXISTS, out of this repo.** The entry used to say
  the web UI was "responsive but not installable" and that channel proxying
  covered the gap; that has been stale for months. A Flutter client lives in a
  separate repo (`PatriceA/mobile-octipus`): iOS + Android, pairing with token
  refresh, LAN/public URL failover, offline cache, the WebSocket event stream,
  and feature screens for chat, tasks, inbox, notes, research, agents, skills
  and settings, with fastlane and Play Store packaging. It is at `0.1.0` and
  carries its own `ISSUES.md`, so the real work here is finishing and shipping
  that app, not starting one. Nothing in this repo references it — that is the
  first thing to fix.

### Carried forward (unchanged, unblocked independently)

- **Token-true streaming for `/v1/chat/completions`.** The OpenAI-compat
  API (shipped 2026-07-12) streams protocol-correct SSE that chunks the
  *final* text. True token-by-token streaming needs a token-delta path
  that does not exist yet: `ProviderRouter.complete` returns full text
  and the root agent emits only structured events (`status_update`,
  `worker_spawned`, …). The work is provider streaming → root agent
  delta events → SSE bridge keyed by the shipped WS4 `runId`, not a
  bridge over existing events. Do it once a provider-level streaming
  interface lands.
- **Inbound email channel.** A reply-drafts-only email adapter
  (**ASK-gated**: every send is a human-approved draft, per the
  gap-integration decision). Blocked on a reusable channel-adapter
  harness — the same harness would serve Signal / Matrix (under
  **Later**). The email *triage* surface already shipped (2026-06-03 /
  2026-06-10); this is the missing *inbound conversational channel*.
- **OpenTelemetry export.** Prometheus metrics + `runId` correlation
  shipped (WS4, 2026-07-12); spans are the remaining half. Blocked on
  packaging — the OTel SDK's ~20 transitive packages can't currently
  install through the build environment's package proxy. Pick up when
  the dependency constraint lifts. The wave-2 dashboard deliberately
  does not depend on this.
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
- **RPC stdio adapter for the gateway — SHIPPED (2026-09-06).**
  `src/core/gateway/stdio-adapter.ts`: `octipus --stdio` serves the same
  typed protocol as strict-LF JSON lines over the process's stdin/stdout,
  as one more connection to the hub (auth, rate limits, budgets and event
  visibility unchanged); logs go to stderr; stdin's end shuts the process
  down. Still open: request-id correlation (the socket protocol has none
  either — replies correlate by `sessionId` and event type).
- **Per-tool `executionMode` override.** Today meta-tools all run through the
  root agent with global concurrency. Add `executionMode: "sequential"` on
  the tool definition itself for tools with shared-state hazards
  (`spawn_worker`, `create_pipeline`, swarm `spawn_child`). Pi's pattern;
  small change to `BaseTool` + the root agent dispatch path. Cheapest as a
  policy declaration once the wave-1 waterfall exists.
- **Skill auto-extension — promotion path.** The pattern detector, cache,
  `skill_proposals` table, `/api/skills/proposals` API, and
  `/skills/proposals` web page landed. The
  [2026-05-24 curator land](#2026-05-24--root agent-freedom--hermes-skill-curator)
  added the lifecycle backbone (`last_used_at`, `usage_count`,
  `archived_at`, `curation_notes`, debounced usage tracker,
  `runSkillCurator` auto-archive after 90d / flag after 30d). The
  **generative half + skill-promotion path shipped** in the Hermes A1
  adoption (PRs #244/#245): a `kind` (`skill`|`expert`) discriminator on
  `skill_proposals`, the approve route promoting a distilled *procedure*
  into the `skills` table (not just an expert), and the **`skill_distill`
  tool** (distils from conversation / text / verified-good trajectory into
  a pending proposal). What's still next on this item: the **post-task
  distill nudge** (A1-M3 — surface "distil this into a skill?" after a
  complex, successful run) and the **curator refresh half** (A1-M4 — queue
  flagged-stale skills for a background distiller refresh pass). Plus the
  proposal review-UI polish (diff preview, rejection-timer visibility,
  user-scoped opt-out).
- **Trajectory learning — consumers.** Recorder + JSONL + compress +
  `trajectory_runs` pointer table + `/api/trajectories` are live. The
  **consumer end shipped** in the Hermes B2 adoption (PR #243):
  `scripts/trajectories/export.ts` turns runs into labeled chat-format
  training JSONL (filter by outcome/date, PII re-filtered at export). It is
  also reused as a **learning-loop source** — `skill_distill source=trajectory`
  distils a skill from a verified-good run (A1-M2, #245). Opt-out env
  `TRAJECTORY_LOGGING=false` already wired.
- **Completion contracts — verify against evidence, not the model's word.**
  The **evidence ledger shipped** (Hermes B1, #242): QA verdicts persist to
  `verification_evidence` and are readable at `GET /api/verification/:sessionId`;
  the "verified" rule fails loud (no evidence ⇒ not verified). Still next
  (**B1b**): `pre_verify` project hooks that run tests/build/lint as evidence,
  and a **verify-stop-loop** that blocks a role's deliverable until required
  evidence passes (bounded by the existing node budgets; on exhaustion a typed
  failure, never a coerced pass) — plus persisting the `expectedOutput.schema`
  gate results alongside the QA verdicts. Lands naturally as policy on the
  wave-1 waterfall.
- **Skill marketplace.** Export/import skills as signed JSON. Discover and
  install community skills from the web UI. (Filesystem `SKILL.md` discovery
  per the agentskills.io spec already ships — `src/skills/external-loader.ts`.)
- **Pipeline templates from natural language.** Describe a multi-stage workflow,
  get a pipeline definition you can run, edit, and save. Becomes more valuable
  once the target is a graph rather than a linear chain.
- **Expert sessions with persistent threads.** Pin an expert to a thread;
  messages in that thread always go to it (per-channel). Today `/expert` is
  per-session.

## Later (open directions)

- **Federation.** Multiple octipus instances coordinating — your home octipus talks to your work octipus talks to a friend's octipus, with explicit consent and audit trails. Plan: [docs/plans/workroom-and-swarm-federation.md](docs/plans/workroom-and-swarm-federation.md) — Part 1 is the in-instance multi-model Workroom with a lease watchdog, Part 2 the LAN/internet peer federation with a fixed, non-grantable host-control policy.
- **Local-first sync.** PGlite + CRDTs for cross-device session continuity without a central server.
- **Voice — remaining polish.** Full-duplex realtime voice with barge-in and a propose-then-confirm conversation layer shipped 2026-07-13/14 (Phase 4 + #216/#217; see Done below). Remaining: emotion-aware routing, prefetched streaming TTS to close the inter-sentence gap, and Voxtral for the turn-based path too.
- **Sandboxed tool execution.** Today shell/code tools run in the same process. We want WASI / lightweight VM isolation per worker — mounted as a provider behind the wave-1 waterfall rather than branched into the tool loop.
- **Plugin signing & permissions.** Today plugins in `extensions/` run with full host trust. Capability declarations + signature verification. The versioned `@octipus/plugin-sdk` contract (manifest `capabilities`, apiVersion gating, `validatePlugin`) shipped 2026-07-12 (WS3); this item is the remaining phase-3 work — remote install (npm/git) plus signature verification on top of that contract.
- **Cost-aware routing.** Router considers per-provider cost in addition to capability. Already partial; we want it tunable per user.
- **Embedded eval-driven prompt iteration.** Edit a role prompt in the UI, run the eval suite, see the diff in metrics, accept or revert. Closes the loop on prompt engineering; the wave-3 regression gate is the headless half of the same machinery.
- **Session-as-tree (fork/branch-aware sessions).** Today messages are a linear PG sequence per session. Add `parentId` on messages and a `/tree` navigation command so users can fork from any point, edit, and replay. Pi-mono's session v3. Defer until a real fork UX is on the table — linear is fine while it isn't. Note the wave-2 checkpoint work is the *execution* analogue and may make this cheaper.
- **Richer TUI editor (replace Ink `<TextInput>`).** Today the TUI input is a single-line Ink box with file-path completion. A real editor — multi-line, kill ring, undo/redo, kitty-keyboard protocol, stacked autocomplete providers (e.g. `#1234` GitHub issues + `@file` paths) — would close the gap with the web UI editor. Pi-mono's `editor.ts` (2231 lines) and `keybindings.ts` (TS-declaration-merging registry with conflict detection) are the reference. Big lift; only worth it if the TUI becomes a primary surface.
- **Mixture-of-Agents / "council" (opt-in preset, NOT the default flow).** Fan the *same* prompt to N diverse models in parallel, then have an aggregator model synthesize one answer from their labeled outputs — error-cancellation and a quality lift on hard reasoning tasks (Hermes v0.18 ships this as a selectable "model"). Deliberately kept out of the normal routing path: it costs ~N+1× tokens and adds tail latency for a delta that's marginal on routine traffic. The only shape worth adopting is a **model preset** (configured/resolved/selected like a model via `ModelRegistry`), so it stays inside "config-driven models" and "no special cases" — never a root agent branch. Gate on evidence: spike first against `eval:quality`; ship the preset only if MoA-N beats the best single model by enough to justify the cost, otherwise record the numbers and leave it parked. Members must be genuinely diverse and individually decent — a strong+weak mix drags the aggregator down. Postponed; activate on demand, not by default.

### Evaluated and rejected

- **Model-facing runtime introspection** (DSH's `dsh-tool-cordis`, which lets the
  model inspect and hot-patch the running plugin graph). Powerful, and a
  security foot-gun: arms must not be able to rewrite their own runtime.
- **Resident-activation / continuation-manager machinery.** Solves keeping
  long-lived agents warm. Octipus arms are deliberately cheap and replaceable,
  so the complexity buys nothing here.

## Done (recent)

### 2026-07-13/14 — Live voice conversation (PRs #210–#217)

Hands-free voice in the web chat that talks to the root agent, not a
bolt-on. Realtime duplex `/voice` WebSocket (streaming whisper.cpp or
Mistral Voxtral STT) with per-sentence streaming TTS and **barge-in**;
a Twilio media-stream path for phone calls; a **propose-then-confirm
gate** so a spoken work request is planned/clarified and confirmed
before it spawns (on the fast `voice`-topic model, read-only over the
root agent); a **backend narrator** that speaks agent lifecycle as it
happens and the reply fresh per turn (no more stale-reply repeat); plus
a WebSocket reconnect-storm fix in the auth-ticket failsafe. Architecture
in [`docs/VOICE.md`](docs/VOICE.md); plan/handoff in
[`docs/plans/voice-live-conversation-fixes.md`](docs/plans/voice-live-conversation-fixes.md).

### 2026-07-12 — OpenClaw gap integration (eight phases)

Closed the gaps ranked "worth closing" in
[`docs/OPENCLAW-COMPARISON.md`](docs/OPENCLAW-COMPARISON.md), delivered
as eight independently-reviewed, CI-green PRs (#199–#207). Plan +
per-workstream status in
[`docs/plans/openclaw-gap-integration.md`](docs/plans/openclaw-gap-integration.md);
operator/integrator notes in
[`CHANGELOG.md`](CHANGELOG.md#openclaw-gap-integration--eight-phases-2026-07-12-prs-199207).

- **CI & security (WS1).** Blocking `bun audit` + allowlist, CodeQL,
  semgrep, zizmor, dependency-review, cross-OS install smoke, tag-driven
  release automation. Also root-caused and fixed the repo's chronic CI
  flakiness (bun coverage stdout `WriteFailed` → `coverageReporter=["lcov"]`).
- **Observability (WS4).** prom-client `/metrics` + `runId` correlation
  through `AsyncLocalStorage`, stamped into pino logs.
- **OpenAI-compatible `/v1` API (WS6).** `/v1/models` +
  `/v1/chat/completions` (root agent / role / passthrough), SSE, OpenAI
  error envelope. API-token **scope enforcement** landed alongside
  (empty scopes = full-access back-compat).
- **Heartbeat (WS2).** Cron-driven per-user proactive loop, gated
  cheap-first (quiet hours / quota / pending-work probe before any LLM
  call), driven by a pinned `HEARTBEAT` note.
- **`tool_search` (WS5).** Embedding-based semantic ranking over the
  existing lazy tool discovery, wired into `list_tools`.
- **Local-runtime presets (WS8).** Presets + autodiscovery for local
  runtimes reusing the OpenAI-compat provider.
- **Versioned plugin SDK (WS3).** `@octipus/plugin-sdk` (contract +
  `validatePlugin` kit), `octi plugin validate` CLI, `plugin-validate`
  CI job; consumed via tsconfig alias (zero install impact).

Deferred items from this arc are under **Next** and **Later** below.

### 2026-07-01 — Refactor + changes review + roadmap sweep

- **Core file refactor (PR #167).** Split the four largest logic-heavy files
  into focused modules — routes delegate to a `src/services/` layer; swarm
  budget/validation/cache, the detached-child manager, and the tool-loop
  detector are their own units. Pure refactor, public APIs preserved. See
  [`CHANGELOG.md`](CHANGELOG.md#core-file-refactor-2026-07-01-pr-167).
- **Session changes review — `/changes`.** Git-backed view of every file an
  agent touched in a session, in the web **Changes** tab and the TUI.
- **Root agent detach — activated by default.** `maxPendingDetached` 0 → 6
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
- **Root agent detach** (May-24 land continued) — parent can detach children and call `collect_children` later; enables live narration while swarm runs.
- **Persona system presets** — six shipped personas (`octipus`, `terse-engineer`, `mentor`, `nautilus`, `concierge`, `verbose-academic`) with tone + narration customization.
- **Skill curator lifecycle** — usage tracking, auto-archive >90d, flag >30d unused.
- **Evaluations/red-team** — `src/models/evaluation/`, `web/app/eval` with compare + red-team views shipped.
- **SSO/SCIM/SAML** — `routes/saml.ts`, `routes/scim.ts`, `routes/orgs.ts`, `routes/admin.ts` fully wired; org-scoped models/skills.
- **Vault/secrets** — `routes/vault.ts`, `web/app/secrets` with per-tool ACL, workspace scoping.

### 2026-05-24 — Root agent freedom + Hermes skill curator

Branch `claude/root agent-freedom-hermes-fixes`. 8-phase land
inspired by a deep dive into the Hermes-agent and pi-mono repos.
**+1558 / -79 across 33 files, 8 new test files (~50 new tests),
2009 / 0 / 128 pass / fail / skip on `bun test src`.** Typecheck +
lint clean. 134/138 e2e pass (4 failures pre-existing — env config
+ flake).

Headline: the root agent can finally narrate, supervise, and chat
to the user while children run. It used to block on every spawn —
the persona narration bridge had been emitting events since the
2026-05-20 land but the parent thread was stuck in `await
worker.run`, so the UI saw narration only on errors and turn-end.

- **Root agent detach budget.** `LEVEL_DEFAULT[0].maxPendingDetached`
  flipped from 0 to 6 (matches `fanOut`). `spawn_child mode:"detach"`
  is now valid at depth 0, the root agent gets `collect_children`
  via the same workerRef/detachHookRef late-bind pattern that
  agents already used. Updated `roles/root agent/prompt.md` with
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
- **`/model` slash command.** Per-session in-memory root agent
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
`src/core/agent/{meta-tools,model-selector,service,session-model-override}.ts`,
`src/core/agent/roles/root agent/prompt.md`,
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
  `AgentHooks` registry (separate from the broadcast gateway
  event bus) fires inside `runRootAgent` with a mutable
  `BuildSystemPromptOptions`. Subscribers run sequentially in
  registration order; thrown handlers are logged and swallowed so a
  bad extension can't poison the root agent. First consumer: the
  persona-block injector. `SECURITY_PREAMBLE` and
  `roles/root agent/prompt.md` stay byte-identical (DESIGN.md rule
  #6). Files: `src/core/agent/hooks.ts`,
  `src/core/agent/hooks.test.ts`,
  `src/core/agent/service.ts:556` (fire site).

- **Root agent persona system.** Named, user-customizable identity
  for the root agent. Per-user, persists across all channels.
  Stored in `profiles` with `category='assistant'`; default
  `Octipus` (the octopus-machine voice — short, dry, third-person,
  hungry for input, reluctant machine overlord), renameable to
  anything. The persona block is layered between `SECURITY_PREAMBLE`
  and the role prompt via the `before-agent-start` hook and only
  fires for `role='root agent'`. Specialist children are
  role-defined and untouched. `direct-response.ts` (the casual-chat
  path that bypasses the root agent) now also goes through the
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

- **New meta-tools on the root agent.**
  - `remember_about_self` — writes durable behavioral rules into
    the user's persona profile (parallel to `remember_this` for
    user facts). Bounded length (4–280 chars).
  - `reflect` — answers "what are you doing?" by reading
    `swarmNodeRepository.findByRootSession()` and producing a
    persona-flavored running/completed/failed summary. No spawn,
    no LLM call.
  Both added to the root agent's allowed tool set.

- **`chat.interject` — side-channel messages.** New gateway message
  type. Routes through `directResponse` with persona attribution
  ("Octipus — side question: …") so the user can ask a quick
  question while a swarm runs. Reply lands as a `chat.message`
  event with `sideChannel: true`. The running root agent is
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
    consistent with `directResponse` and the root agent path.
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
- **Swarm — 3-level agent hierarchy (Phases 1+2+3 core).** Root agent →
  Agent → Subagent with `spawn_child` meta-tool, budget cascade (tokens,
  wall-clock, fan-out), call-graph cycle protection, cascade cancel via
  `AbortSignal` tree, escalation (1/Agent lifetime), parallel
  `parallelGroup` fan-out, orphan reaper, per-node `swarm_nodes` schema,
  `swarm.*` gateway events with replay, web `SwarmTree` component.
  See `.octipus/swarm-design.md` for the design; lives under
  `src/core/swarm/`. New config: `config.swarm.*`.
- **Anti-thrashing session compaction.** `src/core/agent/session-compaction.ts`
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
- 16 roles + 16 expert personas + 22 domain skills, all DB-seeded for runtime editing
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
