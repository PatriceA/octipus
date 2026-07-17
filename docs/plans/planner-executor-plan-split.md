# Planner→Executor: explicit plan-driven delegation

## Goal

Make the big model actually *plan* before it hands work to a cheap executor,
instead of the current pipe-through where every child gets a free-form
`taskBrief` and figures out its own tool sequence. Inspired by CodeWhale's
task-spec + scorer model.

The rule that ties it together:

- **spawn *without* a plan → topic `primary`** — capable model, autonomous.
  For reconnaissance and judgment work (today's behaviour, unchanged).
- **spawn *with* a plan → topic `executorModel`** — small/cheap model, runs the
  ordered steps mechanically.

So the plan is the switch that *unlocks* the cheap executor. The small model can
only ever be reached by supplying a plan — it never gets a raw goal to reason
about. If no `executorModel` is bound, a plan is still honoured (steps rendered)
but runs on primary; nothing regresses.

## What already exists (do NOT rebuild)

- `TaskBrief` structured contract — `src/core/swarm/types.ts:128`
- Deterministic scorers (`non_empty`/`contains`/`regex`/`json`/`file_exists`) →
  `contract_failed` — `src/core/swarm/scorers.ts`, `swarm-tool.ts:405`
- Async spawn + `collect_children` + `parallelGroup` await — `swarm-tool.ts:346`
- Parent-driven re-dispatch loop (parent LLM re-spawns on `contract_failed`)
- Role → topic → primary/`executorModel` model binding — `spawner.ts:1161`

The "primary checks result, another round if needed" loop is therefore already
built. This work adds only the **step plan** and the **plan-gates-model** rule.

---

## Phase 1 — Data model: `plan` on the contract

**Files:** `src/core/swarm/types.ts`, `src/core/swarm/swarm-tool.ts`

- Add to `TaskBrief` and `SpawnChildParams`:
  ```ts
  plan?: Array<{
    action: string;   // "find every caller of resolveChildTools"
    tool?: string;    // named tool for this step (must be in the child's set)
    expect?: string;  // what this step should produce; feeds the next
  }>;
  ```
- Add `plan` to the **full** `spawn_child` schema (`swarm-tool.ts:340`) — optional,
  with a description telling the planner: "Provide an ordered plan ONLY when you
  have already done the thinking and want a cheap executor to run it
  mechanically. Omit it to delegate to a capable specialist that uses its own
  judgment (recon, investigation)."
- **Leave the lite schema untouched** (`swarm-tool.ts:313`). A small *planner*
  can't decompose anyway → it keeps `role`+`taskBrief`, routes to primary, no plan.
- Carry `plan` through brief assembly in `spawner.ts:156-193`.

**Check:** unit test — a `SpawnChildParams` with a 3-step plan round-trips into
`TaskBrief.plan`; one without leaves `plan` undefined.

## Phase 2 — Routing: plan presence picks the model

**File:** `src/core/swarm/spawner.ts` (`resolveChildModelAndExpert`, `1161-1180`)

- Gate the `executorModel` branch on `brief.plan?.length`:
  ```ts
  const executorName = brief.plan?.length ? getTopicConfig(lane).executorModel : undefined;
  ```
  No plan ⇒ branch skipped ⇒ falls through to `getModelForTopic(lane)` (primary).
- `expertModel` preference still wins over both (unchanged) — an explicit expert
  `modelPreference` is authoritative regardless of plan.
- Update the comment block at `1145-1153` to state the new rule.

**Note the ordering:** `resolveChildModelAndExpert` runs at `spawner.ts:357`,
*after* `childTools` is built at `:333`. `brief.plan` is available before both,
so no reordering needed — the plan is known when routing runs.

**Check:** test `resolveChildModelAndExpert` — lane with `executorModel` set:
plan present → executor model; plan absent → primary. Lane without
`executorModel`: both → primary.

## Phase 3 — Executor runs the plan mechanically

**File:** `src/core/swarm/spawner.ts` (`composeChildMessage`, `1317-1365`)

- When `brief.plan?.length`, render an ordered checklist in place of the
  "reason about which tools to use" framing:
  ```
  EXECUTE THIS PLAN IN ORDER. Do not deviate or add steps.
  1. <action>  [tool: <tool>]  → expect: <expect>
  2. ...
  If a step fails, STOP and report which step and why.
  ```
- When `plan` is absent, keep the current autonomous framing verbatim (recon path).

**Check:** snapshot/string test — plan present renders the numbered block and
drops the "check tools before spawning" prose; plan absent is byte-for-byte the
current message.

## Phase 4 — Validate plan tools against the executor's set

**File:** `src/core/swarm/spawner.ts` (after `childTools` at `:333` and model at `:357`)

- After both tools and model are resolved, drop/flag any `plan[].tool` not in
  `childTools`. Log at `info` (same style as the tool-intersection diagnostic at
  `:335`). Rendered plan shows the step but marks the tool unavailable so the
  executor reports cleanly instead of hallucinating a missing tool.
- ponytail: warn-and-strip, don't hard-fail — the executor can still narrate the
  step. Hard-fail only if *every* step names a missing tool (plan is unrunnable).

**Check:** test — plan naming a tool outside the intersected set is flagged in
the diagnostic and rendered as unavailable.

## Phase 5 (optional) — Semantic accept on `ok` results

**File:** parent synthesis path (`collect-tool.ts` / orchestrator turn)

- Scorers already gate mechanically → `contract_failed`. Since the parent *is*
  the big model, on an `ok` result it can also judge fit-for-goal before
  accepting, and re-plan (Phase 1-4 again with a corrected plan) if not.
- This is mostly prompt guidance to the parent ("after collecting, verify the
  result meets the original goal before answering; re-spawn with a revised plan
  if not"), not new machinery. Defer unless the deterministic scorers prove
  insufficient in practice.

---

## Two-phase flow this enables

```
planner (primary): spawn recon children (no plan)      → run on PRIMARY, autonomous
                   collect reports
                   write the step-plan (now informed)
                   spawn executor child (with plan)     → run on EXECUTOR, mechanical
                   collect → scorers verify
                   accept, or re-plan (another round)
```

## Scope / non-goals

- No workflow IR like CodeWhale's — octipus's parent LLM is already the sequencer
  (it decides spawn order across turns). We only move *per-child step
  decomposition* from the executor's head into the contract.
- No change to lite schema, small-planner path, or the scorer/receipt/ledger
  machinery.
- The small-model tool/prompt trim gap (worker-spawner has it, swarm spawner
  doesn't — see earlier finding) is **separate**; the plan makes it less urgent
  (a planned executor doesn't need to reason over a big tool surface) but doesn't
  close it. Track it independently.

## Risk

- Planner over-planning cheap recon into rigid steps → mitigated by the schema
  description (plan = "you already did the thinking", omit for judgment work).
- Plan too rigid for a step that surfaces a surprise → executor's "STOP and
  report which step" gives the parent a clean re-plan signal rather than a silent
  wrong result.
