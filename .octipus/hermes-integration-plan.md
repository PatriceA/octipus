# Hermes v0.18 → Octipus: Integration Plan

> Implementation plan for the "steal / adapt / finish" items surfaced by the
> comparison against **Hermes Agent v0.18.2** (`v2026.7.7.2`, the "Judgment
> Release" line). Scope is the four items worth building now. **Out of scope:**
> Mixture-of-Agents / "council" (parked in [ROADMAP.md](../ROADMAP.md) → *Later*,
> opt-in preset only) and the ignore-bucket (Honcho user modeling, memory-graph
> UI, `/journey`, extra terminal backends).
>
> Every item is grounded against code that already exists — none of this is
> greenfield. Read [DESIGN.md](../DESIGN.md) first; the principles there
> (fail-loud, no-hardcoded-models, observability-over-cleverness, small-core)
> gate all of it.

## Summary

| # | Item | Verdict | Effort | Risk | Core touch? |
|---|------|---------|--------|------|-------------|
| 1 | Learning loop — generative skill distillation (`/learn`) | Steal | L | Med | No (catalog + new tool/role) |
| 2 | Completion contracts — verification evidence ledger | Finish | M | Low | Extends existing gate |
| 3 | Cron reliability hardening | Steal | S | Low | `cron-runner.ts` only |
| 4 | Vertex AI provider + OAuth2 token minting | Steal | S | Low | New provider, registry-clean |

Recommended order: **3 → 4 → 2 → 1** (cheap-and-contained first; the learning
loop is the big one and benefits from #2's evidence signal).

---

## 1. Learning loop — generative skill distillation

**Goal.** Close the loop octipus half-built. Today the skill lifecycle only
*prunes*; Hermes also *generates*. Add a distiller that turns real work into
reusable skills, routed through the human-approval path that already exists.

**Current state (grounded).**
- `src/skills/curator.ts` — prunes stale skills (flag/archive). Its own comment:
  *"Hermes-inspired learning-loop primitive … Future iterations can spawn a
  background agent to refresh content."* This is the pruning half only.
- `src/db/schema/skill-proposals.ts` + `src/api/routes/skill-proposals.ts` —
  a **proposal table and approve/reject flow already exist**. `GET /skills/proposals`
  lists pending; `POST /:id/approve` promotes; `POST /:id/reject` suppresses for 90 days.
- `src/skills/usage-tracker.ts` — records skill usage (feeds "self-improve on use").
- `src/skills/external-loader.ts` — agentskills.io `SKILL.md` discovery (write target).
- `src/core/trajectories/recorder.ts` — every orchestrator run is already recorded
  to JSONL (the raw material to distill from).

**Design decision to resolve first (blocker).** The existing `approve` route
promotes a proposal into a **custom expert**, not a **skill**. Distilled
*procedures* should become skills (`SKILL.md` / DB skill via `external-loader`),
while distilled *personas/specialists* become experts. Decide the split before
coding: recommended — proposals carry a `kind: 'skill' | 'expert'` discriminator,
and `approve` branches on it. This is a small schema migration on `skill_proposals`.

**Design.**
- New tool `src/tools/skill-distill/` (`BaseTool`, auto-discovered) with three
  sources, mirroring Hermes `/learn`:
  1. **workflow** — distill from the last N turns / a trajectory run id (reads
     `trajectory-repository`).
  2. **directory** — summarize a repo/dir into a procedure (reuses RAG indexer).
  3. **url** — fetch + distill (reuses the reader in `src/core/memory/reader/`).
- Distiller **writes a `skill_proposals` row, never a live skill** — keeps
  "observability over cleverness" and no silent writes. Existing approve route
  (extended for `kind`) does the promotion.
- Honor repo conventions on distill: if `CONTRIBUTING.md` / `AGENT.md` exist,
  feed them into the distiller prompt (Hermes does this).
- **Self-improve-on-use (phase 2):** when `usage-tracker` sees a skill correlated
  with failed outcomes (tie into item #2's verdicts), the curator flags it for a
  refresh proposal instead of silent edits.

**Tasks.**
1. Schema: add `kind` (+ optional `sourceRef`) to `skill_proposals`; `db:generate` → `db:migrate`.
2. Extend `skills/proposals` approve route to branch skill vs expert; skill path
   writes through `external-loader` / skill repository.
3. `src/tools/skill-distill/index.ts` — the tool, three sources, writes proposals.
4. Distiller prompt as a role/expert prompt (no hardcoded model — bind a topic).
5. Curator phase-2: outcome-aware refresh proposals (depends on #2).
6. Web UI: proposals review queue (list/approve/reject already have API).

**Acceptance / eval.** New `eval/` scenario: run a canned workflow → assert a
proposal is produced, is well-formed, and after approval is loadable by
`registry.ts` into a prompt fragment. Red-team: a malicious workflow must not
distill a prompt-injection skill (input guard + human approval gate cover this —
assert the approval gate is non-bypassable).

**Risks.** Proposal spam (bound: rate-limit distills, dedupe by content hash).
Skill-vs-expert confusion (resolved by the `kind` discriminator up front).

---

## 2. Completion contracts — verification evidence ledger

**Goal.** Finish the work started in Phases B1/B2. You already gate on a schema
and emit a machine-readable verdict; add the **evidence** so `/goal`-style tasks
verify against reality (tests pass, build green) instead of the model's word.

**Current state (grounded).**
- `expectedOutput.schema` deterministic output gate — `src/core/orchestrator/types.ts`,
  `roles.ts`, `worker-spawner.ts`, `pipeline-manager.ts` (Phase B1).
- QA JSON verdict — `src/core/orchestrator/qa-verdict-instruction.test.ts` (Phase B2).
- So the **contract shape and verdict channel exist**; what's missing is the
  evidence ledger, project hooks, and the stop-loop.

**Design (Hermes parity, octipus-shaped).**
- **Evidence ledger** — a profile-scoped table recording verification artifacts
  per task: `{ taskId, kind: 'test'|'build'|'lint'|'custom', command, exitCode,
  passed, output_excerpt, at }`. New `src/db/schema/verification-evidence.ts`.
- **`pre_verify` hooks** — reuse the existing hook system (`src/hooks/`): a
  `pre_verify` trigger runs project-defined checks (e.g. `bun test`) and appends
  to the ledger. No new hook primitive — it's another trigger type.
- **Verify-stop-loop** — a role that owns a `completion_contract` cannot emit its
  final deliverable until required evidence rows exist and pass. On fail, it loops
  (bounded by swarm wall/token budget — reuse `fan-out-budget` caps) with the
  failing output fed back. Fail-loud when budget exhausts: surface "unverified".
- **Gateway exposure** — add verification status to the work-stream/agents
  overview (`src/core/work-stream/renderers.ts` already renders verdicts).

**Tasks.**
1. Schema + repository for `verification_evidence` (profile-scoped RLS like others).
2. Extend `expectedOutput` → `completionContract` with `requiredEvidence: [...]`.
3. `pre_verify` hook trigger in `src/hooks/triggers.ts` + runner that shells the
   check and writes evidence (via `tool-executor` permission path — no raw shell).
4. Stop-loop in `worker-spawner` / `agent-worker`: block final until evidence passes.
5. Render verification status in work-stream + expose on the agents API.

**Acceptance / eval.** Eval scenario: a coding task with a failing test must NOT
finalize as success — it either fixes-and-passes or surfaces "unverified" with the
ledger attached. Assert no path lets a model self-assert completion past a red check.

**Risks.** Loop cost (bounded by existing budgets — do not add a new budget).
Over-gating simple tasks (contracts are opt-in per role/`/goal`, not global).

---

## 3. Cron reliability hardening

**Goal.** Three targeted reliability fixes Hermes shipped, straight into the
existing runner. Pure hardening, no new surface.

**Current state (grounded).** `src/core/cron-runner.ts` — custom cron parser
(`getNextCronDate`), 60s tick, hook-driven jobs; `maybeRunHeartbeats` already
imported. `src/core/scheduler.ts` + `scheduler.test.ts` alongside.

**Design (the three fixes).**
1. **Fail closed on provider drift.** If a scheduled job's bound model/provider
   is unavailable at fire time, the job must **fail loud with a named reason**
   (not silently skip, not fall back to a default — DESIGN "no-hardcoded-models").
   Record a failed run row with the reason; surface it.
2. **Missed-grace runs once.** If the process was down across one or more fire
   times, on recovery run the job **exactly once** (catch-up), not once-per-missed
   interval (no thundering backlog), and not defer-forever.
3. **Heartbeat-aware status.** Tie tick liveness to the heartbeat so a wedged
   ticker is detectable (`maybeRunHeartbeats` is already wired — assert it and
   expose "last successful tick" in status/doctor).

**Tasks.**
1. `cron-runner.ts`: provider-availability check pre-fire → failed run + reason.
2. Catch-up logic: on tick, collapse all missed fires since `lastRun` into one run.
3. Heartbeat-aware `lastTickAt` + surface in `scripts/doctor.ts` and status API.
4. Tests in `scheduler.test.ts`: down-across-N-fires → exactly one catch-up;
   provider-down → failed-with-reason, not skipped.

**Acceptance.** Unit tests above green; `octi doctor` shows scheduler liveness.

**Risks.** Minimal. Catch-up semantics must be explicit (once, not N times) — the
test above is the guard.

---

## 4. Vertex AI provider + OAuth2 token minting

**Goal.** Add Google Vertex AI as a first-class provider with **automatic OAuth2
token minting/refresh** (no static keys), the way Hermes v0.18 did.

**Current state (grounded).** `src/models/providers/` holds one provider per file
(`gemini-provider.ts`, `anthropic-provider.ts`, …), each implementing
`ModelProvider` (`interface.ts`), auto-registered via `index.ts` + `discovery/`.
`gemini-provider.ts` already talks to Google's OpenAI-compat endpoint — Vertex is
the sibling that uses the Vertex endpoint + service-account OAuth instead of an
API key. `ModelRegistry` resolves providers by topic binding — **no hardcoded
model rule applies**; Vertex is just another bindable provider.

**Design.**
- New `src/models/providers/vertex-provider.ts` implementing `ModelProvider`,
  modeled on `gemini-provider.ts`.
- **Token minting:** use `google-auth-library` (service-account JSON or ADC) to
  mint + auto-refresh a short-lived bearer; no static key stored. Credentials
  path/JSON goes in the **vault** (`src/security/vault`, AES-256-GCM), not `.env`.
- Endpoint: Vertex `…-aiplatform.googleapis.com` (region + project from config).
- Register in providers `index.ts` / `discovery`; expose in setup wizard + model
  picker so a topic can bind a Vertex model.
- Health check via `ProviderHealthStatus` like the others.

**Tasks.**
1. `vertex-provider.ts` — completion/stream, error via `classifyError`, reuse
   Gemini schema sanitizer (`custom/gemini-envelope`) since payloads match.
2. OAuth2 token manager (mint + cache + refresh-before-expiry); creds from vault.
3. Register in provider discovery + `ModelRegistry`; add to setup + model API.
4. Tests: token refresh path (mock), provider conformance suite
   (`conformance` harness in `src/models/`).

**Acceptance.** Conformance suite passes for a Vertex-bound topic; a token expiry
mid-session refreshes transparently (test with a short mock TTL); no static key on
disk (creds only in vault).

**Risks.** Low. Credential handling is the sensitive part — vault-only, never
logged, covered by the "no secrets in commits" rule.

---

## Cross-cutting notes

- **One thing per PR** (AGENT.md). Each item above is ≥1 PR; #1 and #2 are
  multi-PR (schema → mechanism → UI). Don't stack feature-on-feature branches
  without minding the merge-order footgun documented in AGENT.md.
- **Eval gates merge.** Items #1 and #2 change routing/tool/prompt behavior →
  `bun run eval` must pass, including red-team scenarios.
- **No hardcoded models anywhere** — the distiller (#1), verifier (#2), and Vertex
  binding (#4) all resolve via `ModelRegistry.getModelForTopic`.
- **Sequencing:** ship #3 and #4 first (contained, low-risk, build momentum), then
  #2 (evidence signal), then #1 (which can consume #2's verdicts for
  self-improvement). MoA stays parked.
