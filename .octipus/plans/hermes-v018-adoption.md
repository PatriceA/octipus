# Hermes v0.18 adoption plan

> Source comparison: Hermes Agent v0.18.2 (tag `v2026.7.7.2`, 2026-07-08); the
> substantive release is v0.18.0 "Judgment" (2026-07-01). This plan covers what
> we steal, what we finish, and the one spike. Features we decided to ignore
> (Honcho user modeling, memory-graph UI, `/journey`, extra terminal backends,
> Windows Git Bash bundle) are intentionally absent.

Status: proposed · Owner: TBD · Branch of record: `claude/hermes-octopus-comparison-o6ysqo`

---

## Track A — Steal

### A1 · Close the learning loop: skill distillation (`/learn` equivalent) 🔥

**Gap.** `src/skills/curator.ts` implements only the *pruning* half of the
Hermes learning loop (stale → flag/archive). Nothing in octipus *creates*
skills from experience. Hermes `/learn` distills a reusable skill from a
directory, a URL, or a recent workflow.

**What we already have to build on**
- Skill registry with DB-backed + filesystem (agentskills.io `SKILL.md`)
  discovery: `src/skills/registry.ts`, `src/skills/external-loader.ts`.
- **Skill proposals API** (`src/api/routes/skill-proposals*`), so distilled
  skills can land as *proposals pending review*, not silent writes — this is
  the octipus-shaped version of Hermes's autonomous skill creation and keeps
  the permission model intact.
- Trajectory recorder (`src/core/trajectories/recorder.ts`) — per-run JSONL
  with classification, steps, and outcome. This is the raw material for
  "distill from recent workflow".
- Skill usage tracker (`src/skills/usage-tracker.ts`) — the feedback signal
  for the self-improvement half.

**Plan (4 milestones, each shippable alone)**
1. **`skill_distill` built-in tool** — `src/tools/skill-distill/index.ts`
   extending `BaseTool` (auto-discovered). Input: `{ source: 'conversation' |
   'trajectory' | 'directory' | 'url', ref, topicHint? }`. Output: a skill
   proposal (name, frontmatter, body) POSTed to the proposals API. Model
   resolved via a new `skill-distillation` topic — **no hardcoded model**
   (DESIGN.md). Tool allowlist: read-only fs + web fetch; no shell.
2. **Distill-from-trajectory** — read the day's JSONL (or a `trajectory_runs`
   row), select successful runs (`outcome=success` + QA verdict pass), prompt
   the distiller to extract the *procedure*, not the instance. PII already
   stripped at record time.
3. **Post-task nudge** — orchestrator meta-hook: after a run whose
   classification is complex (multi-stage pipeline or swarm depth ≥ 2) and
   outcome is success, emit a suggestion event ("distill this into a skill?")
   through `src/hooks/` suggestions. Explicit user yes → runs the tool. No
   silent autonomous creation in v1.
4. **Curator refresh half** — extend `curator.ts` so *flagged* (not stale
   enough to archive) skills can be queued for a background refresh pass via
   the distiller — this is the "future iterations" the file's own comment
   promises. Gate behind config, default off.

**Non-goals (v1):** fully autonomous skill creation without approval;
self-mutating skills during use (needs a versioning story first — proposals
give us one for free).

**Tests/eval:** unit tests per milestone; a routing eval case ensuring the
nudge fires only on the intended class of runs. `bun run eval` must not
regress.

**Estimate:** M1+M2 ≈ 1 week; M3 ≈ 2–3 days; M4 ≈ 2–3 days.

---

### A2 · Scheduler reliability hardening 🔧

**Gap.** Hermes v0.18 hardened cron: fail **closed** on provider drift,
missed-grace jobs run **once** instead of deferring repeatedly, heartbeat-aware
status so a dead ticker is visible.

**Where.** `src/core/scheduler.ts` (Redis/Valkey queue + wake-gates).

**Plan**
1. **Missed-grace semantics.** Define `missedGraceMs` per task. On startup /
   ticker recovery, a task whose `scheduledAt` is inside the grace window runs
   exactly once; older misses are marked `skipped_missed` (new `TaskEvent`
   type) — never a burst of catch-up runs, never a silent skip (fail loud:
   the skip is an event).
2. **Fail-closed on dependency drift.** If a task's execution context can't be
   resolved at fire time (topic unbound in `ModelRegistry`, tool missing,
   wake-gate evaluator not registered), the run **fails with a named reason**
   (`failed` event + log), rather than deferring forever. Today
   `evaluateWakeGate` resolves runtime failures to `{run:false}` → silent
   perpetual defer; add a `consecutiveSkips` cap that flips to `failed`.
3. **Heartbeat.** Scheduler ticker writes `scheduler:heartbeat` (timestamp) to
   Valkey each tick; expose in `/api` health + `octi doctor`. A stale
   heartbeat is an explicit doctor warning.

**Tests:** unit tests for grace-window matrix (before/inside/after), skip-cap
flip, heartbeat staleness.

**Estimate:** 2–3 days total. No schema change (task state is queue-side).

---

### A3 · Vertex AI provider (OAuth2 token minting, no static keys) 🔧

**Gap.** Providers today: Ollama, OpenAI, Anthropic, Gemini (API-key),
OpenRouter, Mistral, DeepSeek, Grok, LiteLLM, custom-OpenAI. No Vertex AI.
Hermes ships it with automatic OAuth2 token mint + refresh from a service
account — no static keys.

**Plan**
1. `src/models/providers/vertex-provider.ts` following the sibling-provider
   shape (`interface.ts`); errors routed through
   `src/core/errors/classification.ts` like every other provider.
2. Auth: service-account JSON (stored in the vault, `src/security/` —
   AES-256-GCM) → self-signed JWT → token endpoint → cached access token with
   refresh-before-expiry. ~60 lines; **no new dependency** (JWT signing via
   `crypto`) per "no dependency for something doable in ~20 lines" ethos.
3. Reuse `gemini-history.ts` request/response mapping where the wire format
   overlaps (Vertex serves Gemini models); keep Anthropic-on-Vertex out of
   scope v1.
4. Conformance tests mirroring `mistral-provider.test.ts`; register in
   provider discovery + `octi setup` provider list.

**Estimate:** 3–4 days incl. conformance tests.

---

## Track B — Finish what's in flight

### B1 · Completion contracts + verification evidence ledger 🎯

**Current state (60% there).** #230 landed `expectedOutput.schema` as a
deterministic output gate; #231 landed machine-readable QA JSON verdicts
(`src/core/orchestrator/qa-verdict-instruction*`, verdict types in
`orchestrator/types.ts`). What's missing vs Hermes completion contracts:
evidence, hooks, and the bounded retry loop.

**Plan**
1. **Evidence ledger.** New Drizzle table `verification_evidence`
   (`src/db/schema/`): `{ id, sessionId, nodeId, kind: 'schema_gate' |
   'qa_verdict' | 'pre_verify' | 'adhoc_script', verdict, detail(jsonb),
   createdAt }`. Schema-gate results and QA verdicts (which today are consumed
   and dropped) get **persisted** — durable per DESIGN.md ("if a user needs to
   see it after a crash, it lives in the DB"). Surface in the web UI agents
   overview (observability over cleverness).
2. **`pre_verify` hooks.** Per-role / per-pipeline-stage optional check
   command or tool call (Zod-validated config), run *before* the deliverable
   is accepted: e.g. QA stage runs `bun test` via an allowlisted tool and the
   result becomes evidence. Wire through `src/hooks/` (triggers/actions
   already exist) — **no orchestrator special case**; it's "pause until an
   external signal" generalized to "gate on a check result".
3. **Verify-stop-loop.** When the schema gate or pre_verify fails: bounded
   retry (default `maxVerifyAttempts: 2`) feeding the failure back to the
   worker as a structured correction turn; on exhaustion → typed failure on
   `ChildResult` (fail loud, never a coerced pass). Budget-aware: retries
   spend the node's existing token/wall budgets, no new budget class.
4. **Gateway exposure.** `verification` event on the WS protocol
   (`src/core/gateway/protocol.ts`) so TUI/web can render pass/fail evidence
   live.

**Tests/eval:** schema-gate fail→retry→pass path; retry exhaustion produces
typed failure; eval regression suite green.

**Estimate:** ~1 week. Migration via `bun run db:generate`.

### B2 · Trajectory export for training 🎯

**Current state.** Recorder + daily JSONL + gzip (`scripts/trajectories/
compress.ts`) + `trajectory_runs` pointer table + API routes exist. Missing:
the consumption end that makes recordings *useful* — Hermes ships batch
trajectory generation + compression for training.

**Plan**
1. `scripts/trajectories/export.ts`: filter (`--from --to --outcome
   --minVerdict`) → emit standard chat-format JSONL (system/user/assistant/
   tool turns) suitable for fine-tuning pipelines. Verdict filter joins the
   B1 evidence ledger — export only *verified-good* runs.
2. Redaction pass re-runs `filter_pii` full-category filter at export time
   (belt and braces; recorder strips only email/phone inline).
3. Non-goal: batch trajectory *generation* (Hermes's synthetic-run harness).
   Park until there's a training consumer.

**Estimate:** 2 days. Depends loosely on B1 step 1 (verdict filter degrades
gracefully to outcome-only if ledger absent).

---

## Track C — Spike only

### C1 · Mixture-of-Agents (MoA) preset — timeboxed spike 🧪

**Hermes shipped:** named MoA ensembles selectable as "models" in every
picker; reference-model outputs render as labeled blocks; aggregator streams
the synthesis live.

**Why spike, not build:** overlaps our swarm fan-out and topic-bound model
resolution; a first-class ensemble primitive risks violating "no special
cases" and "config-driven models" if done as a core feature. The spike's job
is to find out whether MoA earns its complexity on *our* eval suite.

**Spike (timebox: 3 days, throwaway branch, no core changes)**
1. Prototype a `moa` composite provider in `src/models/` that: takes N
   configured member models + 1 aggregator model (all resolved via
   `ModelRegistry` topics — no hardcoding), fans out one prompt, then feeds
   labeled member outputs to the aggregator. Streaming of the aggregator only.
2. Run `bun run eval` (`eval:quality`) with: (a) best single model, (b) MoA-3,
   on the same scenario set. Record quality delta, latency, token cost.
3. **Decision gate:** adopt only if quality delta on our evals justifies
   ≥3× token cost; if adopted, productize as a *model preset* (like
   `providers/presets.ts` local-runtime presets), never as an orchestrator
   feature. Otherwise: write findings here and park.

**Deliverable:** findings appended to this doc + go/no-go.

---

## Deferred (explicitly, with reasons)

### Scale-to-zero gateway + drain coordination — deferred

Plain-language: Hermes's gateway (the always-on process holding channel/WS
connections) can now **hibernate when idle** and be woken by the hosting
infrastructure on the next incoming connection ("scale to zero" = zero
processes running while idle, so a cloud host bills nothing). "Drain
coordination" is the restart half: before a deploy/restart, the gateway stops
accepting new connections, finishes in-flight work, then exits — so nothing
drops mid-conversation.

This matters when you pay per-uptime for a hosted relay. Octipus is
local-first (DESIGN.md): an idle local process costs ~nothing, and we have no
hosted relay today. **Re-open if/when a hosted/relay deployment story exists.**
The drain half alone (graceful stop: finish in-flight worker turns before
`octi stop` kills the process) is cheap and generally useful — filed as a
possible follow-up to A2, not committed here.

---

## Sequencing

```
Week 1:  A2 scheduler hardening (2–3d)  →  A3 Vertex provider (3–4d)   [independent, can swap]
Week 2:  B1 completion contracts (ledger → hooks → stop-loop → gateway event)
Week 3:  A1 learning loop M1+M2 (distill tool + from-trajectory)
Week 4:  A1 M3+M4 (nudge + curator refresh)  ·  B2 export (2d)  ·  C1 MoA spike (3d, parallel)
```

Rationale: A2/A3 are contained warm-ups with immediate value; B1 lands before
A1-M2 and B2 because both consume its verdict/evidence data; C1 is parallel
and throwaway.

One PR per lettered item (or per A1 milestone) — "one thing per PR". Routing/
prompt/tool-selection changes (A1-M3, B1-3) must pass `bun run eval`.

## Risks

- **A1 scope creep** toward autonomous self-modification — held in check by
  the proposals-only rule; revisit only after M1–M3 have soaked.
- **B1 retry loops** can burn budget on unfixable outputs — mitigated by
  `maxVerifyAttempts` + existing hard budget caps (breach still throws).
- **Vertex auth drift** (token endpoint quirks per region) — conformance test
  against a mocked token endpoint; document the service-account setup in
  `docs/`.
- **MoA spike leaking into core** — spike branch is explicitly throwaway; the
  only durable artifact is the findings section.
