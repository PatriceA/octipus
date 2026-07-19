# Model Routing — Topic Primary, Backup & Executor

How a spawned agent ends up on a specific model, and what the three per-topic
model bindings (**primary**, **backup**, **executor**) each do. Companion to
[EXPERT-TOPIC-SKILL-ROUTING.md](EXPERT-TOPIC-SKILL-ROUTING.md) (which covers
how a request picks a role/topic/expert in the first place).

## The three bindings per topic

Every topic (lane) can bind up to three models:

| Binding | Where configured | What it is for | When it is used |
|---|---|---|---|
| **Primary** | Models page → topic assignment (`topicRoles` = `primary`) | The full-capability specialist model for this topic | Default for every agent spawned into the topic |
| **Backup** | Models page → topic assignment (`topicRoles` = `backup`) | Failure fallback | Only after the primary FAILS (provider/tool error) — one retry. Never chosen for cost or capability reasons |
| **Executor** | Topics page → `executorModel` (`topics_config` table) | Cheap model that runs pre-planned steps mechanically | Only when the spawning agent supplies a `plan` in `spawn_child` (planner→executor split, see below) |

All three are optional. An unbound topic **fails loud** at spawn time — there
is no silent default-model fallback for workers (only the orchestrator has a
default via `selectForOrchestration()`).

## Resolution order (per spawn)

Both spawn paths — direct workers (`worker-spawner.ts`) and swarm children
(`swarm/spawner.ts` → `resolveChildModelAndExpert`) — resolve in this order:

```
1. explicit override            (caller-pinned model, e.g. session override)
2. expert.modelPreference       (the matched expert's explicit choice — WINS
                                 over everything below, including the executor)
3. lane executorModel           ONLY if the spawn carried a `plan`
                                 (misconfigured/unregistered executor → loud error)
4. lane primary                 getModelForTopic(lane)
5. fail loud                    no inheritance of the parent's model
```

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

**Who plans: the specialist agent, not the orchestrator.** The orchestrator
routes requests to experts by topic, exactly as before — it does not know or
care about executors. The planner is the **topic/expert-bound agent** (depth
1): it has the domain context to break its own sub-work into mechanical steps
and hand them to `spawn_child` as a plan. Concretely:

```
Orchestrator          — routes by topic. No plans, no executor awareness.
   └─ Agent (expert)  — the PLANNER. For mechanical, fully-specified sub-work
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

- **Expert `modelPreference` shadows the executor.** If the matched expert
  pins a model, a planned child runs on that pin, not the executor (logged at
  info: `Planned child: expert modelPreference overrides the lane
  executorModel`). Clear the expert's model preference if you want the
  executor to win.
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
  - `Planned child: expert modelPreference overrides the lane executorModel`
- Per-model cost attribution in `cost_log` (`models/cost-tracker.ts`) shows
  the spend shift once planned children start landing on the executor.

## Source pointers

| Concern | File |
|---|---|
| Child model resolution (expert → executor → primary) | `src/core/swarm/spawner.ts` (`resolveChildModelAndExpert`) |
| Worker model resolution | `src/core/orchestrator/worker-spawner.ts` |
| `plan` schema + validation + delegation guidance | `src/core/swarm/swarm-tool.ts` |
| Executor binding storage/cache | `src/models/topic-config.ts` (`topics_config`) |
| Primary/backup topic bindings | `src/models/model-registry.ts` (`getModelForTopic`, `getBackupModelForTopic`) |
| Tool-capability reroute | `src/core/orchestrator/model-selector.ts` |
| Spawn metrics | `src/core/telemetry.ts` (`recordSwarmSpawn`) |
| Original design | `docs/plans/planner-executor-plan-split.md` |
