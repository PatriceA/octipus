# Swarm Reliability & Verification

Three additions make the swarm (Orchestrator → Agent → Subagent) **auditable**,
**verifiable**, and **resumable** without changing how delegation works. They
share one principle from `DESIGN.md` — *fail loud, no silent fallbacks* — turned
into concrete machinery:

| Feature | Question it answers | Who consumes it |
| ------- | ------------------- | --------------- |
| **Receipts** | *What did this child's tool calls actually do?* | the parent agent / an auditor |
| **Scorer gates** | *Did the child's output actually meet the contract?* | the parent agent |
| **Ledger + resume** | *What happens to in-flight work when the process dies?* | the framework, on boot |

They build on the existing swarm substrate (see
[AGENT-ARCHITECTURE.md](AGENT-ARCHITECTURE.md#swarm-3-level-hierarchy) and
[.octipus/swarm-design.md](../.octipus/swarm-design.md)). Background on why these
were chosen: [.octipus/codewhale-borrowed-ideas.md](../.octipus/codewhale-borrowed-ideas.md).

---

## 1. Receipts — deterministic side-effect audit

A **receipt** is a framework-built record of what a child node's tool calls
*actually did*, assembled from the `ToolExecutor`'s real counters — **never** from
the child model's prose summary. It lets a parent detect *"the child claims
success but wrote no files / had 3 denied tool calls"* without re-reading a
transcript.

### Shape

`ChildResult.receipt` (and `SwarmReceipt` in `src/core/swarm/receipt.ts`):

```jsonc
{
  "schemaVersion": 1,
  "nodeId": "…",
  "kind": "agent",
  "status": "ok",
  "sideEffects": {
    "toolCalls": 7,          // total successful tool calls (= sum of byName)
    "filesChanged": 2,       // FILE_CHANGE_TOOLS (write/append/delete/copy/move/mkdir)
    "commandsRun": 1,        // shell__run + shell__run_background
    "approvalsRequired": 0,  // ASK-level calls that prompted a human
    "approvalsDenied": 0,    // …that the human rejected
    "autoApproved": 3,       // ASK-level calls auto-approved (autonomous workers)
    "permissionDenials": 0,  // blocked by policy or a pre-tool hook
    "toolErrors": 1,         // tool executions that threw
    "byName": { "filesystem__write_file": 2, "shell__run": 1, "websearch__search": 4 }
  },
  "tokens": { "used": 1234, "cap": 80000 },
  "durationMs": 4200,
  "unavailable": [],         // evidence that could NOT be captured (see below)
  "notCertified": ["correctness", "security"]
}
```

### How it stays honest

- **Sourced from real records.** Every counter is incremented by the
  `ToolExecutor` as it processes calls — the single deterministic choke point.
  `toolCalls` / `filesChanged` / `commandsRun` are **derived** from the `byName`
  map at snapshot time, so they can't drift out of sync.
- **"Unavailable" ≠ "zero".** If a worker exposes no counters (e.g. a CLI
  worker), the side-effect evidence is listed in `unavailable` rather than
  reported as all-zero. Absence of evidence is recorded, not faked.
- **Claim ceiling.** `notCertified` states what a receipt does **not** assert: it
  records *what happened*, never *whether it was correct or safe*.

### Where it lives

Built in `singleSpawnAndRun` (`src/core/swarm/spawner.ts`) after the child
returns; attached to `ChildResult` and persisted inside the `swarm_nodes.result`
jsonb (queryable via `result->'receipt'`). No dedicated column.

A cache hit reuses the original run's receipt — it audits the work that was
reused, while the outer `status: "cache_hit"` signals the reuse.

---

## 2. Scorer gates — verify the typed deliverable

Every role already declares an `expectedOutput` shape (house rule #4). A
**scorer** is a cheap, deterministic check that the deliverable *actually*
satisfies it. A parent attaches scorers to a `spawn_child` call; they run **after
the child returns `ok`, before the result reaches the parent**. Any failure flips
the result to **`contract_failed`** so the parent retries/corrects instead of
synthesizing against output that missed the brief.

### Usage (from a parent agent's `spawn_child` call)

```jsonc
{
  "role": "writing",
  "topic": "docs",
  "subtopic": "release-notes",
  "taskBrief": "Write release notes to notes.md as JSON {title, body}.",
  "expectedOutput": { "shape": "json" },
  "scorers": [
    { "kind": "non_empty" },
    { "kind": "json", "requiredKeys": ["title", "body"] },
    { "kind": "file_exists", "path": "notes.md" }
  ]
}
```

### Scorer kinds

| kind | passes when… | options |
| ---- | ------------ | ------- |
| `non_empty` | output is non-empty (null/undefined **fails**) | — |
| `contains` | output/notes contains a literal | `value`, `on: output\|notes` |
| `regex` | output/notes matches a pattern | `pattern`, `flags`, `on` |
| `json` | output parses as JSON (+ required top-level keys) | `requiredKeys[]` |
| `file_exists` | a path exists in the child's workspace | `path` |
| `side_effect` | the child's deterministic receipt meets thresholds | `minFilesChanged`, `minCommandsRun`, `maxToolErrors`, `requireWorkingTools` |

Scorers are **opt-in** and validated at the spawn boundary — a malformed spec is
rejected loudly (`spawn_child: invalid scorers: …`), not silently dropped.

### Safety notes

- **`file_exists`** resolves through the same `WorkspaceFS` sandbox the
  filesystem tools use, so it respects per-user roots and path relocation rather
  than guessing an absolute path.
- **`regex`** patterns come from the (LLM-authored) parent, whose context can
  include untrusted tool/web output, so patterns prone to catastrophic
  backtracking (nested quantifiers like `(a+)+`) and over-long patterns are
  rejected, and the matcher scans only a bounded slice.
- **`runScorers` never throws** — a misbehaving scorer counts as a failed gate,
  so a broken check can't masquerade as a pass.

### `contract_failed` status

A first-class `swarm_node_status` value — **not** mapped onto `tool_error` — so a
missed contract is queryable and visible as its own failure class in the
swarm-tree UI. It is **not** auto-retried (distinct from `tool_error`); the
parent LLM decides. Failed scorers are surfaced explicitly on both the await
(`formatChildResult`) and detached (`collect_children`) parent surfaces:

```
<ChildResult nodeId="…" status="contract_failed" …>
  <output>…</output>
  <scorers passed="false">json: missing required keys: body; file_exists: file "notes.md" does not exist</scorers>
</ChildResult>
```

**Code:** `src/core/swarm/scorers.ts`, wired in `spawner.ts` + `swarm-tool.ts`.

---

## 3. Ledger + resume — durable, replayable swarms

`swarm_nodes` holds the *current* state of each node. The **ledger**
(`swarm_ledger` table) holds the append-only *history* of transitions, so a swarm
interrupted by a crash, sleep, or restart can be **replayed and reconciled
deterministically**.

### Event model

One row per lifecycle transition, keyed by `root_session_id`, ordered by a global
`bigserial seq`:

| event | meaning |
| ----- | ------- |
| `spawn` | a child node was created and started running |
| `result` | the node reached a terminal status |
| `cancel` | the node was cancelled (cascade / admin) |
| `reconcile` | a resume pass marked an in-flight node terminal |

Writes happen in the spawner, **fire-and-forget** (the writer internally
catches+logs, so the ledger never blocks or breaks a spawn — it is a durability
aid, not on the critical path).

### Replay & reconcile

- **`replayEvents`** (pure) folds a root's seq-ordered events into the
  reconstructed node tree and the list of `in_flight` nodes (spawned, never
  terminated).
- **`reconcile(rootSessionId)`** is **idempotent**: it appends a `reconcile`
  event (treated as terminal by the next replay) and flips the `swarm_nodes` row
  to `cancelled` only if it is still `running`. Running it twice is a no-op. It
  marks orphaned work terminal — it does **not** re-execute agents (reviving the
  model work is a deliberate follow-up).
- **Multi-instance safe.** An **age guard** (aligned with the orphan reaper's
  `orphanReaperIntervalMs`) means a booting instance won't cancel a *sibling's*
  freshly-spawned, still-running nodes — only nodes whose last event is older than
  the threshold are reconciled.

### Boot sequence

On startup (`src/index.ts`, after DB init) two passes run in order:

1. **Orphan reaper** (`reapOrphanedSwarmNodes`) — flips stale `running`
   `swarm_nodes` to `cancelled` and handles detached-uncollected subagents
   (node-table cleanup).
2. **Ledger resume** (`reconcileAllIncomplete`) — replays each root with
   in-flight ledger entries and records the durable `reconcile` history on top,
   using the same age threshold.

**Code:** `src/core/swarm/ledger.ts` (pure fold + `SwarmLedger`),
`ledger-repository.ts`, table in `src/db/schema/swarm-ledger.ts`.

---

## Status reference

`ChildResult.status` / `swarm_node_status` values relevant to these features:

| status | source | retried? |
| ------ | ------ | -------- |
| `ok` / `completed` | normal success | — |
| `cache_hit` | result served from the per-session cache | — |
| `contract_failed` | a scorer gate failed (§2) | no — parent decides |
| `tool_error` | the child crashed | yes (once, new node) |
| `cancelled` | cascade/admin cancel, or ledger reconcile (§3) | — |

---

## FAQ

**Do receipts/scorers/ledger slow down spawns?**
Receipts are a cheap reduction over counters already collected. Scorers run only
when attached, on an already-finished child. Ledger writes are fire-and-forget.

**Are scorers required?** No — opt-in per `spawn_child`. With none attached,
behaviour is unchanged.

**What about a multi-process deployment?** The ledger resume's age guard prevents
one instance from cancelling another's live work. Receipts and scorers are
per-node and process-local.

**Can I query receipts/contract failures?** Yes — receipts via
`swarm_nodes.result->'receipt'`; contract failures via `status = 'contract_failed'`
or the `swarm_ledger`.
