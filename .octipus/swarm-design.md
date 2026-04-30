# Swarm Design — 3-Level Agent Hierarchy

**Status:** Phases 1–3 shipped 2026-04-20
**Scope:** 3 fixed levels (Orchestrator → Agent → Subagent). No cost-based routing. Existing expert system preserved.

## Conceptual Model

3 kinds. Depth ∈ {0,1,2}. Kind derived from depth. Not configurable.

| Kind | Depth | Spawned by | Can spawn? | Lifetime | UI |
|---|---|---|---|---|---|
| **Orchestrator** | 0 | `OrchestratorService.handleMessage()` | Yes → Agents | Per session | Root |
| **Agent** | 1 | Parent's `spawn_child` | Yes → Subagents | Ephemeral, per topic | Tree node |
| **Subagent** | 2 | Parent's `spawn_child` | **No** (leaf) | Ephemeral, per subtopic | Tree leaf |

**Roles:**
- Orchestrator: plans + delegates. No user-facing tool work except `filter_pii`, `request_user_approval`, `send_status_update`. Owns final answer. Reuse `getRoleConfig('orchestrator')` at `src/core/orchestrator/roles.ts:38`.
- Agent: topic specialist. Existing expert roles + restricted `spawn_child`. Produces topic deliverable.
- Subagent: sub-topic specialist. Same tools as Agent of its role **minus** `spawn_child`. Hard leaf.

**When Agent spawns Subagent:** brief contains sub-topic a different expert handles better. Decision = LLM tool call, not auto heuristic.

**Not a pipeline.** Pipelines (`pipeline-manager.ts`) = sequential. Swarm = topic-hierarchical fan-out. Both coexist.

## Spawn Mechanics

One tool: `spawn_child`. Registered at depth 0,1. Absent at depth 2. Parent awaits result. Multiple `spawn_child` per LLM turn allowed.

```ts
{
  name: 'spawn_child',
  final: false,
  description: 'Delegate a sub-topic to a better-fit specialist.',
  parameters: {
    type: 'object',
    properties: {
      expertId:   { type: 'string', description: 'Exact expert ID (preferred). Use list_experts if unsure.' },
      role:       { type: 'string', enum: [/* AgentRole minus "orchestrator" */] },
      topic:      { type: 'string' },
      subtopic:   { type: 'string' },
      taskBrief:  { type: 'string', maxLength: 4000 },
      expectedOutput: {
        type: 'object',
        properties: {
          shape:  { type: 'string', enum: ['summary','json','markdown','code-diff','list'] },
          schema: { type: 'object' },
          maxTokens: { type: 'number' },
        },
        required: ['shape'],
      },
      parallelGroup: { type: 'string', description: 'Same group in same turn = parallel via Promise.all' },
    },
    required: ['topic','subtopic','taskBrief','expectedOutput'],
  },
}
```

**Sync vs parallel:** default awaited sequential. Same `parallelGroup` same turn → `Promise.all`, merged tool-result. Fan-out cap: 4/node/turn default.

**Streaming:** children emit own `agent.event`s via `AgentManager.onEvent` (`agent-manager.ts:146`). Parent context gets final result only. UI streams all independently via gateway.

**Result schema:**
```ts
interface ChildResult {
  nodeId: string;
  kind: 'agent' | 'subagent';
  status: 'ok' | 'budget' | 'timeout' | 'tool_error' | 'provider_error' | 'cancelled' | 'denied' | 'concurrency_limit' | 'cache_hit';
  output: unknown;
  usedTokens: number;
  durationMs: number;
  spawnedChildren: string[];
  notes?: string;
}
```

Inserted into parent context as `<ChildResult ...><output>...</output></ChildResult>`. Oversize → `summarizeOutput` (`handoff.ts:244`) before insertion.

## Budget Envelope

Hard caps. Cascade. 3 dimensions.

```ts
interface NodeBudget {
  tokens:      { cap: number; used: number };
  wallClockMs: { cap: number; startedAt: number };
  fanOut:      { cap: number; used: number };
  depth:       0 | 1 | 2;
}
```

**Defaults (overridable):**

| Level | Tokens | Wall-clock | Fan-out |
|---|---|---|---|
| Orchestrator | 200k | 10 min | 6 |
| Agent | 80k | 4 min | 4 |
| Subagent | 30k | 90 s | 0 |

**Cascade:**
```
child.tokens.cap    = min(LEVEL_DEFAULT[child.depth].tokens, parent.remaining.tokens - RESERVE)
child.wallClock.cap = min(LEVEL_DEFAULT[child.depth].wallMs, parent.remaining.wall - RESERVE)
```
RESERVE ≈ 10% parent cap → headroom for parent synthesis after children return.

**Enforcement:** `AgentWorker.run()` loop (`agent-worker.ts:117`). Pre-LLM-call check. Breach → abort controller fires → `status='budget'|'timeout'` → descendants cancelled → `BudgetExceededError` → parent sees `ChildResult{status:'budget'}`. No soft retry. Parent LLM decides: respawn tighter or give up.

## Permission Inheritance

Rule: `child.allowedToolIds = parent.allowedToolIds ∩ requiredToolIds`. Never broader. Existing `PermissionManager.check()` (`src/security/permissions.ts:52`) stays authoritative for per-call ALLOW/ASK/DENY. Gate at **tool injection time**.

```ts
function resolveChildTools(parent: AgentNode, childRole: AgentRole): ToolHandler[] {
  const roleTools = getToolsForRole(childRole);                    // roles.ts:51
  const requiredIds = new Set(roleTools.map(t => t.toolId ?? t.name));
  const parentAllowed = parent.allowedToolIds;                      // Set<string>
  const granted = new Set([...requiredIds].filter(id => parentAllowed.has(id)));
  // child needs tool parent lacks → NOT granted. Child escalates via request_user_approval.
  return roleTools.filter(t => granted.has(t.toolId ?? t.name));
}
```

Orchestrator root `allowedToolIds` = role's `toolIds` at session start. Swarm ceiling.

**MCP tools:** `mcp_list_tools` / `mcp_call_tool` meta-tools inherit by same rule. Subagent can't discover MCP tool Agent parent lacked.

**`spawn_child`:** structural, not permission-gated. Granted at depth 0,1. Never at depth 2. Spawner enforces.

**No schema churn** on `toolPermissions`. Per-user table keeps working. Intersection-at-injection avoids new columns.

## Context Handoff

**Outbound (parent → child) — brief schema:**
```ts
interface TaskBrief {
  originalUserRequest: string;     // one line verbatim
  topicPath: string;                // "security / oauth / pkce"
  parentSummary: string;            // ≤500 tokens
  taskBrief: string;                // ≤2000 tokens
  constraints: string[];
  inputArtifacts: Array<{ kind: 'file'|'url'|'data'; ref: string; summary?: string }>;
  expectedOutput: { shape: 'summary'|'json'|'markdown'|'code-diff'|'list'; schema?: object; maxTokens: number };
  forbidden: string[];              // auto-set for Subagent: "Do not spawn children"
}
```

Becomes child user message. Child does NOT get: raw session transcript, sibling outputs (unless in `inputArtifacts`), parent scratchpad.

**Injection hardening:** `taskBrief` + `parentSummary` → existing `guardInput` (`src/core/orchestrator/input-guard.ts`) before becoming child user message. Poisoned upstream tool output can't smuggle instructions down. Child system prompt gets security reminder (`worker-spawner.ts:105`).

**Inbound (child → parent):** `ChildResult` above. Structured. Parent LLM decides how to fold into final answer.

**vs `HandoffContext`:** pipelines use regex extraction because loose coupling. Swarm contract is strict — `expectedOutput.shape` pins format. Can generate `HandoffContext` from `ChildResult` via `createHandoffContext` (`handoff.ts:119`) for UI display only. Not transport.

## Cycle / Loop Protection

**Depth ≤ 2 blocks deep recursion structurally.** Subagent can't spawn.

Remaining threats at depth 0,1:
1. User retrigger → Orchestrator respawns same Agent same brief
2. Agent spawns near-identical Subagent twice
3. Sibling Agents overlap Subagents

**Mechanism — fingerprint set rooted at `rootSessionId`:**
```ts
interface SwarmCallGraph {
  rootSessionId: string;
  startedAt: number;
  fingerprints: Set<string>;
  chain: Map<string, string[]>;   // nodeId → ancestors
}

function taskFingerprint(b: TaskBrief): string {
  return sha256(`${b.topicPath}|${normalize(b.taskBrief)}|${b.inputArtifacts.map(a=>a.ref).sort().join(',')}`);
}

// On spawn:
const fp = taskFingerprint(brief);
if (graph.fingerprints.has(fp)) throw new DuplicateSpawnError(`Subtopic already handled: ${brief.topicPath}`);
graph.fingerprints.add(fp);
```

Duplicate → parent LLM sees tool error: *"Subtopic X already handled by node n_abc. Use its result."* Parent synthesizes against in-flight result.

**Defense in depth:** spawner rejects if `brief.topicPath` appears in any ancestor's `topicPath`. Second guard.

Graph in memory on Orchestrator. GC on root completion.

## Failure Modes

Taxonomy (feeds upcoming Error Classification Enum):

| Failure | `status` | Parent recovery |
|---|---|---|
| Child LLM/provider error | `provider_error` | Retry once same node (`worker-spawner.ts:608` pattern). 2nd fail → user. |
| Child wall-clock timeout | `timeout` | Parent LLM decides: respawn tighter or skip. No auto. |
| Child token budget | `budget` | Same as timeout. |
| Child tool error (DENY/ASK-denied/throw) | `denied`/`tool_error` | No retry. Propagate as-is (`worker-spawner.ts:576`). User: "Couldn't complete `<subtopic>` because `<reason>`." |
| Cycle/duplicate | `cancelled` (+reason) | Wait on in-flight dup or synthesize without. |
| Child crash (exception) | `tool_error` | 1 retry on **new** node (fresh agentId, same brief). CLI fallback pattern `worker-spawner.ts:649`. |
| Ancestor cancelled | `cancelled` | Terminal. Parent also dead. |

**Escalation (Agent-only):** fan-out exhausted + all children returned `budget`/`timeout` → 1 `escalate_to_different_expert` call (different `expertId`, same role). Capped 1/Agent lifetime. Blocks thrashing.

**Enum contract:** first members = `BudgetExceededError`, `DuplicateSpawnError`, `CascadedCancellationError`, `ChildTimeoutError`, `PermissionDeniedError`. This doc stakes claim.

## Observability

**Gateway events** (new discriminators in `src/core/gateway/protocol.ts:40`):
```
swarm.node_spawned
swarm.node_completed
swarm.node_status
swarm.budget_warning
swarm.call_graph_cycle_blocked
```

`swarm.node_spawned` payload:
```ts
{
  rootSessionId: string;
  nodeId: string;
  parentNodeId: string | null;     // null = Orchestrator
  kind: 'orchestrator'|'agent'|'subagent';
  depth: 0|1|2;
  topicPath: string;
  role: AgentRole;
  expertId?: string;
  model: string;
  budgets: NodeBudget;
  taskBriefPreview: string;         // first 200 chars
}
```

UI subscribes `swarm.*` wildcard (existing `GatewayEventBus.subscribe` `matchesPattern`, `event-bus.ts:21`). Renders live tree per session. Per node: kind icon, role, expert, model, live token/fanout counters, status. Actions: cancel (cascade), view brief, view result, view events.

**Schema — new table `swarm_nodes`** (sibling to `agents`, not replacement; `agents` = historical record):

```ts
// src/db/schema/swarm-nodes.ts
import { pgTable, text, timestamp, uuid, jsonb, integer, pgEnum, index } from 'drizzle-orm/pg-core';

export const swarmNodeKindEnum = pgEnum('swarm_node_kind', ['orchestrator','agent','subagent']);
export const swarmNodeStatusEnum = pgEnum('swarm_node_status',
  ['running','completed','budget','timeout','denied','tool_error','provider_error','cancelled','concurrency_limit','cache_hit']);

export const swarmNodes = pgTable('swarm_nodes', {
  id:             text('id').primaryKey(),              // = agentId (1:1 w/ agents.id)
  rootSessionId:  uuid('root_session_id').notNull(),
  parentNodeId:   text('parent_node_id'),                // null for Orchestrator
  depth:          integer('depth').notNull(),
  kind:           swarmNodeKindEnum('kind').notNull(),
  role:           text('role').notNull(),
  expertId:       uuid('expert_id'),
  topicPath:      text('topic_path').notNull(),
  subtopic:       text('subtopic'),
  model:          text('model').notNull(),
  status:         swarmNodeStatusEnum('status').notNull().default('running'),
  tokenCap:       integer('token_cap').notNull(),
  tokensUsed:     integer('tokens_used').notNull().default(0),
  wallClockCapMs: integer('wall_clock_cap_ms').notNull(),
  fanOutCap:      integer('fan_out_cap').notNull(),
  fanOutUsed:     integer('fan_out_used').notNull().default(0),
  briefHash:      text('brief_hash').notNull(),
  cacheHits:      integer('cache_hits').notNull().default(0),
  result:         jsonb('result').$type<ChildResult | null>(),
  error:          text('error'),
  createdAt:      timestamp('created_at').defaultNow().notNull(),
  completedAt:    timestamp('completed_at'),
}, (t) => ({
  rootIdx:   index('swarm_nodes_root_idx').on(t.rootSessionId),
  parentIdx: index('swarm_nodes_parent_idx').on(t.parentNodeId),
  statusIdx: index('swarm_nodes_status_idx').on(t.status),
}));
```

**Events reuse:** existing `agent_events` table keyed on `agentId`. UI joins `swarm_nodes` (tree) + `agent_events` (per-node stream).

## Cancellation

Require: user cancel root → descendants die. Parent die → orphans die.

**Mechanism:** `AbortSignal` tree rooted at Orchestrator.

```ts
const child = new AbortController();
parent.signal.addEventListener('abort', () => child.abort(parent.signal.reason), { once: true });
```

`AgentWorker.abortController` (`agent-worker.ts:55`) already checks `signal.aborted` in loop (line 267), fires on `stop()` (line 782). Extension: inject parent signal at child `AgentWorker` construction.

`AgentManager.stop(agentId)` (`agent-manager.ts:248`) extended: `{ cascade: boolean }`. `cascade: true` (default for swarm):
1. Abort own controller
2. Query `swarm_nodes WHERE parentNodeId = :id` recursively
3. `.stop()` each descendant (same `AgentManager.agents` map)

**User-facing:** gateway `agent.stop` (`protocol.ts:137`) → `AgentManager.stop(id, {cascade:true})` when `swarm_nodes.depth === 0`. Non-root: UI per-node cancel, cascades node-down.

**Orphan reaper:** on process restart, mark `swarm_nodes` `status='running'` older than 10 min → `cancelled` + `error='orphaned_at_restart'`. Mirrors `agent-manager.ts:256`.

## Prompt Routing

Options considered:

| Option | Pro | Con | Verdict |
|---|---|---|---|
| Keyword match pre-LLM | Fast, cheap | Brittle; dupes classifier; bypass parent LLM | Reject |
| Always delegate by expert-score | Zero LLM overhead | Kills "parent synthesizes"; can't skip when not needed | Reject |
| **Explicit `spawn_child` tool call** | Matches existing pattern (`spawn_worker`/`spawn_team`); auditable; parallel composable | Tokens in parent turn | **PICK** |

Existing codebase bets on tool-call delegation (`meta-tools.ts:27,105`). Swarm = that pattern + 1 level.

**Agent system prompt gets:**
```
# Delegation Guidance (Agent at depth 1)

You are a <role> specialist. Your task may contain sub-topics where a
different specialist would do better. Delegate when:

- Sub-topic matches another expert's role cleanly (e.g. you're a
  coding expert but task needs security audit).
- Sub-topic can be answered in isolation with a narrow brief.
- Parallel work on independent sub-topics reduces wall-clock.

DO NOT delegate when:
- You can answer from your domain directly.
- Sub-topic is trivial.
- You've already delegated; prefer synthesizing over cascading.

To delegate: call `spawn_child` with topic, subtopic, focused taskBrief.
Multiple calls in one turn allowed (parallel, same parallelGroup).
After children return, synthesize and produce deliverable.
```

**Non-authoritative hint:** companion tool `list_experts_by_topic(topic)` exposes available expertIds. Reuses `experts` table. Avoids guessing.

## Data Model / Schema Changes

**New:** `src/db/schema/swarm-nodes.ts` (see schema above).

**Modified — `src/db/schema/agents.ts`**, 2 nullable columns:
```ts
parentAgentId: text('parent_agent_id'),     // FK agents.id, nullable
swarmNodeId:   text('swarm_node_id'),       // FK swarm_nodes.id, nullable — = agents.id in practice
```
Back-compat: both nullable. Non-swarm agents unaffected.

**No changes:** `experts`, `permissions`, `permission_requests`, `pipelines`, `pipeline_stages`. Sessions get optional `rootSwarmNodeId` in `SessionContext` (`db/schema/sessions.ts:33`) for UI hydration.

**Drizzle migration:** 2 new enums, 1 new table, 2 nullable cols on `agents`. Low risk.

## Incremental Rollout

### Phase 1 — Orchestrator → Agent only, no Subagents

Smallest useful slice.

- New module `src/core/swarm/`:
  - `swarm-spawner.ts` — wraps `AgentManager.spawn`; budget, `parentAgentId`, AbortSignal chain, permission intersection
  - `call-graph.ts` — in-memory fingerprint set per session
  - `swarm-tool.ts` — `spawn_child` ToolHandler. Not registered on depth 1 children in Phase 1.
- New DB table `swarm_nodes`. `agents.parentAgentId` added (nullable).
- Orchestrator `meta-tools.ts` gets `spawn_child` alongside `spawn_worker`/`spawn_team`/`create_pipeline`. System prompt adds "prefer `spawn_child` for single-role delegation with structured output." `delegationDone` guard loosened — `spawn_child` not `final`, multiple allowed per run.
- Gateway `swarm.node_spawned`/`node_completed` emitted. UI: minimal list in session sidebar.
- No cancel cascade beyond existing `stopSession`. No cycle protection (1 level).
- Budgets enforced at Agent (depth 1) only.

**Ship criterion:** "research X, then summarize" → Orchestrator spawns research Agent via `spawn_child`, receives structured output, synthesizes, responds. Existing features unbroken.

### Phase 2 — Level-3 Subagents

- `spawn_child` registered on Agents. Depth-2 enforcement in `SwarmSpawner`. Subagent gets no `spawn_child`.
- Full budget cascade, wall-clock + fan-out all 3 levels.
- Cycle protection (fingerprint set) active.
- AbortSignal tree top-to-bottom. `AgentManager.stop({cascade})` impl.
- Failure taxonomy via `ChildResult.status`. Retry + escalate logic.
- Parallel `spawn_child` via `parallelGroup`.

**Ship criterion:** "audit project security" → Orchestrator → security Agent → [oauth, xss, secrets] Subagents parallel → Agent synthesizes → Orchestrator finalizes.

### Phase 3 — Full UI, production polish

- Web live swarm tree (new component). Per-node cancel, token/time bars, model/expert badges.
- Replay buffer `swarm.*` via `GatewayEventBus.getReplay`.
- Orphan reaper on process start.
- Per-user fan-out caps (tie to `src/security/rate-limiter.ts`).
- Docs + ROADMAP.

## Risks / Open Questions

**Risks:**
1. **Runaway spend.** 3 nested LLMs/subtopic. Mitigation: strict cascade + RESERVE; conservative defaults; live counters in UI. Document in release notes.
2. **Context explosion at parent.** 4 children × 30k tokens → parent overflow. Mitigation: `expectedOutput.maxTokens` enforced child-side; `summarizeOutput` before re-insertion.
3. **UX confusion — "who answered?"** Orchestrator always composes final user-facing reply. Tree = side panel not inline. Optional citation: "Compiled from security + coding specialists" when >1 child contributed.
4. **Prompt injection via child brief.** Compromised upstream tool output poisons `taskBrief`. Mitigation: `guardInput` on way down; security reminder in child system prompt.
5. **Deadlocks fan-out × timeout.** Parent awaits 4; 1 hangs; parent wall-clock expires mid-await. Mitigation: parent AbortSignal cascades to in-flight children; parent returns partial synthesis.
6. **Model mixing surprises.** User picked small model for "research" topic; research Agent spawns "security" Subagent → larger model. **See open Q1.**
7. **Drizzle migration prod risk.** New table safe, nullable cols safe. Downtime only if enum creation slow on large PG.

**Resolved decisions (user ruling, 2026-04-19):**

1. **Model ceiling → cap child at parent tier.** Child expert's `modelPreference` clamped to parent's model tier at spawn time. If expert would pick stronger model, spawner downgrades + logs. Preserves "user picks per topic" invariant. Trades some capability for predictability + cost control. **Impl:** `resolveChildModel(parent, childExpert)` compares model tiers via model-registry capability table; picks `min(parentTier, childExpert.preferred)`.
2. **`spawn_child` replaces `spawn_worker` + `spawn_team`.** Clean break. Required work:
   - Deprecate old meta-tools in `src/core/orchestrator/meta-tools.ts`.
   - Recheck all call sites of `spawn_worker`/`spawn_team`; migrate.
   - **Big test coverage** for new swarm path (unit + integration).
   - **Extensive E2E** — multi-level spawn, cancellation cascade, budget breach, cycle detection, permission intersection.
   - `create_pipeline` retained (see #5).
3. **Each swarm node counts against concurrency limit.** `config.agent.maxConcurrentAgents` (`agent-manager.ts:76`) applies per node. Spawner pre-checks before fan-out. `AgentManager.spawn` already rate-gates — reuse. If limit hit mid-spawn → queue or fail with `concurrency_limit` status (add to `ChildResult.status` enum).
4. **Subagent result cache enabled.** `swarm_nodes.result` jsonb is cache surface. Keyed by `briefHash`, scoped to `rootSessionId`. Pre-spawn lookup: if completed node exists with same `briefHash` + `status='ok'` → return cached `ChildResult` directly, skip spawn. Invalidation: session end (rows archived to history). **Add column:** `cacheHits: integer` for observability.
5. **Pipelines Orchestrator-only.** Agents cannot call `create_pipeline`. Orchestrator system prompt explicitly lists options in priority order:
   ```
   Delegation options, in order of preference:
   1. Single agent (`spawn_child`) — default; simplest; covers most tasks.
   2. Swarm (multiple `spawn_child` calls, parallel or sequential) —
      when task has distinct sub-topics.
   3. Pipeline (`create_pipeline`) — last resort; only when user
      explicitly asks for staged/reviewable handover OR task requires
      human gate between stages.
   Prefer (1) over (2); prefer (2) over (3).
   ```
6. **Event log: terminal kept, interior summarized.** Per-node event stream retention:
   - Terminal events (`completed`, `failed`, `cancelled`, tool-result, final answer): **full retention**.
   - Interior events (per-iteration thoughts, intermediate observations): **summarize** on node completion via existing `summarizeOutput` (`handoff.ts:244`), store single rollup event, drop raw stream.
   - UI live view unaffected — summarization happens at completion, live events stream from buffer in memory.
   - **Impl:** `AgentManager.onComplete(nodeId)` hook → summarize → batch-insert rollup → delete interior rows.

## Not Doing (Explicit Non-Goals)

- **Deeper than 3 levels.** Hard-coded. Future need = separate design.
- **Cost-based auto-routing.** Router topic → model mapping stays. User picks model per topic.
- **Skill auto-learning.** Skills stay statically assigned via topic/role. Separate workstream.
- **Trajectory learning / RL on swarm traces.** Separate workstream. Store tree + per-node events only.
- **Replace pipelines.** `pipeline-manager.ts`, `pipelines` table, `create_pipeline` untouched. Pipelines = explicit staged handover; swarm = topic-hierarchical fan-out.
- **Cross-user / cross-session swarm.** Every swarm rooted in one session, one user. No shared children.
- **Mid-swarm user steering.** `OrchestratorService.steer` (`service.ts:590`) targets root only. Steering Subagent mid-run = later.

## Critical Files for Implementation

- `src/core/orchestrator/service.ts` — root entry; Orchestrator lifecycle; where `spawn_child` tool registers alongside existing meta-tools.
- `src/core/orchestrator/worker-spawner.ts` — existing spawn-and-await (`spawnWorker`, `spawnTeam`). Swarm spawner derives from this; shares retry/permission/notification plumbing.
- `src/core/agent-manager.ts` — `spawn()`/`stop()`/event buffer. Extend: `parentAgentId`, cascade cancel, `AbortSignal` chain.
- `src/core/agent-worker.ts` — iteration loop, token accounting, abort checks. Extend: hard per-node budget enforcement.
- `src/db/schema/swarm-nodes.ts` — **new** file. Live tree table (schema above). Drives UI + cycle protection.

## Phase 2 — Implementation Notes

**Shipped 2026-04-19.** The Level-3 subagent slice, full budget cascade, cycle protection, cascade cancel, escalation, and parallel `parallelGroup` fan-out are all live. No schema changes required — `swarm_nodes` already had every column Phase 2 needed.

### New files

- `src/core/swarm/call-graph.ts` — `SwarmCallGraph` class + per-`rootSessionId` registry. Owns `taskFingerprint` (moved from `spawner.ts`; `spawner.ts` re-exports for back-compat). GC via `releaseCallGraph(rootSessionId)`. In-memory only — not persisted.
- `src/core/swarm/errors.ts` — `BudgetExceededError`, `ChildTimeoutError`, `DuplicateSpawnError`, `CascadedCancellationError`. Each extends `ClassifiedError` with a pre-filled `FailoverReason`. `classifyChildError()` maps thrown errors to `ChildResult.status` covering all 9 states (`ok`, `budget`, `timeout`, `denied`, `tool_error`, `provider_error`, `cancelled`, `concurrency_limit`, `cache_hit`).
- `src/core/swarm/escalate-tool.ts` — `createEscalateTool(parent, spawner)` factory. Thin wrapper over `spawn_child` that (a) reserves the one-per-Agent escalation slot on the call graph, (b) forces a *different* expertId via `excludeExpertId` on the spawner, (c) returns `<ChildResult>` via `formatChildResult`. Registered on depth-1 Agent children only.

### Modified files

- `src/core/swarm/spawner.ts` — rewritten. Depth enforcement is now `parent.depth >= 2 ⇒ denied` (hard leaf). Fan-out cap enforced pre-cache-lookup against `parent.budget.fanOut`. Call-graph integration: `graph.checkSpawn(parentId, brief)` before spawn; on `DuplicateSpawnError`, returns `status: 'cancelled'` with `parentNotice` as `notes` and publishes `swarm.call_graph_cycle_blocked`. Retry taxonomy: inside `singleSpawnAndRun`, a `provider_error` triggers *one* retry on the same worker (`worker.run()` re-invoked); `runChildWithRetry` wraps one more attempt on a *new* node if the inner attempt returned `tool_error`. Other statuses surface as-is. `AgentNode` for Agent (depth 1) children is built before spawn and mutated post-spawn to carry the real `childId` — `spawn_child` + `escalate_to_different_expert` are registered as meta-tools alongside the role tools on depth-1 workers. Model resolution now accepts `excludeExpertId` used by escalation.
- `src/core/swarm/swarm-tool.ts` — unchanged API. Registration happens via the spawner when a depth-1 child is created (the orchestrator still registers its own via `createMetaTools({parentNode})` as in Phase 1).
- `src/core/swarm/index.ts` — re-exports call-graph, errors, and escalate-tool modules.
- `src/core/agent-worker.ts` — constructor now accepts `{ parentSignal?: AbortSignal }`. Parent's abort cascades into the worker's own `AbortController` via a `once` listener (cleaned up by `stop()`). Iteration loop's pre-LLM-call check throws structured errors: `CascadedCancellationError` on abort (was string `Error`), `BudgetExceededError` on token cap, `ChildTimeoutError` on wall-clock cap. The abort fires before the throw so in-flight tool calls also bail. Integration points: iteration guard `loop()` at the top of each iteration (line numbers shift with edits — look for the `if (this.abortController.signal.aborted)` / `if (this.config.maxTokenBudget > 0 && this.totalTokensUsed >= this.config.maxTokenBudget)` / wall-clock checks at the head of the `while` loop; these are the Phase 2 enforcement points).
- `src/core/agent-manager.ts` — `SpawnOptions` gained `parentSignal?: AbortSignal` + `parentAgentId?: string`. In-memory `childrenByParent: Map<string, Set<string>>` index populated on every spawn. `stop(id, {cascade:true})` walks the index recursively (sync — stops each in-memory worker) *and* fires a background DB walk `cascadeStopFromDb(rootAgentId)` so zombie descendants whose workers were evicted still get their `swarm_nodes.status` flipped to `cancelled`. `remove()` now scrubs the children index.
- `src/core/tool-executor.ts` — `handleToolCalls` pre-scans for `spawn_child` calls sharing a non-empty `parallelGroup`. Groups with 2+ members run via `Promise.all`; overflow beyond the default fan-out cap (4/turn) is short-circuited with a synthesized `<ChildResult status="concurrency_limit">` envelope. Singleton groups flow through the normal sequential path unchanged. The spawner's own per-node `budget.fanOut` cap is still authoritative — the executor cap is only the per-turn safety net.
- `src/core/orchestrator/meta-tools.ts` — unchanged (the Phase-1 `options.parentNode` already wires `spawn_child` on the Orchestrator; the spawner handles depth-1 registration internally, so no further changes here).
- `src/core/gateway/protocol.ts` — added event types: `swarm.node_status`, `swarm.budget_warning`, `swarm.call_graph_cycle_blocked`.

### Scope deviations

- **Budget enforcement location.** The design says "Enforcement: `AgentWorker.run()` loop". We implement it in the private `loop()` method at the head of each iteration (three pre-LLM-call checks) — semantically identical to the design, just clarifying the precise hook.
- **`parentSignal` at construction vs. injection.** Design said "inject parent signal at child `AgentWorker` construction" — implemented exactly via the 3rd constructor arg. CLIAgentWorker is *not* yet signal-chained (its abort path is process-kill); tracked for a follow-up.
- **Escalation slot reservation.** Design didn't specify whether a failed escalation releases the slot; we keep it **claimed** (design intent: "Blocks thrashing"). A failed escalation still counts toward the 1/lifetime cap.
- **Cycle protection side-effect.** When a spawned child fails (`status != 'ok' && status != 'cache_hit'`), the spawner calls `graph.unregisterFingerprint(childId)` so the parent LLM may respawn with a refined brief. Dedup only protects live/successful work, not zombie failures.
- **Depth-1 meta-tool wiring.** The `AgentNode` for depth-1 children is built *before* `AgentManager.spawn` returns with a placeholder id, then mutated to carry the real `childId` once known. This mirrors the existing orchestrator pattern in `service.ts:393`.

### Fan-out × budget interaction

- **Per-node fan-out cap (`parent.budget.fanOut.cap`)** is enforced synchronously in `SwarmSpawner.spawnChild` *before* concurrency / cache / budget math. When hit, the spawner returns a `concurrency_limit` result without incrementing `used`. When not hit, it reserves the slot (`parent.budget.fanOut.used++`) up front so truly-parallel spawns inside a `Promise.all` don't race past the cap.
- **Per-turn parallel cap (4)** in `ToolExecutor.executeParallelSwarmGroups` is the secondary guard: even if a parent's per-node cap is 6, a single LLM turn can only `Promise.all` 4 children in the same `parallelGroup`. Overflow turns into synthetic `concurrency_limit` results, which the parent LLM can see and either re-spawn on the next turn (if `budget.fanOut` allows) or synthesize without.
- **Budget cascade interaction.** The token/wall-clock caps on each child are computed from the parent's *remaining* capacity minus RESERVE. Parallel children therefore divide the parent's remaining budget among themselves; a 4-way fan-out after heavy parent use may yield surprisingly-small child caps. Documented in the parent prompt via `expectedOutput.maxTokens` enforcement. If all parallel children return `budget`, the Agent should escalate (one per lifetime) rather than respawn narrower — respawning thrashes.
- **Cancellation semantics.** Cancel on the root fires its `AbortController`, which propagates through each child's `parentSignal` chain into `AgentWorker.abortController`. The next iteration sees `signal.aborted` and throws `CascadedCancellationError`. In-flight `raceTimeout` promises are not signal-aware and rely on their setTimeout to expire — but the loop's next-iteration check catches the abort before the next LLM call. `AgentManager.stop(id, {cascade:true})` runs the sync child-walk first (fast, deterministic) then the DB walk (catches cross-process zombies).

### Test coverage delta

| File | Tests | Purpose |
|---|---|---|
| `call-graph.test.ts` | **+12** (new) | `taskFingerprint` moved; fingerprint dedup; ancestor-chain rejection (including self-parent collision); escalation cap; registry/GC; fingerprint release on failure path |
| `budget-enforcement.test.ts` | **+5** (new) | Pre-LLM-call `BudgetExceededError`; parent-signal chain → `CascadedCancellationError`; wall-clock pre-check → `ChildTimeoutError`; `classifyChildError` taxonomy mapping |
| `cascade-cancel.test.ts` | **+5** (new) | `AgentManager.stop({cascade})` walks in-memory `childrenByParent`; non-cascade stops only target; `AgentWorker` constructor signal chain (live + pre-aborted parent) |
| `spawner.test.ts` | **+6** (extended) | Depth-2 denial (hard leaf); fan-out cap rejection; duplicate-fingerprint cancelled result; escalate cap (1/lifetime); parallelGroup bucketing logic |
| **Total** | **+31 new tests** (28 → 59 pass; 0 fail) | Covers the 7-status taxonomy, depth enforcement, cycle protection, budget/timeout errors, cascade cancel, escalation, parallel fan-out |

**Full-suite:** 855 pass / 62 skip / 0 fail across 917 tests in 64 files (`bun test`).

### Remaining work (Phase 3 owned)

- Orphan reaper on process start.
- Per-user fan-out caps via `rate-limiter.ts`.
- Full web UI swarm tree component, per-node cancel actions, budget bars.
- `swarm.budget_warning` emission at 80% cap (event type is added; emission not yet wired).
- `CLIAgentWorker` parent-signal chain (Phase 2 only wires `AgentWorker`).

## Implementation Notes (2026-04-20) — deviations from design

Phase 3 shipped alongside Phase 1 + 2 core. The following deviations and refinements are load-bearing and should be treated as the authoritative behaviour when design vs. code disagree.

- **Same-role spawn refusal.** The spawner rejects `spawn_child` when the child's resolved `role` equals the parent's role (returns `cancelled` with `notes: 'same role — synthesize locally'`). The design didn't explicitly forbid this, but allowing it degenerates into a respawn loop when a role runs out of ideas. Escalation (different expert, same role) is the exception — that goes through `escalate_to_different_expert`, which sets an `excludeExpertId` so the spawner picks a different expert.
- **Tool intersection fix.** The root Orchestrator's `allowedToolIds` is now computed as the **union** of every role's `toolIds` (not just the orchestrator role's). Without this, child intersection (`parent.allowedToolIds ∩ childRole.toolIds`) yielded an empty set and children spawned tool-less. Design §Permission Inheritance said "intersection"; it works because the ceiling is the union of everything any role could legitimately ask for.
- **Topic-binding priority for model resolution.** Design §Prompt Routing implied model picked from expert preference capped by parent tier. Actual order inside `resolveChildModelAndExpert`: (1) expert `modelPreference` if set, (2) `ModelRegistry.getModelForTopic(childRole)`, (3) throw — no silent default-model fallback. The "no tier clamp" decision: topic bindings and explicit expert preferences are authoritative; cost control lives in the Models page, not in spawner downgrades. Children inherit topic bindings, **not** the parent's model — this fixed a real bug where child topics silently used the orchestrator's model.
- **`pausedMs` wall-clock clock.** Design §Budget Envelope table shows fixed per-depth wall caps. The subtle point: `AgentWorker` tracks `pausedMs` and subtracts it from `elapsed()` so the parent's wall cap excludes time spent awaiting children. Subagent wall cap was therefore raised to 4 min (same as Agent) instead of the originally-proposed 90s — waiting inherits, it doesn't compress. Token pool still cascades normally.
- **`SECURITY_PREAMBLE` deduplication.** Expert prompts previously sometimes re-prepended the preamble, giving workers two copies. `stripSecurityPreamble` now runs on expert/system prompt composition so the preamble appears exactly once at the top.
- **`send_status_update` loop protection.** Tool executor terminates a tool when `progress: 100` is sent; `AgentWorker` has a same-tool-name repeat guard; orchestrator falls back to `lastStatusMessage` when a worker returns empty output. None of these are swarm-specific but they matter for deep trees where each node emits progress.
- **Fail-loud migration.** Silent `catch` blocks were removed on the KB embedding path (`src/core/rag/embeddings.ts`, `src/core/rag/health.ts`), all model providers, the scheduler date bug, and skill loading (loud error when an expert lists a `skillId` that doesn't exist in the `skills` table). The swarm spawner inherits: a misconfigured role/topic now throws instead of silently picking a default model.
- **Error classification enum.** `src/core/errors/classification.ts` supplies `FailoverReason`, `RecoveryAction`, and `classifyError()`. Every provider maps errors through it; the swarm `classifyChildError` in `errors.ts` layers on top to map thrown errors into `ChildResult.status`.
- **Orchestrator loses `spawn_worker` / `spawn_team` on the LLM surface.** The worker-spawner internals survive for pipeline stages (non-LLM, sequential). The orchestrator LLM sees `spawn_child` (plus `escalate_to_different_expert` on depth-1 Agents) and nothing else. `create_pipeline` is unchanged.
- **Gateway events.** Final event set (`src/core/gateway/protocol.ts`): `swarm.node_spawned`, `swarm.node_completed`, `swarm.node_status`, `swarm.budget_warning`, `swarm.call_graph_cycle_blocked`. Replay buffer is `swarm.*`-aware; UI rehydrates via `/api/swarm/nodes?rootSessionId=…` if the replay buffer aged out.
- **Config knobs.** `config.swarm.perUserSpawnsPerMinute` (default 30) and `config.swarm.orphanReaperIntervalMs` (default 600_000) landed in `src/config/defaults.ts`.
