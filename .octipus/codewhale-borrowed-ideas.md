# Design Note — Three ideas borrowed from CodeWhale

**Status:** Proposal (not yet scheduled)
**Source:** Analysis of [Hmbown/CodeWhale](https://github.com/Hmbown/CodeWhale), a
Rust terminal coding agent with the same Orchestrator→worker shape as our swarm,
but a much stronger emphasis on **durability** and **auditability**.
**Scope:** Three concrete additions to `src/core/swarm/` and `src/core/trajectories/`.
Everything else CodeWhale does (local-first single-user, sandboxing, RouteResolver)
either doesn't fit our Channels→Gateway model or duplicates what we already have
(`ModelRegistry.getModelForTopic`). We are deliberately taking only three things.

These reinforce house rules we already hold — #1 (fail loud) and #4 (typed
contracts at handoffs) — rather than introducing new philosophy.

---

## 1. Deterministic receipts for worker handoffs

### What CodeWhale does
A "receipt" is a read-only audit of one completed turn, built **only** from
durable runtime records — never from the model's own prose summary. It records
*side-effect boundaries*: counts of approvals required/allowed/denied, commands
executed, files changed, sandbox denials, plus the event-sequence range. The
discipline that makes it trustworthy: **missing evidence is marked explicitly,
never inferred**, and the receipt states what it does *not* certify.

### Why we want it
Today a child returns a `ChildResult` (`src/core/swarm/types.ts:143`) whose
`output` and `notes` are model-authored. The orchestrator trusts the child's
self-report. A receipt is the deterministic counterpart: what the child's tool
calls *actually did*, assembled by the framework from real execution records, not
the LLM. This is house-rule #1 (fail loud) turned into an artifact — a parent can
detect "child claims success but wrote no files / had 3 denied tool calls" without
re-reading a transcript.

We already record the raw material: the trajectory recorder
(`src/core/trajectories/recorder.ts`) sees every `tool_call`, `spawn`, and
`llm_call` step per run. A receipt is a deterministic *reduction* of those steps
scoped to a single swarm node, not new instrumentation.

### Sketch
```ts
// src/core/swarm/receipt.ts
export interface SwarmReceipt {
  nodeId: string;
  kind: 'agent' | 'subagent';
  status: ChildResultStatus;          // reuse existing union
  sideEffects: {
    toolCalls: number;
    filesWritten: number;             // from fs-tool execution records
    commandsRun: number;              // from shell-tool execution records
    approvalsRequired: number;
    approvalsDenied: number;
    permissionDenials: number;        // tool-executor denials
  };
  tokens: { used: number; cap: number };
  durationMs: number;
  // Explicit "we don't know" rather than implying zero:
  unavailable: string[];              // e.g. ["filesWritten: fs records not captured"]
  // Honest about scope, like CodeWhale's claim ceilings:
  notCertified: ['correctness', 'security'];
}
```
- **Built by the framework**, fed by the tool-executor / trajectory steps —
  never populated by the child model.
- Returned alongside `ChildResult` (add `receipt?: SwarmReceipt`), persisted on
  the `swarm_nodes` row (jsonb, next to `result`).
- A counter that can't be derived from real records is pushed to `unavailable`,
  not defaulted to `0`. This is the rule that keeps it honest.

### Effort
Small–medium. New file + one field on `ChildResult` + one jsonb column. No
orchestration rewrite — it's a passive reduction over data we already collect.

---

## 2. Append-only, resumable swarm ledger

### What CodeWhale does
Fleet is "a local-first control plane for durable multi-worker orchestration."
Every state change is a typed event appended to `.codewhale/fleet.jsonl`. After a
crash / sleep / restart, `fleet resume <run-id>` **replays the ledger, reconciles
stale workers, and retries within budget** — and resume is **idempotent**
(launches no new work). One durable primitive backs both sub-agents and fleet
workers.

### Why we want it
Our swarm state lives in the `swarm_nodes` table (`node-repository.ts`) as
*current state* — we can see a node is `running`, but if the process dies
mid-fan-out we have no append-only history to replay and reconcile against. The
`orphan-reaper` cleans up stragglers but can't *resume* intent. For long
multi-agent runs (research, the deep-research harness) a restart loses in-flight
work silently — which violates fail-loud.

### Sketch
Add an append-only event log keyed by `rootSessionId`, written on every node
state transition the spawner already makes:
```ts
// src/core/swarm/ledger.ts
export type SwarmLedgerEvent =
  | { t: 'spawn';     nodeId: string; parentId: string|null; brief: TaskBrief; at: string }
  | { t: 'status';    nodeId: string; status: SwarmNodeStatus; at: string }
  | { t: 'result';    nodeId: string; result: ChildResult; at: string }
  | { t: 'cancel';    nodeId: string; reason: string; at: string };
```
- Storage: append-only. Either a `swarm_ledger` table (one row per event,
  indexed by `rootSessionId`) or a JSONL file alongside trajectories — table is
  the better fit since we're already Postgres-backed and want it queryable.
- `resumeSwarm(rootSessionId)`: replay events → rebuild the node tree → mark any
  `running` node with no terminal event as stale → reconcile (re-spawn within
  remaining budget, or fail it loud). **Idempotent**: replay alone spawns
  nothing; reconciliation is an explicit, budget-gated second pass.
- Reuse existing budget envelopes (`NodeBudget`) so a resume can never exceed the
  original token/wall caps.

### Effort
Medium. The write path is cheap (hook the spawner's existing transitions). The
value is all in `resumeSwarm` + reconciliation, which needs care around budget
accounting and the orphan-reaper boundary (reaper kills; resume revives — they
must not fight). Worth a focused design pass before coding.

---

## 3. Scorer gates on typed deliverables

### What CodeWhale does
Fleet tasks carry a typed receipt (`pass` / `fail` / `partial` / `skip` /
`timeout`) **plus scorers**: deterministic verifiers like `exit_code`,
`regex_match`, `file_exists`. A worker doesn't merely *claim* success — a
deterministic check confirms it before the result is accepted.

### Why we want it
House-rule #4 says every role has a typed deliverable, and `TaskBrief`
(`types.ts:112`) already declares an `expectedOutput` shape. But nothing
*verifies* the child met it — we trust the child's word. A scorer is a cheap,
deterministic gate the parent attaches to a spawn: if it fails, the
`ChildResult.status` becomes `tool_error`/`partial` regardless of what the child
reported. This pairs naturally with the receipt (#1): the receipt says what
happened, the scorer says whether that satisfies the contract.

### Sketch
Extend `SpawnChildParams.expectedOutput` with an optional scorer list:
```ts
export type Scorer =
  | { kind: 'file_exists'; path: string }
  | { kind: 'regex_match'; on: 'output'|'notes'; pattern: string }
  | { kind: 'json_schema'; schema: Record<string, unknown> }   // validate output shape
  | { kind: 'command';     cmd: string; expectExit: number };  // e.g. `bun test`, gated by perms
```
- Run by the framework **after** the child returns, **before** the result is
  surfaced to the parent.
- A failed scorer downgrades status and appends a structured reason to
  `ChildResult.notes` — fail loud, parent sees exactly which gate failed.
- `command` scorers run through the existing tool-executor / permission system —
  no sandbox bypass (house rule: never bypass permissions "just for now").
- Start with `file_exists`, `regex_match`, and `json_schema` (zero new
  permission surface); add `command` once the perms path is wired.

### Effort
Small for the first three scorer kinds (pure functions over `ChildResult` +
workspace). `command` is medium because it touches the permission system.

---

## Suggested order

1. **Receipts** — smallest, immediately useful, no new permission surface, and
   it's the substrate the other two read from.
2. **Scorer gates** (first three kinds) — small, directly closes the
   typed-deliverable loop.
3. **Ledger + resume** — most valuable for long runs but the biggest design
   surface; do it last and give it its own design pass.

## Explicitly out of scope
- RouteResolver / provider registry — we already resolve by topic via
  `ModelRegistry.getModelForTopic`; their explicit-provider model doesn't fit.
- OS sandboxing (Landlock/seccomp/Seatbelt/bwrap) — separate concern from the
  shell/docker tools; not part of this note.
- Constitution / nested-authority framing — more vocabulary than mechanism for us.
