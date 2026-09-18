# Model Routing — Topic Primary, Backup & Executor

How a turn ends up on a specific model, and what the three per-lane bindings
(**primary**, **backup**, **executor**) each do. Companion to
[LANE-ROLE-SKILL-ROUTING.md](LANE-ROLE-SKILL-ROUTING.md) (which covers how a
request picks a role and a lane in the first place).

The lanes are `build`, `verify`, `everyday`, `research` and `background`, plus
the `ocr` / `vision` / `embedding` model classes. A lane exists if and only if
you would plausibly bind a DIFFERENT model to it — not because the subject is
different.

## The three bindings per topic

Every topic (lane) can bind up to three models:

| Binding | Where configured | What it is for | When it is used |
|---|---|---|---|
| **Primary** | Models page → topic assignment (`topicRoles` = `primary`) | The full-capability specialist model for this topic | Default for every agent spawned into the topic |
| **Backup** | Models page → topic assignment (`topicRoles` = `backup`) | Failure fallback | Only after the primary FAILS (provider/tool error) — one retry. Never chosen for cost or capability reasons |
| **Executor** | Topics page → `executorModel` (`topics_config` table) | Cheap model that runs pre-planned steps mechanically | Only when the spawning agent supplies a `plan` in `spawn_child` (planner→executor split, see below). A plan means the thinking is already done, so the steps do not need the lane's primary. |

All three are optional. An unbound lane **fails loud** at spawn time — there is
no silent default-model fallback for workers. A root turn is gentler: it falls
through to the default model rather than failing, so an install that never split
its lanes keeps working.

## Root-turn resolution

There is no single "the model that answers you". The request is classified to a
lane BEFORE the turn starts, so a coding brief and a lookup are answered by
different models on purpose:

```
1. session /model override       an explicit choice by the user — always wins
2. the routed lane's primary     selectLane(message) → getModelForTopic(lane)
3. the default model             when that lane is unbound
4. capability gate               reject/reroute no-tools, reasoning, or
                                 recently shim-dependent models
```

`selectLane` (`src/core/agent/lane-intent.ts`) takes the keyword classifier's
category when it has one and maps it through the lane aliases; failing that, a
message naming a file, a stack trace or a diff routes to `build`, and everything
else falls to `everyday`.

Routing happens before the turn on purpose. A model sent to the wrong TOOL
notices and calls `list_tools`; a model sent to the wrong LANE notices nothing —
a weak model does not stall on hard work, it produces something plausible and
finishes. Escalation catches a stall, not mediocrity, so the choice cannot be
deferred to the model that would be its victim.

## Resolution order (per spawn)

Both spawn paths — direct workers (`worker-spawner.ts`) and swarm children
(`swarm/spawner.ts` → `resolveChildModel`) — resolve in this order:

```
1. explicit override            (caller-pinned model, e.g. session override)
2. lane executorModel           ONLY if the spawn carried a `plan` AND the lane
                                 has an executor configured — a plan is the
                                 parent saying "the thinking is done, run these
                                 steps", and mechanical steps are what a cheap
                                 executor is for
3. lane primary                 getModelForTopic(lane)
4. fail loud                    no inheritance of the parent's model. The
                                 parent's model is whatever its own routing
                                 picked; inheriting hides routing bugs
```

The child's lane is the one the PARENT named in `spawn_child`'s `topic` when it
named a real one, else the child role's own (`coding` → build, `review`/`qa` →
verify, the conversational roles → everyday). The parent's request comes first
because it is the only way to say "not on my model" — a review child running on
the model that wrote the code is not a second opinion, which is the whole reason
the `verify` lane exists.

Two follow-up gates run after selection:

- **Capability reroute**: a child that is equipped with tools but whose bound
  model cannot call tools is rerouted to a tool-capable local (Ollama)
  fallback (`model-selector.ts` → `findToolCapableFallback`). Warn-and-proceed
  if none exists.
- **No cost clamp**: a child's bound model is authoritative even if it is more
  expensive than the parent's. Cost control is done via topic bindings and the
  executor, not silent downgrades.

## The planner→executor split

`spawn_child` accepts an optional `plan` — an ordered list of
`{action, tool?, expect?}` steps. The presence of a plan is the parent saying
*"I already did the thinking; run these steps mechanically"*, and it is what
routes the child to the topic's cheap `executorModel`. A plan-less child is a
judgment delegation and runs on the topic **primary**.

**Who plans: the specialist agent, not the root agent.** The root routes the
request to a lane — it does not know or care about executors. The planner is the
**depth-1 agent**: it has the domain context to break its own sub-work into
mechanical steps and hand them to `spawn_child` as a plan. Concretely:

```
Root agent          — routes the request to a lane. No plans, no executor awareness.
   └─ Agent          — the PLANNER. For mechanical, fully-specified sub-work
      (depth 1)         (run these searches, fetch these pages, apply these
                         edits) it passes a `plan`; the sub-task then runs on
                         the lane's cheap executor. Plan-less spawns are for
                         sub-work needing judgment.
         └─ Subagent  — the EXECUTOR. Runs the steps mechanically on the
            (depth 2)   lane executorModel. Cannot spawn further.
```

The agent learns this from two prompt surfaces (both depth-1 only):

- The static delegation guidance every spawn-capable agent gets
  (`buildDelegationGuidance`, `swarm/swarm-tool.ts`) — rule 5: mechanical +
  fully specified ⇒ pass a `plan`.
- The `EXECUTOR AVAILABLE` brief block (`composeChildMessage`,
  `swarm/spawner.ts`), injected only when the agent's lane actually binds an
  executor.

Notes and edge cases:

- **The split is only valid when the plan is genuinely mechanical.** If executing
  the plan still needs judgement, routing it to the cheap executor moves the
  thinking to the wrong model. A lane whose work always needs the capable model
  simply leaves `executorModel` empty — then planner and executor are the same.
- **Executor bound but never used** means agents aren't sending plans. This is
  now observable (below) instead of silent.
- **Unregistered executor name** fails loud — but only when a plan actually
  tries to use it. A typo can therefore sit dormant until the first planned
  spawn.
- **Empty `executorModel`** = planner and executor are the same model; planned
  children just run their steps on the primary.

## Backup (failure fallback) semantics

The backup binding is **retry-on-failure only** — it is consulted when the
child/worker ends in a provider or tool error after in-node retries:

- Swarm path: one retry on `getBackupModelForTopic(lane)` if a backup is bound
  and differs from the failed model (`swarm/spawner.ts`).
- Worker path: transient-error retry → topic backup; a CLI-provider failure
  can additionally fall back to the default model (`worker-spawner.ts`).

The backup is **not** a cost tier and is never selected proactively. Circuit
breaker and health checks (`models/circuit-breaker.ts`, `health-checker.ts`)
gate provider availability but do not pick fallbacks.

## Observability

- `octipus_swarm_spawns_total{role,depth,planned}` — the `planned` label shows
  whether the executor path is being exercised at all. `planned="false"` on
  every spawn in a lane with an executor bound = the split is configured but
  dead.
- Info logs in `swarm/spawner.ts`:
  - `Planned child routed to the lane executorModel (cheap executor path)`
  - `Plan-less child: skipping configured executorModel, resolving topic
    primary (recon path)`
- Per-model cost attribution in `cost_log` (`models/cost-tracker.ts`) shows
  the spend shift once planned children start landing on the executor.

## Source pointers

| Concern | File |
|---|---|
| Child model resolution (planned executor → lane primary) | `src/core/swarm/spawner.ts` (`resolveChildModel`) |
| Worker model resolution | `src/core/agent/worker-spawner.ts` |
| `plan` schema + validation + delegation guidance | `src/core/swarm/swarm-tool.ts` |
| Executor binding storage/cache | `src/models/topic-config.ts` (`topics_config`) |
| Primary/backup topic bindings | `src/models/model-registry.ts` (`getModelForTopic`, `getBackupModelForTopic`) |
| Tool-capability reroute | `src/core/agent/model-selector.ts` |
| Root task vs conversation selection | `src/core/agent/model-selector.ts`, `src/core/agent/root-runner.ts` |
| Spawn metrics | `src/core/telemetry.ts` (`recordSwarmSpawn`) |
| Original design | `docs/plans/planner-executor-plan-split.md` |
