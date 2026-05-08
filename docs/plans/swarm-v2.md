# Octipus Swarm Upgrade — Strategic Plan

## Context

Three research/integration questions for Octipus swarm (kernel.sh dropped per user):

1. ~~kernel.sh~~ — **out of scope per user; leave as Playwright-only path**
2. **tdd-red-green-refactor** mcpmarket skill — adopt or fold into existing skill
3. **6 swarm principles** (clean context, adversarial validation, tracer bullets, planning/exec split, deterministic bookkeeping, validation contract) — map to current Octipus swarm
4. **Workflow phases** (Grill Me, PRD, Kanban, Ralph Loop, Vertical Slices, Push/Pull standards) — apply to Octipus pipeline

Goal: actionable design doc for next sprint. Final location on approval: `octipus/docs/plans/swarm-v2.md`. Not implementing now — planning only.

Ground-truth from `/home/patrice/Github Rep/octipus`:
- Swarm spawner: `src/core/swarm/spawner.ts` (depth+budget cascade)
- Structured handoff: `src/core/swarm/handoff.ts` (regex extraction, ~8-10 items, 2000-char output truncation)
- Roles: `src/core/orchestrator/roles/{review,qa,code,research}/config.ts` — review/qa see full prior stage output (no isolation)
- Pipeline: `src/core/orchestrator/pipeline-manager.ts` — sequential, retry on `qa_validation` stage type, default maxRetries=3
- Pipeline templates: `src/db/seed-presets.ts` "Full Development Cycle" — research → reqs+arch (gate) → impl → test → review → QA → summary
- Skills: `src/db/seed-skills.ts` — `test-automation` skill already includes "Red-Green-Refactor" prose
- Multi-provider: `src/core/orchestrator/model-selector.ts` + `models/providers/` (Anthropic, OpenAI, Ollama, Gemini, OpenRouter, LiteLLM, Voyage). Routing per topic; **user assigns topic→provider**
- Scheduled tasks: cron (recurring) + datetime (one-time, auto-disable) — already in startup sequence
- Browser: `browser-ext` tool exists for agent reads; Playwright for automation stays the path

---

## 1. kernel.sh — Decision

**Out of scope.** No changes; Playwright remains the browser automation driver.

---

## 2. tdd-red-green-refactor Skill

### Verdict
**Do NOT add as separate skill. Promote existing `test-automation` skill content into a workflow phase + sharpen the prompt.**

### Why
- `seed-skills.ts` `test-automation` skill already has "Write the test first (TDD)" + Red-Green-Refactor framework as prose
- Mcpmarket version is single-shot prompt engineering; gap in Octipus is **enforcement**, not documentation
- Adding a duplicate skill bloats registry with no orchestration win

### Action
- **Refactor** existing `test-automation` skill in `src/db/seed-skills.ts` to:
  - Pull explicit phase markers (`<phase>red</phase>` etc.) the orchestrator can detect
  - Reference validation-contract assertion format (§3.6)
- **Add new pipeline template** `tdd-cycle` to `seed-presets.ts`:
  - Stage 1 (`code` role, restricted): write failing test only — fail if test passes on first run
  - Stage 2 (`code` role): minimal impl to make test pass — fail if any unrelated code changed
  - Stage 3 (`review` role): refactor + ensure tests still green
- Hook into `pipeline-manager.ts` retry loop: if Stage 1 test passes immediately, force retry with stricter prompt

### Critical files
- `src/db/seed-skills.ts` (rewrite test-automation skill body)
- `src/db/seed-presets.ts` (add tdd-cycle template)
- `src/core/orchestrator/pipeline-manager.ts` (no code change; uses generic stages)

---

## 3. Six Swarm Principles → Octipus Mapping

### 3.1 Clean Context (Statelessness)
- **Current**: handoff.ts already does structured summary with truncation. Good foundation.
- **Gap**: regex extraction misses semantic content; outputs >2000 chars truncated mid-sentence; no token budget guard against parent context > 100k.
- **Change**:
  - Replace regex extraction with 1-shot LLM call to a small/fast model (Haiku 4.5) producing structured JSON `{decisions[], artifacts[], openQuestions[], blockers[]}` — fail closed if exceeds 4k tokens
  - Add `MAX_AGENT_CONTEXT_TOKENS=100000` env; spawner refuses to spawn if projected context > limit
- **Critical files**: `src/core/swarm/handoff.ts`, `src/core/swarm/spawner.ts`

### 3.2 Adversarial Validation (Black-Box Validator)
- **Current**: review + qa roles see full previous stage output (no isolation)
- **Gap**: confirmation bias — validator reads worker's logs and rationalizes
- **Change**:
  - QA role receives **only** validation contract (§3.6) + final artifacts (file diff, screenshots from existing Playwright tools) — NOT the worker's chain-of-thought, decisions log, or partial outputs
  - New `stage.contextFilter: 'artifacts-only'` flag on QA stages in pipeline-manager.ts
  - QA prompt: "you are a hostile reviewer; assume the implementation is wrong until proven otherwise"
  - For UI features: QA spawns sub-worker driving Playwright per the validation contract; screenshots saved as artifacts
- **Critical files**: `src/core/orchestrator/pipeline-manager.ts`, `src/core/orchestrator/roles/qa/config.ts`, `src/core/orchestrator/roles/qa/prompt.ts`

### 3.3 Tracer Bullets (Vertical Slice)
- **Current**: pipeline is linear horizontal (research → arch → impl → test). No layer enforcement.
- **Change**:
  - New stage type `vertical_slice` in pipeline-manager.ts. Stage rejects completion unless diff touches ≥2 of {db schema, api/server, frontend, tests}. File-path glob heuristic.
  - New pipeline template `slice-first` for greenfield features: stage 1 = thinnest possible end-to-end (one DB column → one API field → one UI label → one test) before any deepening
- **Critical files**: `src/core/orchestrator/pipeline-manager.ts`, `src/db/seed-presets.ts`

### 3.4 Planning vs Execution Split (Seat Strategy)
- **Current**: `model-selector.ts` routes per topic. User configures which provider/model serves which topic.
- **Approach**: **No auto-routing.** User-driven configuration only. Avoids locking us into provider availability assumptions; user owns the bias trade-off.
- **Change**:
  - Add documented "seat → topic" convention in `docs/swarm-philosophy.md`:
    - `planner` topic → reasoning-heavy
    - `worker` topic → fast coder
    - `validator` topic → user's choice; recommend cross-provider to break family bias
  - Each role config (`roles/*/config.ts`) declares which seat it occupies (planner/worker/validator)
  - Orchestrator surfaces a UI warning in Settings if validator + worker resolve to the same provider — **warn only, never auto-correct**
- **Critical files**: `src/core/orchestrator/roles/*/config.ts` (add `seat` field), `src/core/orchestrator/model-selector.ts` (expose seat→topic map), settings UI (new bias warning), `docs/swarm-philosophy.md`

### 3.5 Deterministic Bookkeeping + Non-Deterministic Logic
- **Current**: pipeline-manager.ts is mostly deterministic. Retry loop hard-coded.
- **Change**:
  - Hard-coded retry stays for transient failures (rate limit, timeout)
  - On semantic failure (validation-contract assertion fail), pipeline-manager hands error + contract back to **orchestrator role** which decides: retry as-is, rescope, split into sub-tickets, escalate to user
  - New event `pipeline.semantic-failure` consumed by orchestrator service
- **Critical files**: `src/core/orchestrator/pipeline-manager.ts`, `src/core/orchestrator/service.ts`, `src/core/gateway/event-bus.ts`

### 3.6 Validation Contract (pre-code assertions)
- **Current**: NONE. Architecture stage produces freeform requirements doc.
- **Change**:
  - New stage type `validation_contract` runs after requirements/arch, before impl
  - Output: structured JSON list of assertions, each: `{id, scope: ui|api|db|integration, given, when, then, automatable: bool}`
  - Persisted to DB (new table `validation_contracts` with FK to pipeline_run_id) — survives across stages, fed verbatim to QA (§3.2)
  - Block downstream stages until contract approved (existing approval-gate machinery)
- **Critical files**: new `src/db/migrations/NNNN_validation_contracts.sql` + journal entry, `src/db/schema/validation-contracts.ts`, `src/core/orchestrator/pipeline-manager.ts`, `src/db/seed-presets.ts`

---

## 4. Pocock Workflow Phases — Mapping

| Pocock phase | Octipus equivalent today | Action |
|---|---|---|
| **Grill Me** (alignment interview) | None — orchestrator goes straight to planning | New pipeline stage `requirements_grill`: orchestrator role, max-N clarifying Qs to user via gateway, exits when ambiguity score < threshold (LLM self-rates). Critical file: `src/core/orchestrator/pipeline-manager.ts` |
| **PRD / Destination** | Architecture stage produces reqs doc | Rename + restructure to PRD format; consumed by validation contract stage (§3.6). Critical file: `src/db/seed-presets.ts` |
| **Kanban / Issues** | Pipeline stages = the "issues" | Add `split_into_issues` tool (meta-tools.ts) taking PRD → independently-grabbable tickets in DB, each runnable as own pipeline. Critical files: `src/core/orchestrator/meta-tools.ts`, new `tickets` schema |
| **Ralph Loop (AFK)** | **Already covered by recurring scheduled tasks** | **No new infra.** Document the pattern: a recurring cron task with prompt "pull next open ticket from queue, run `slice-first` pipeline, mark done or escalate" achieves the AFK loop. Action: add example template to `seed-presets.ts` + doc snippet in `docs/swarm-philosophy.md`. Optional polish: convenience tool `next_ticket()` for cron-task prompts. |
| **Vertical Slices** | covered §3.3 | — |
| **Inversion of Control** | User owns "Day Shift" | Document only, no code. `docs/swarm-philosophy.md`. |
| **Push standards** (strict reviewer) | review role exists | Reviewer role runs deterministic checks (lint/typecheck/test) before LLM review. User assigns reviewer's model topic to a different provider if they want anti-bias. |
| **Pull standards** (worker pulls docs) | Skills system already does this | No change — skills lazily injected (worker-spawner.ts:128). Ensure docs are skill-tagged. |

---

## Phasing (recommended execution order)

1. **Phase A — foundations** (1–2 days): §3.6 validation contract, §3.1 LLM-based handoff, §3.4 seat field on roles + bias warning in settings.
2. **Phase B — adversarial validation** (1–2 days): §3.2 black-box QA with contract injection, prompt rewrite. Regression test against existing Full Development Cycle template.
3. **Phase C — workflow phases** (2–3 days): §4 Grill Me stage + Kanban tool + Vertical Slice template (§3.3) + TDD pipeline (§2).
4. **Phase D — Ralph Loop docs + ticket queue tool** (½ day): §4 example recurring-task template + `next_ticket()` helper. **No new scheduler — uses existing cron.**
5. **Phase E — orchestrator escalation** (1 day): §3.5 semantic-failure event + rescope path.

---

## Verification

End-to-end check after each phase:

- **Phase A**: run existing pipeline; assert `validation_contracts` row created, handoff JSON valid, role configs all declare `seat`
- **Phase B**: intentionally inject a bug the worker logs explain away; confirm black-box QA still catches it (regression test in `src/core/orchestrator/__tests__/`)
- **Phase C**: run TDD template on toy feature; assert Stage 1 produces failing test, Stage 2 produces minimal diff; run `slice-first` template, confirm ≥2 layers touched
- **Phase D**: configure recurring task with ticket-queue prompt; confirm it picks tickets, runs pipelines, marks done
- **Phase E**: force a semantic-failure (contract assertion fails); confirm orchestrator role receives event and emits rescope decision

Run full backend test suite (`bun test`) after each phase.

---

## 5. Documentation & Website Rollout

The principles must be written down in three places: repo docs (developer-facing), website docs (user-facing), and the landing page (marketing/positioning). All three need to be updated **in lockstep with the feature work** — the principles are the product story, not an afterthought.

### 5.1 Repo docs — `/home/patrice/Github Rep/octipus/docs/`

- **NEW** `docs/SWARM-PHILOSOPHY.md` — canonical principles doc. Six principles (§3) + workflow phases (§4) + seat strategy (§3.4) + bias-warning rationale. Link from main README.
- **NEW** `docs/architecture/swarm-v2.md` — architecture-level: handoff JSON schema, validation-contract table schema, stage types (`vertical_slice`, `validation_contract`, `requirements_grill`), event flow for `pipeline.semantic-failure`.
- **UPDATE** `docs/AGENT-ARCHITECTURE.md` — add seat field to role config example, link to SWARM-PHILOSOPHY.md
- **UPDATE** `docs/QA.md` — document black-box validator mode + artifacts-only context filter
- **UPDATE** `docs/TESTING.md` — TDD pipeline template usage, red→green→refactor stage contract
- **UPDATE** `docs/PROMPTING.md` — Grill Me phase + ambiguity threshold
- **UPDATE** `docs/CHANGELOG.md` + `docs/WEEKLY-CHANGELOG-*.md` — entries per phase
- **UPDATE** `docs/EXPERT-TOPIC-SKILL-ROUTING.md` — seat→topic→model mapping convention, user-driven anti-bias guidance

### 5.2 Website docs — `/home/patrice/docker-services/octipus-website/src/content/docs/docs/`

- **NEW** `features/swarm-philosophy.mdx` — user-facing version of SWARM-PHILOSOPHY.md (less code, more diagrams)
- **NEW** `features/validation-contracts.mdx` — what they are, when written, how to read them
- **UPDATE** `features/orchestrator.mdx` — Grill Me phase, seat strategy, semantic-failure escalation
- **UPDATE** `features/pipelines.mdx` — new stage types (`vertical_slice`, `validation_contract`, `requirements_grill`, `tdd-cycle`)
- **UPDATE** `features/agent-runtime.mdx` — clean-context handoff, 100k token guard
- **UPDATE** `features/models.mdx` + `features/routing.mdx` — seat→topic mapping, bias warning UI
- **UPDATE** `features/evaluation.mdx` — black-box QA mode, contract-driven assertions
- **UPDATE** `getting-started/quick-start.mdx` — show the new `slice-first` and `tdd-cycle` templates as recommended starting points
- **UPDATE** `getting-started/configuration.mdx` — `MAX_AGENT_CONTEXT_TOKENS`, seat config

### 5.3 Landing page — `/home/patrice/docker-services/octipus-website/src/pages/index.astro`

Update positioning to lead with the principles (not just features). Sections to add/refresh:
- **Hero** — refine tagline to express the philosophy (e.g., "Swarm agents that don't lie to themselves" — adversarial validation as a headline differentiator)
- **NEW Section "How Octipus Thinks"** — six principles as visual cards (clean context, adversarial validation, tracer bullets, seat strategy, deterministic bookkeeping, validation contracts). Each card: 1 icon + 1-line claim + link to website doc.
- **NEW Section "The Octipus Workflow"** — Grill → PRD → Contract → Slice → Validate diagram (Pocock-style flow but Octipus-branded)
- **UPDATE** existing feature grid — add "Validation Contracts" and "Black-Box QA" tiles
- **UPDATE** comparison/capability table (if present) to highlight what these principles unlock vs. baseline agent frameworks

### 5.4 Phasing addition

Add **Phase F — Documentation & Website** (1–2 days), runs in parallel with each engineering phase:
- Each engineering phase ships with its corresponding repo doc update in the same PR (gate: PR rejected if no doc diff)
- Website docs + landing page updated in a single batch at the end of Phase E (one cohesive marketing release once feature set is stable)

### 5.5 Verification

- All six principles findable via grep in both `octipus/docs/` and `octipus-website/src/content/docs/`
- Landing page builds cleanly (`bun run build` in octipus-website)
- Docs site renders new pages under `/docs/features/swarm-philosophy` and `/docs/features/validation-contracts`
- Internal links validated (Astro build will fail on broken references)
- Screenshot review of landing page hero + "How Octipus Thinks" section before merge

---

## Final Path

On approval, promote this file to `/home/patrice/Github Rep/octipus/docs/plans/swarm-v2.md`.
