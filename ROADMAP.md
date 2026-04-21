# Roadmap

> **Note.** Directions, not promises. Items move, get reshaped, or get dropped as the project learns. If something here is interesting, open an issue and let's talk before you build.

This doc lists what we are exploring. Order inside each section is rough priority, not strict sequencing. PRs welcome on anything marked **Help wanted**.

---

## Now (in flight)

- **Auto-discovery for tools and channels.** Roles got the drop-folder
  pattern (`src/core/orchestrator/roles/<name>/`). Tools and channels are
  still wired manually because (a) the `BaseTool` / `BaseChannel`
  abstract surface is wider than `RoleConfig` (lifecycle hooks,
  reaction/typing methods, channel-specific webhooks) and a folder
  convention has to encode all of it, and (b) channels are conditionally
  enabled by env vars, so a discovery loop has to stay opt-in. Doable
  but needs a typed contract pass first; tracked here so the work isn't
  silently dropped.

- **Swarm Phase 3 polish.** Phases 1–3 shipped: 3-level spawner, budget
  cascade (tokens pool-shared, wall-clock per-node, fan-out), call-graph
  cycle protection with fingerprint set, cascade cancel via AbortSignal
  tree + DB walk, orphan reaper, escalation (1/Agent lifetime), parallel
  `parallelGroup`, per-user spawn rate limit, and the live `SwarmTree`
  web component with `swarm.*` gateway replay. Remaining polish:
  `swarm.budget_warning` emission at 80% cap (event type already declared),
  `CLIAgentWorker` parent-signal chain (Phase 2 only wired `AgentWorker`),
  and applying `guardInput` to outbound `taskBrief`/`parentSummary` before
  child message composition (design says so; current code doesn't).

- **Pipeline DAG view.** Render pipeline stages as a graph in the web UI. Edit either view, the other updates. First step toward the two-view (graph ↔ code) abstraction described in [DESIGN.md](./DESIGN.md).

- **Source attribution everywhere.** Every assistant reply appends what it pulled from (profile facts, knowledge base hits, recent messages, classifier topic). Already in `directResponse` and the orchestrator path; expanding to expert sessions and pipeline stages.

- **Per-channel `/clear` semantics.** Webchat clears UI; Telegram/Slack/etc. preserve transcript but reset orchestrator context boundary. `clearedAt` boundary now respected by orchestrator + direct response.

- **Cross-session aggregation** for channel transcripts (telegram, slack, whatsapp, teams, discord). One continuous view per (user, channelType, channelId) instead of one row per restart.

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

- **Federation.** Multiple assistant instances coordinating — your home assistant talks to your work assistant talks to a friend's assistant, with explicit consent and audit trails.
- **Local-first sync.** PGlite + CRDTs for cross-device session continuity without a central server.
- **Voice as a first-class channel.** Today STT/TTS works through the gateway; we want full duplex voice with interruption handling and emotion-aware routing.
- **Sandboxed tool execution.** Today shell/code tools run in the same process. We want WASI / lightweight VM isolation per worker.
- **Plugin signing & permissions.** Today plugins in `extensions/` run with full host trust. Capability declarations + signature verification.
- **Cost-aware routing.** Router considers per-provider cost in addition to capability. Already partial; we want it tunable per user.
- **Embedded eval-driven prompt iteration.** Edit a role prompt in the UI, run the eval suite, see the diff in metrics, accept or revert. Closes the loop on prompt engineering.

## Done (recent)

### 2026-04 batch

- **Swarm — 3-level agent hierarchy (Phases 1+2+3 core).** Orchestrator →
  Agent → Subagent with `spawn_child` meta-tool, budget cascade (tokens,
  wall-clock, fan-out), call-graph cycle protection, cascade cancel via
  `AbortSignal` tree, escalation (1/Agent lifetime), parallel
  `parallelGroup` fan-out, orphan reaper, per-node `swarm_nodes` schema,
  `swarm.*` gateway events with replay, web `SwarmTree` component.
  See `.assistant/swarm-design.md` for the design; lives under
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
