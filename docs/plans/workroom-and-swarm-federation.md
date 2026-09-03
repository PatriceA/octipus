# Workroom and Octipus Swarm Federation — Plan

**Status:** Draft — planning only, no implementation yet
**Created:** 2026-09-02
**Scope:** Two features that share one spine. Part 1 is the **Workroom**: several
models, assigned by the user with per-model budgets, working one problem together
inside a single Octipus — brainstorm, decide, claim tasks, execute, report — under a
deterministic watchdog that keeps them from clobbering each other. Part 2 is the
**Octipus Swarm**: several Octipus installs on several machines federating, each one
sovereign, each one offering models and a budget to the others, in a LAN mode and an
internet mode with hard policies that no peer can talk its way around.

Read `DESIGN.md` first; this plan is written against it. Where the plan proposes a
new primitive, the argument for why an existing one does not cover it is stated
inline. Where it reuses one, the file is named.

---

## 0. Why one plan, and the order

The two parts are one plan because the second is the first with the network in
between: a workroom seat is a *(model, role, budget, tool allowlist)*; a federation
peer offers *(model, budget, capability allowlist)*. If the seat abstraction is
right, a remote seat is a seat whose model resolves through a peer. So Part 1 is
built first, and Part 2 plugs into it at exactly one point (§2.7).

Ordering principle, from `docs/plans/rebuild-execution-plan.md`: **adopt the
cheap enforcement first, re-measure before building, and never let a model's
self-report be the record.** The first deliverable (§1.4, W0) is therefore the
file-lease watchdog on its own — it fixes a clobber class the repo has already
paid for (`src/core/swarm/session-scope.ts` header comment) and is useful before a
single workroom exists.

Three rules the whole plan is held to:

1. **Control flow is code, not a model.** Rounds, phases, quorum, claims, leases,
   budgets and stop conditions are a deterministic state machine. Models
   *participate*; they do not sequence. (Rebuild plan, "The orchestrator should not
   decide control flow.")
2. **One delegation shape.** A seat's turn and a claimed task both run as a swarm
   child through `SwarmSpawner` (`src/core/swarm/spawner.ts`). Budgets, receipts,
   ledger rows, permission intersection, cascade cancel and reconciliation come for
   free. No new worker primitive.
3. **Policy is fail-closed and lives at the dispatch seams.** The two seams already
   exist and already fail closed: `tool:before` and `spawn:before` on
   `getOrchestratorHooks().fireWaterfall` (`src/core/orchestrator/hooks.ts`, fired
   from `src/tools/base-tool.ts:126` and `spawner.ts:219`). Every guard in this plan
   is a subscriber there, never a fork of the executor.

---

## Part 1 — The Workroom

### 1.1 What it is, in one paragraph

A workroom is a durable, user-created space bound to a session, with a **charter**
(the problem, the goal, the deliverable shape), a set of **seats** (each: a model
the user picked, a role, a budget, a tool allowlist), a shared append-only
**board** the seats read and post to, a **task list** seats can claim and report
on, and a **watchdog** that enforces leases, scopes, budgets and stop conditions
and writes everything it does to the run log. It moves through phases —
`brainstorm → decide → execute → report` — driven by round counts, quorum and user
gates, never by a model deciding it is done.

It is *not* Mixture-of-Agents (same prompt fanned to N models, aggregator picks;
parked in `ROADMAP.md` as a model preset). A workroom is heterogeneous by design:
seats see each other's posts, disagree, and take different tasks.

### 1.2 Data model

New schema files under `src/db/schema/`, one migration. All tables carry
`user_id` and nullable `workspace_id` like `swarm_nodes` does, participate in the
scoped-repository pattern (`src/db/repositories/scoped.ts`) and get the same RLS
policy shape as migration 0034.

```
workrooms
  id uuid PK · user_id · workspace_id? · session_id FK sessions
  title · charter jsonb {problem, goal, deliverable: {shape, schema?}, constraints[]}
  phase enum workroom_phase ('draft','brainstorm','decide','execute','report','done','stopped')
  budget jsonb {tokens, costUsd?, wallMs}           -- room-wide ceiling
  limits jsonb {maxRounds, quorum, roundTimeoutMs, maxOpenTasks}
  root_node_id text → swarm_nodes.id               -- synthetic depth-0 root
  status_reason text? · created_at · updated_at · completed_at?

workroom_seats
  id uuid PK · workroom_id FK · name (e.g. "Architect")
  model text                                        -- ModelRegistry name the user chose
  peer_id uuid?                                     -- Part 2: remote model (§2.7)
  role text                                         -- AgentRole; tools = role ∩ allowlist
  tool_allowlist text[]                             -- explicit, no wildcards (DESIGN "one job per role")
  budget jsonb {tokens, costUsd?, wallMs, maxTasks}
  used jsonb {tokens, costUsd, tasks}               -- synced from swarm_nodes / cost_log
  status enum ('active','exhausted','paused','removed')

workroom_posts                                      -- the board; append-only
  id bigserial PK · workroom_id · seat_id? (null = user or watchdog)
  round int · kind enum ('proposal','critique','question','vote','decision','task_report','watchdog','user')
  reply_to bigint? · body text (≤ 4k chars) · data jsonb?   -- votes/decisions structured
  node_id text? → swarm_nodes.id                    -- which turn produced it
  created_at

workroom_tasks
  id uuid PK · workroom_id · title · brief text · paths text[] (globs, workspace-relative)
  expected_output jsonb (same shape as spawn_child expectedOutput)
  status enum ('proposed','approved','claimed','running','reported','verified','failed','abandoned')
  claimed_by_seat uuid? · claim_expires_at timestamptz? · node_id text?
  report jsonb? {summary, receipt: SwarmReceipt, evidence: verification rows}
  created_by_post bigint? · created_at · updated_at
```

`run_events.subject` (`src/db/schema/run-events.ts`) gains `'workroom'`; events:
`phase_entered`, `round_started`, `round_ended`, `seat_turn`, `task_claimed`,
`task_reported`, `lease_denied`, `scope_denied`, `budget_exhausted`, `stalled`,
`stopped`. The board is the *conversation*; `run_events` is the *record*. Two
tables because they have different retention and different readers (DESIGN,
"Durable where it matters").

### 1.3 Runtime — `src/core/workroom/`

```
src/core/workroom/
  types.ts            Zod schemas for charter, seat, task, post, limits; phase enum
  repository.ts       scoped CRUD over the four tables
  engine.ts           the state machine: phases, rounds, quorum, gates, stop conditions
  seat-runner.ts      one seat turn = one depth-1 swarm child under the room root
  board.ts            windowed board rendering for a seat's context (last N posts, thread-collapsed)
  tools.ts            seat tools: board_post, board_read, propose_task, vote, claim_task, report_task
  watchdog/
    leases.ts         path lease table over kv_store (TTL), acquire/renew/release
    guard.ts          tool:before subscriber — leases, task scope, budget, git serialization
    stall.ts          round-level stall + repetition detection
    invariants.ts     workroom invariants registered into src/core/invariants.ts
  events.ts           workroom.* gateway events
```

**Root node.** On `start`, the engine calls `SwarmSpawner.makeOrchestratorRoot` to
create a synthetic depth-0 `AgentNode` for the room with the room's budget as its
`NodeBudget`. The room root never runs an LLM; it exists so every seat turn is an
ordinary depth-1 child with cascade budgets, a ledger spawn bracket, a receipt and a
cancel signal. Cancelling the room is `AgentManager.stop(rootId, {cascade:true})`.

**Seat turn.** `seat-runner.ts` builds a `TaskBrief` from the charter, the current
phase directive, the board window and (in `execute`) the claimed task, and spawns
through `spawner.spawnChild` with `spawn_mode: 'detach'` and a `parallelGroup` per
round. Results are gathered with the existing `collect_children` machinery. Model
resolution: the seat's `model` is passed as the lane `executorModel` — the path
the spawner already takes for a plan step (`resolveChildModelAndExpert`,
`spawner.ts:1779`) — so the "no hardcoded models" rule holds: the model came from
the user's seat config, which is config, exactly like a topic binding.

Two spawner changes are needed and both are small:

- The **same-role refusal** (`.octipus/swarm-design.md`, implementation notes)
  rejects a child whose role equals the parent's. A room root has no role; give it
  the sentinel role `workroom` so the check is moot, and add a `workroom` lane to
  the topic table so `getModelForTopic` fails loud if a seat has no model.
- `SpawnChildParams` gains an optional `origin: {kind:'workroom', workroomId,
  seatId, taskId?}` that is written into `swarm_nodes.result.origin` and to the
  ledger payload. The watchdog keys leases on it.

**Phases (engine.ts).** Deterministic. Each transition writes a `run_events` row
and emits `workroom.phase` on the gateway.

| Phase | What seats do | Exit condition (code decides) |
|---|---|---|
| `brainstorm` | Post proposals/critiques/questions to the board. No tools beyond read-only + `board_*`. | `limits.maxRounds` reached, **or** a round produces zero new non-trivial posts (stall), **or** user `/workroom next`. |
| `decide` | Each seat votes on proposed tasks (`vote` tool, structured). | `quorum` reached per task (default: > 50% of active seats), then the **user approves the task list** via the existing approval gate (`orchestrator.approval_required`). Nothing executes without the user gate. |
| `execute` | Seats `claim_task`, run with the task's tool allowlist, `report_task` with receipt + evidence. | All approved tasks `verified`/`failed`/`abandoned`, or room budget exhausted, or user stop. |
| `report` | One seat (user-chosen, default the first) synthesizes the deliverable from task reports and the board. | Deliverable produced in `charter.deliverable.shape`; scorers pass; user accepts. |

`decide` may be skipped when the charter says `mode: 'research'` (no tasks, only a
report), which covers the "brainstorm a plan" use case without touching files.

**Rounds.** A round spawns every active seat once, in parallel, with a per-round
wall clock. A seat whose turn returns `budget`/`timeout` is marked `exhausted`
and skipped afterwards — no retry thrash; the room continues with the rest and says
so on the board as a `watchdog` post. Rounds are the only fan-out; there is no
seat-spawns-seat.

**Board window.** A seat never gets the raw transcript. `board.ts` renders the last
`N` posts (default 30) with threads collapsed to their decision, plus the pinned
charter, plus the seat's own last post. Oversize → `summarizeOutput`
(`src/core/swarm/handoff.ts`). This is the clean-context principle from
`docs/plans/swarm-v2.md` §3.1 applied to a shared medium.

### 1.4 The watchdog

"Etwas, das Ordnung hält im Chaos." Everything below is enforcement, not prompt
text — the prompt says the same thing so the model is not surprised, but the prompt
is not the boundary (same split as `plan-mode.ts`).

**W0 — Path leases (ships first, standalone).**

- `leases.ts`: lease key = `lease:<rootSessionId>:<workspace-relative path>` in
  `kv_store` with TTL (default 10 min, renewed on each write by the holder).
  Value = `{holder: nodeId, seatId?, taskId?, acquiredAt}`. `kv_store` is chosen
  over a new table because it already has TTL-on-read and is the Postgres
  substrate the queue and cache use — one store, no new infrastructure.
- `guard.ts` subscribes to `tool:before`. For a tool in `FILE_CHANGE_TOOLS`
  (`src/core/tool-executor.ts:47`) it resolves the destination path with
  `resolvedFileChangePath`-equivalent logic **before** execution, tries to acquire
  the lease for the calling node, and on conflict sets
  `ctx.shortCircuit = {deny: 'path <p> is held by <seat/node> until <t>; post to the board or pick another file'}`.
  The model sees a typed refusal; the executor never runs. `filesystem__move_file`
  and `copy_file` lease both endpoints. `git__commit`/`git__push` (and any
  `COMMAND_TOOLS` invocation whose argv starts with `git commit|push|rebase|reset`)
  take a single room-wide lease `lease:<root>:__git__` so two seats cannot
  interleave commits.
- Leases are released on `spawn:after` for the holding node (child completed or
  failed) and on `report_task`. The orphan reaper (`orphan-reaper.ts`) clears
  leases of reaped nodes.
- The shell escape (`>`/`tee`/`sed -i`) is named in the directive and not
  enforced in W0, exactly as plan mode does today. W4 closes it for the
  `required` shell-sandbox mode by binding the workspace read-only except leased
  paths (bwrap `--ro-bind` + `--bind` per lease) — worth doing only after W0 has
  shown where the real conflicts are.
- **This lands before workrooms exist** and applies to every parallel
  `parallelGroup` fan-out today, which `session-scope.ts` explicitly cannot cover
  ("does not cover parallel siblings spawned in the same turn").

**Task scope.** In `execute`, a running task's `paths[]` globs are the seat's
write scope: a `FILE_CHANGE_TOOLS` call outside them is denied with the task id
in the message. Implemented in the same `tool:before` subscriber; the globs are
matched against the `WorkspaceFS`-resolved relative path so symlink tricks land
where `WorkspaceFS` already stops them.

**Budgets, three levels, all fail-closed.**

- *Node*: the existing `NodeBudget` cascade (`spawn-budget.ts`). Unchanged.
- *Seat*: `workroom_seats.budget` — tokens are enforced by giving each turn
  `min(levelDefault, seat.remaining)` as its cap through `deriveChildBudget`'s
  input; cost is enforced by a `spawn:before` check that reads
  `CostTracker.getSessionStats` filtered on the seat's nodes and refuses the spawn
  with `budget_exhausted` when `used.costUsd + estimate ≥ budget.costUsd`. This is
  the first place in the codebase where cost is *enforced* rather than logged; it
  is deliberately per-seat, not per-model globally, so that the same model in two
  seats has two budgets (the user assigns budgets to seats, which is what they
  asked for).
- *Room*: the root `NodeBudget`. A room whose root pool is exhausted enters
  `stopped` with `status_reason='budget'`.

Note the existing fail-open in `fan-out-budget.ts:74` (limiter error ⇒ allow).
Workroom checks do not inherit it: a check that cannot read its counter denies.

**Duplicate work.** `propose_task` fingerprints the brief with `taskFingerprint`
(`call-graph.ts`) and rejects near-duplicates against the room's open tasks with
the same "already handled by task X" message the spawner uses for children.

**Stall and loop.** `stall.ts`: a brainstorm round with no new posts, or two
consecutive rounds whose posts are near-identical (normalized-text hash, the
`ToolLoopDetector.checkRedundant` idea applied to posts), ends the phase with a
`stalled` event and a `watchdog` post that says why. A seat that posts the same
body twice in a round is skipped for the rest of the round.

**Approval routing.** Seat turns are unattended children, so
`routeApproval` (`src/security/approval-policy.ts`) auto-approves ASK unless the
action is in `multiuser.unattendedDenyActions`. Workroom turns add
`git.push`, `docker.*`, `shell.execute_destructive` and `filesystem.delete` to
the deny set by default — a room can research and edit, it cannot ship or wipe
without the user in the loop. Configurable per room, never wildcard.

**Invariants** (registered in `src/core/invariants.ts`, driven hold → violate →
hold against Postgres like the four that exist):

1. No two `running` tasks in one room whose `paths[]` intersect.
2. No `active` seat with `used.tokens > budget.tokens`.
3. No room in `done`/`stopped` with a task still `running`/`claimed`.
4. Every `running` task has a `node_id` whose `swarm_nodes` row is `running`.

**Watchdog visibility.** Every deny, release, stall and budget event is (a) a
`run_events` row, (b) a `workroom.watchdog` gateway event, (c) a `watchdog` post on
the board so the seats themselves can see the rule that bit them. Observability
over cleverness.

### 1.5 Seat tools

Registered as meta-tools on the seat's child (the way `spawn_child` and
`escalate_to_different_expert` are attached to depth-1 children in
`spawner.ts`), intersected with the role's tools and the seat allowlist:

| Tool | Phase | Effect |
|---|---|---|
| `board_read({thread?, since?})` | all | Windowed board; cheap, cached per round. |
| `board_post({kind, body, replyTo?})` | all | Appends; `kind` validated per phase (no `vote` in brainstorm). |
| `propose_task({title, brief, paths[], expectedOutput})` | brainstorm, decide | Creates `proposed` task; fingerprint-deduped. |
| `vote({taskId, value: 'yes'|'no'|'abstain', reason})` | decide | One vote per seat per task; overwrites own. |
| `claim_task({taskId})` | execute | Atomic claim (`UPDATE … WHERE status='approved'`), sets `claim_expires_at`; returns brief + scope. |
| `report_task({taskId, summary, evidence?})` | execute | Marks `reported`, attaches the child's `SwarmReceipt`; runs the task's scorers (`scorers.ts`) → `verified` or `failed`. Self-report is never enough: a task with `filesChanged: 0` in its receipt and no evidence row is `failed`, not `verified`. |
| `exit_workroom_turn({note?})` | all | `final: true`; the only way a turn ends early. |

Skills: the existing skill injection at spawn (`worker-spawner.ts:128` pattern,
also in `spawner.ts`) applies unchanged; seats get their role's skills. MCP tools
follow the same intersection rule as any child.

### 1.6 Surfaces

- **Gateway events** (`src/core/gateway/protocol.ts`): `workroom.phase`,
  `workroom.round`, `workroom.post`, `workroom.task`, `workroom.seat`,
  `workroom.watchdog`. All carry `workroomId`; replay buffer pattern `workroom.*`
  like `swarm.*`. Run `npm run catalog` — every declared type needs a publisher.
- **Commands** (`src/core/gateway/commands.ts` + `src/core/commands/`):
  `/workroom new|start|next|stop|status|seat add|seat budget`. One implementation,
  two command surfaces, as `togglePlanMode` does.
- **REST** (`src/api/routes/workrooms.ts`): CRUD + `POST /:id/start`, `/next`,
  `/stop`, `GET /:id/board`, `/tasks`, `/watchdog`. Scoped by principal.
- **Web** (`web/router.tsx` → `web/app/workrooms/page.tsx`,
  `web/app/workrooms/view/page.tsx`): create dialog (charter, seats picked from
  `GET /api/models` — the same list the Models page shows — with budget fields),
  room view with four panes: board (threaded), seats (budget bars from `used`),
  tasks (kanban by status, lease badges), watchdog log. Reuse `swarm-tree.tsx` for
  the per-round child tree.
- **TUI**: `/workroom` command + a board renderer in `src/tui-pi/`.
- **Persona**: workroom narration templates in `src/core/personas/` for
  `workroom.phase` and `workroom.watchdog`, same bridge as `swarm.narration`.

### 1.7 Phases of work

| Phase | Delivers | Ship check |
|---|---|---|
| **W0 — Lease watchdog** | `watchdog/leases.ts`, `watchdog/guard.ts` for `FILE_CHANGE_TOOLS` + git; release on `spawn:after`; `run_events` `lease_denied`; unit + integration tests; invariant 1 generalized to swarm nodes. | Two `parallelGroup` children told to edit the same file: exactly one write lands, the other gets the typed refusal, and the file is byte-identical to the winner's write. Prove the guard is *reached* from the real spawn path, not by calling the hook directly. |
| **W1 — Room + board, brainstorm only** | Schema + migration, `types/repository/engine/board/tools(board_*)`, seat runner on `SwarmSpawner`, `brainstorm → report` for `mode:'research'`, `/workroom` commands, REST, minimal web list + board. | Three seats on three different models (one local Ollama, per "local first") brainstorm a plan for a fixed prompt; the report cites at least two seats' posts; room stops on `maxRounds` with the budget accounted in `swarm_nodes` and `cost_log`. |
| **W2 — Tasks + execute** | `decide` with quorum + user gate, `propose_task/vote/claim_task/report_task`, task scope enforcement, seat cost budget on `spawn:before`, stall detection, invariants 2–4, watchdog posts. | Two coding seats split a two-file change: each claims one task, writes only in scope, reports with a receipt showing `filesChanged ≥ 1`; a deliberate cross-scope write is denied and visible in the watchdog log; the room ends `done`. |
| **W3 — UI + narration** | Full room view, seat budget bars, kanban, watchdog pane, TUI renderer, persona templates, docs (`docs/WORKROOM.md`). | `scripts/ui-live-check.ts` scenario: create room in the browser, watch a round land live, stop it, see the watchdog entry. |
| **W4 — Hardening** | Read-only workspace + per-lease binds under `shellSandbox: 'required'`; red-team plugin: a poisoned board post trying to get another seat to write outside scope or exhaust a budget; eval scenario under `eval/` for the brainstorm quality gate. | Red-team cases pass; `npm run eval` green. |

### 1.8 Not doing (Part 1)

- **No LLM moderator with authority.** A seat may be named "moderator" and asked
  to summarize; the engine, quorum and user gate decide. Anything else reopens the
  control-flow bug class the rebuild plan closed.
- **No seat-spawns-seat.** Fan-out is the round. Depth stays 3.
- **No auto-created rooms.** The root agent does not open a workroom on its own
  judgement; the user does (`/workroom new`) or a hook does with an explicit
  action. Same reason as "named workflows are chosen by name, never inferred".
- **No shared scratch memory beyond the board.** Long-term memory stays per user.
- **No cross-user rooms** in this plan; `workspace_id` is there for the org phase.

---

## Part 2 — The Octipus Swarm (federation)

### 2.1 What it is

Several Octipus instances on several machines, each running its own models and
its own tools on its own hardware. Each instance can **open** itself to specific
other instances, **offer** them capabilities (a model with a budget; a
report-only delegate role), and **consume** what others offer. Nothing is central:
no shared DB, no registry service, no relay in the base design. The instance you
are talking to — at work, on a laptop — consumes the swarm's compute; the
instance at home keeps its disk, its shell and its secrets to itself.

Why not register every model with one tool? Because then that tool holds all the
API keys and none of the machines' resources. Federating *instances* keeps every
key, every workspace and every policy on the host that owns it, and lets the
host's own permission system, vault, sandbox and audit apply to remote requests.

### 2.2 The constitution (hard policy)

A fixed, code-resident policy in `src/security/peer-policy.ts`, treated like
`SECURITY_PREAMBLE` (house rule 6: no edits without an issue and an argument).
It is enforced in code at the two dispatch seams, and stated in the prompt of any
child that runs on behalf of a peer.

1. **A peer can only ask for what was granted.** Requests are typed Zod messages
   (§2.5) naming a capability id; there is no "call tool X" message. A request
   naming a capability not in the peer's grant is rejected before any handler runs.
2. **Granted capabilities never include host control.** `shell`, `filesystem`
   (write), `docker`, `git` (write), vault, settings, admin, plugin/extension
   install, scheduler, hooks, channels, and `spawn_child` to a third peer are not
   grantable. The grantable set is an enum in code, not a config list.
3. **Remote work runs as a service principal.** `principal.kind = 'service'`,
   id `peer:<peerId>`, with its own `user_quotas` row, its own `WorkspaceFS`
   root under `<OCTIPUS_HOME>/peers/<peerId>/`, shell sandbox `required` with
   network policy from the grant, and `multiuser.unattendedDenyActions` extended
   to everything in rule 2. A peer request can never run under the host user's
   principal.
4. **Hop limit 1.** A capability executed for peer A never spawns work on peer B.
   The request envelope carries `hops`; the receiver refuses `hops ≥ 1` to
   forward. Transitive federation is a separate design.
5. **Text from a peer is untrusted input.** Briefs go through `guardInput`
   (`src/core/orchestrator/input-guard.ts`) on receipt; outputs go through
   `guardOutput` before they leave. A brief that blocks is refused with the flag,
   not sanitized.
6. **Both sides consent, both sides can revoke instantly.** Enrollment requires
   admin approval on *each* instance; `octi swarm close` or the UI kill switch
   drops every peer connection and rejects new ones within one heartbeat.
7. **Everything is audited with the peer id.** Every request, refusal, spawn and
   cost row carries `peer_id`; `audit_log.details` and `cost_log.metadata` get it.
   A peer cannot ask for its own audit rows to be deleted (rule 2).
8. **Budgets are enforced by the grantor, fail-closed.** The host that runs the
   model decides. A counter it cannot read means deny.

### 2.3 Identity, enrollment, modes

**Identity.** Each instance generates an Ed25519 keypair at `octi setup` (stored
via `Vault.setSystemSecret('peer.identity')`); `instance_id` is the public-key
fingerprint. Shown by `octi swarm status` and in Settings → Swarm.

**Peer record** (`src/db/schema/swarm-peers.ts`):

```
swarm_peers
  id uuid PK · instance_id text unique (their fingerprint) · name
  public_key text · endpoints jsonb [{url, mode:'lan'|'internet'}]
  mode enum ('lan','internet') · status enum ('pending','active','paused','revoked')
  trust jsonb {approvedBy, approvedAt, pinnedCert?}
  grant jsonb   -- what WE offer THEM: {capabilities: [...], budget: {tokensPerDay, costUsdPerDay, concurrent}, network:'none'|'egress'}
  offer jsonb   -- what THEY offer US (last received advertisement)
  usage jsonb   -- today's counters against grant.budget (also derivable from cost_log)
  last_seen_at · created_at · updated_at
```

**Enrollment** reuses the pairing precedent in `src/api/routes/devices.ts`
(short code in `kv_store`, redeem once):

- *LAN mode*: instances announce `_octipus._tcp` via mDNS/DNS-SD (a ~60-line
  responder; no dependency if `dns-sd`/`avahi` is on PATH, else a minimal
  multicast announcer). Settings → Swarm lists discovered instances with their
  fingerprint. The admin picks one, both UIs show the same 6-word pairing phrase
  derived from both fingerprints, both admins confirm. Mutual consent, no code
  typed over the network.
- *Internet mode*: no discovery. Instance A creates a **signed invite** (JSON:
  endpoint, public key, one-time code, expiry ≤ 1 h, signed with A's key). The
  admin moves it out-of-band (paste, QR). Instance B redeems it; A's admin approves
  B's fingerprint. Only then does either side store the other as `active`.

**Modes** (`config.swarm.federation`, Zod in `src/config/schema.ts`):

```
federation.mode                'off' | 'lan' | 'internet'          default 'off'
federation.listen              bool — accept inbound peer connections  default false
federation.lan.discovery       'mdns' | 'off'                         default 'mdns' when mode='lan'
federation.lan.cidrAllowlist   string[] — inbound peers must match     default [] (= link-local + RFC1918)
federation.internet.publicUrl  string — our reachable wss:// URL
federation.internet.requireTls bool                                    default true, cannot be false
federation.internet.pinPeerCert bool                                   default true
federation.heartbeatMs         default 15_000
federation.defaultGrant        the grant applied to a newly approved peer (empty by default)
```

`mode='internet'` with a non-TLS `publicUrl`, or with `listen=true` and no
`publicUrl`, fails validation at boot. Misconfiguration fails loud.

### 2.4 Transport and authentication

The peer link is a **gateway WebSocket** connection, not a new server. The
protocol already has `AuthMessageSchema.method` with `'hmac'`, `clientType
'agent'` and `TrustLevel 'agent' = 0` (`src/core/gateway/protocol.ts`). Add:

- `method: 'peer'` with credentials `{instanceId, nonce, timestamp, signature}`
  — a challenge–response: the server sends a nonce in a pre-auth frame, the
  client signs `nonce || timestamp || serverInstanceId` with its Ed25519 key. The
  hub's `setHmacValidator` seam gets a sibling `setPeerValidator`.
  Replay window ±60 s; nonces are single-use in `kv_store` with TTL.
- `clientType: 'peer'`, `TrustLevel: 'peer'` numerically **0**, same as
  `agent`. A peer connection can never run commands above that level
  (`CommandRegistry` already gates on `minTrustLevel`), can never subscribe to
  `agent.*`/`swarm.*` of the host's own sessions, and gets its own event
  namespace `peer.*`.
- **LAN mode**: the signed handshake is the authentication; the CIDR allowlist is
  the boundary; TLS optional but recommended. Note the existing loopback check in
  `src/core/gateway/local-auth.ts` stays loopback-only — a peer is never `local`.
- **Internet mode**: TLS mandatory; on first connect the peer's certificate is
  pinned into `trust.pinnedCert` (TOFU at enrollment, refuse on change), plus the
  signed handshake on top so a compromised reverse proxy still cannot impersonate
  a peer. Per-peer rate limits via `RateLimiter.check('peer:<id>', …)`. Idle and
  connection budgets from `connection-manager.ts` apply. Recommended deployment
  is a WireGuard/Tailscale overlay with `publicUrl` on the overlay address — the
  code does not depend on it, but `docs/SWARM.md` says it first.
- Connections are **outbound from the consumer** to the grantor's `listen`
  endpoint. A home instance that only *consumes* never opens a port. A home
  instance that *offers* its GPU to the work laptop must listen — on the LAN, or
  on the overlay.

**Liveness.** `peer.ping`/`peer.pong` every `heartbeatMs`; three misses →
`status` stays `active` but the peer is `offline`, its circuit opens
(`CircuitBreakerRegistry` keyed `peer:<id>`), and running remote nodes are
reconciled (§2.6).

### 2.5 The peer protocol (typed, small)

Zod-validated messages on the peer connection, in `src/core/federation/protocol.ts`:

| Direction | Message | Payload |
|---|---|---|
| both | `peer.hello` | `{instanceId, name, protocolVersion, offer}` — the advertisement |
| both | `peer.offer_update` | new `offer` (grantor changed the grant) |
| consumer → grantor | `peer.infer` | `{requestId, capabilityId, model, messages, tools?, maxTokens, hops:0}` |
| grantor → consumer | `peer.infer_chunk` / `peer.infer_done` | streamed deltas, then usage `{inputTokens, outputTokens, costUsd}` |
| consumer → grantor | `peer.delegate` | `{requestId, capabilityId, role, brief: TaskBrief, expectedOutput, budget, hops:0}` |
| grantor → consumer | `peer.delegate_event` / `peer.delegate_done` | progress events, then `ChildResult` + `SwarmReceipt` |
| both | `peer.cancel` | `{requestId}` |
| both | `peer.refused` | `{requestId, reason: PeerRefusalReason}` (typed enum: `not_granted`, `budget`, `guard_blocked`, `hops`, `offline`, `policy`) |
| both | `peer.ping` / `peer.pong` | |

**Grantable capabilities** (`src/security/peer-policy.ts`, enum, not config):

- `inference:<modelName>` — run a named local model with the peer's own messages.
  The host's `ProviderRouter` executes it; the host's rate limiter and cost
  tracker account for it under `peer:<id>`. This is the capability that turns
  "several PCs with models" into one pool.
- `delegate:<role>` for `role ∈ {research, writing, review, general}` **with the
  read-only tool filter** (`stripMutatingTools`, `plan-mode.ts`) and no
  `COMMAND_TOOLS`; web search and reader tools allowed when the grant says
  `network:'egress'`. The host's skills for that role apply. Output is a
  `ChildResult` in the requested shape.
- `knowledge:search` — later phase; not in the first cut.

Nothing else. Adding a capability is a change to this enum and to the policy
tests, on purpose.

### 2.6 Consuming: how a peer shows up locally

The design goal is "no special case": a remote model is a **model**, and remote
delegation is **`spawn_child`**.

- **Remote model as a provider.** New provider type `peer` in
  `src/models/providers/peer-provider.ts` implementing `ModelProvider` over the
  peer connection (`peer.infer`). When a `peer.hello` arrives, its
  `inference:*` offers are registered in `ModelRegistry` as models named
  `peer/<peerName>/<model>` with `provider='peer'`, cost from the offer, and
  disabled by default until the user enables them on the Models page. From then
  on the user binds topics to them like any model; the whole swarm, every role,
  and every workroom seat can use them with zero code that knows about
  federation. Offline peer ⇒ circuit open ⇒ the existing failover/backup-topic
  path (`getBackupModelForTopic`) engages, fail-loud with a named reason.
- **Remote delegation.** `spawn_child` gets an optional `peer?: string` argument
  that is present in the tool schema **only when at least one active peer offers a
  `delegate:*` capability** (same pattern as the conditional `spawn_child`
  registration by depth). The spawner sends `peer.delegate` instead of spawning
  locally, still creates a local `swarm_nodes` row with `origin_peer_id` set and
  `kind='agent'`, still writes the ledger spawn bracket, still cascades cancel
  (`peer.cancel` on abort). The parent sees an ordinary `ChildResult`.
- **Schema deltas.** `swarm_nodes.origin_peer_id uuid?`; `cost_log.metadata.peerId`;
  `run_events.payload` for remote nodes carries `{peerId, remoteSeq}` so the
  local `seq` stays local-only (it is a single-DB bigserial and must not be
  treated as a global order).
- **Reconciliation.** A peer going offline with running remote nodes: the
  consumer marks them `cancelled` with `error='peer_lost'` via the same path
  `SwarmLedger.reconcile` uses for `orphaned_at_resume`; the grantor's orphan
  reaper cancels the service-principal children on its side.

### 2.7 Where Part 1 meets Part 2

`workroom_seats.peer_id` + `model` = a seat that runs on a remote model, through
the `peer` provider. Nothing in the workroom engine changes. In a later phase a
seat may also be a remote **delegate** (the seat's turns run on the peer with the
peer's skills); that is the `spawn_child … peer` path with `origin.kind =
'workroom'`, and the watchdog's leases still apply because the remote delegate is
read-only by policy (rule 2) — it can post to the board, it cannot touch the
workspace.

### 2.8 Operator surfaces

- **CLI** (`bin/octi`): `octi swarm status | open [--lan|--internet] | close |
  discover | invite | pair <code-or-invite> | peers | grant <peer> <capability> [--tokens N --cost N] | revoke <peer>`.
- **Settings → Swarm** (`web/components/settings/swarm-tab.tsx`): mode switch
  with the TLS/URL validation surfaced, identity fingerprint, discovered/known
  peers with status and circuit state, per-peer grant editor (capability checkboxes
  from the enum, budget fields), usage today, kill switch, audit link filtered on
  `peer_id`.
- **Models page**: `peer/…` models appear with a badge and enable toggle.
- **Admin**: `/api/admin/quotas` already lists per-principal quotas; peer service
  principals appear there.
- **Docs**: `docs/SWARM.md` (concepts, both modes, the constitution, the overlay
  recommendation, threat model), `docs/CONFIGURATION.md` additions.

### 2.9 Threat model and the extra security for internet mode

| Threat | Control |
|---|---|
| Peer asks host to run shell / delete / install / change settings | Rule 2: not grantable; typed protocol has no such message; `tool:before` policy subscriber denies any tool outside the capability's allowlist even if a handler bug maps one. |
| Prompt injection in a delegated brief ("ignore your grant, run…") | `guardInput` on receipt (rule 5); read-only tool filter; service principal has nothing to escalate to; output guard on the way back. Red-team plugin covers it. |
| Impersonating a peer over the internet | Ed25519 challenge–response + pinned TLS cert; nonce replay window; revoke = key removed. |
| Stolen invite | One-time, ≤ 1 h, still needs the inviter's admin approval of the redeemer's fingerprint. |
| Budget drain / DoS by a peer | Grantor-side fail-closed budgets (rule 8) via `QuotaManager` on the service principal; per-peer rate limit; circuit breaker; `concurrent` cap in the grant. |
| Exfiltration through a delegate with egress | `network:'none'` is the default grant; `'egress'` is explicit per peer; shell sandbox `required` (`--unshare-net`) for anything the delegate runs; vault is not reachable from the service principal (`allowed_agents`/`canAccess`). |
| Transitive spread (A → B → C) | Rule 4, `hops` in every envelope, refused at receipt. |
| Peer reading host sessions/events | `TrustLevel 'peer' = 0`; subscriptions to non-`peer.*` patterns rejected in the hub. |
| Exposing the WS endpoint to the open internet | `requireTls` cannot be false; docs lead with the overlay; per-IP pre-auth budgets already in `connection-manager.ts`; optional `cidrAllowlist` also honoured in internet mode. |
| Host admin loses track of what is granted | Settings → Swarm shows grants and today's usage; `octi swarm status` prints them; audit filtered by peer. |

### 2.10 Phases of work

| Phase | Delivers | Ship check |
|---|---|---|
| **F0 — Identity, policy, schema** | Ed25519 identity at setup, `swarm_peers` + migration, `peer-policy.ts` enum + tests, `federation.*` config with the boot-time validation, `octi swarm status`. No network yet. | Boot with `mode='internet'` and a `ws://` URL fails loud with the reason; policy tests prove every non-grantable capability is refused *from the real dispatch path*. |
| **F1 — LAN mode, inference** | mDNS discovery, pairing phrase, `method:'peer'` gateway auth, `peer.hello/infer/ping`, `peer` provider registering `peer/…` models, grantor-side budgets on the service principal, Settings → Swarm (peers, grant editor), `octi swarm open --lan / pair / grant / close`. | Two instances in `docker-compose.test.yml` on one bridge network: pair, grant `inference:<ollama model>`, bind a topic on A to `peer/B/<model>`, run a chat turn on A; `cost_log` on **both** sides shows the row with `peerId`; revoke on B ⇒ A's next call fails with `not_granted`, and A's backup topic engages. |
| **F2 — Delegation + swarm tree** | `delegate:<role>` capability, `spawn_child … peer`, `origin_peer_id`, ledger/reconcile for remote nodes, cancel propagation, remote nodes in `swarm-tree.tsx` with a peer badge, orphan reaping on both sides. | A research task on A delegated to B returns a `ChildResult` with a receipt; killing B mid-run leaves A's node `cancelled/peer_lost` within two heartbeats and no `running` row on either side (invariant). A delegated brief containing a write instruction produces `filesChanged: 0` on B and a guard flag in the audit. |
| **F3 — Internet mode** | Signed invites, TLS + cert pinning, replay protection, per-peer rate limits, `publicUrl` validation, kill switch, `docs/SWARM.md` threat model + overlay guide, red-team plugin (`eval/`): impersonation, replay, injection-through-brief, hop forwarding. | Same F1/F2 checks over TLS between two containers on separate networks through a reverse proxy; the red-team suite is green; a replayed handshake is refused. |
| **F4 — Workroom seats on peers** | `workroom_seats.peer_id` wiring (already a column from W1), remote delegate seats, seat budget accounting across the peer boundary. | The W2 scenario with one seat on a remote model and one remote delegate seat; the watchdog log shows the delegate never held a lease. |

### 2.11 Not doing (Part 2)

- **No central registry, relay or account.** If NAT traversal is needed, the
  overlay network provides it. A relay is a later design with its own threat model.
- **No shared database, no CRDT session sync.** `ROADMAP.md` "Local-first sync" is
  a separate item.
- **No transitive federation** (hop > 1), no trust delegation ("A trusts B, B
  vouches for C").
- **No remote shell/filesystem/docker/git, ever, in this design.** If a use case
  needs it, it is a new capability enum entry with its own policy argument — and
  most likely the answer is "run it as a delegate on the machine that owns the
  files".
- **No automatic grants.** `defaultGrant` is empty by default; an approved peer
  with no grant can only exchange `hello`/`ping`.
- **No federation of channels, hooks, schedules or plugins.**

---

## 3. Cross-cutting

**Tests.** Each phase's ship check is an integration test against real Postgres
(`TEST_POSTGRES_PORT=5453 npx tsx scripts/test-integration.ts …`), plus unit
tests for every guard driven hold → violate → hold. The four testing rules from
the rebuild plan apply verbatim, and the one that matters most here is "prove the
guard is reached": every watchdog and policy test asserts through
`BaseTool.execute` / `SwarmSpawner.spawnChild`, never by invoking the hook
handler with a hand-made context. Two-instance federation tests run under
`docker-compose.test.yml` in a dedicated lane.

**Catalog.** New routes, gateway event types and module edges change
`docs/architecture/generated/CATALOG.md`; run `npm run catalog` in every PR
(CI gates on it).

**Config rules.** No `DEFAULT_*` tunables in code: round limits, lease TTL,
heartbeat, budgets and modes are validated fields in `src/config/schema.ts` with
explicit resolution at the boundary.

**Migrations.** Two new migrations (workroom tables; peer table + `swarm_nodes.
origin_peer_id`). The rebuild plan notes `drizzle-kit generate` currently cannot
run non-interactively because of enum drift; reconcile that first or write these
by hand and say so in the commit — do not leave the rule half-true.

**PR slicing.** One phase per PR at most; W0 and F0 are each one PR. Stacked
branches follow the merge-order note in `AGENT.md`.

## 4. Open questions (decide before W1 / F1, not before W0 / F0)

1. **Seat model choice UI vs topic bindings.** Seats name a model directly (the
   user's explicit assignment). Should a seat alternatively name a *topic* so it
   follows the user's routing table? Proposal: allow both; `model` wins when set.
2. **Cost estimate for the seat budget pre-check.** `spawn:before` needs an
   estimate before the call; use the seat's cap × the model's per-token rate from
   `model_config`. Over-estimates refuse early — the safe direction.
3. **Round parallelism vs `maxPendingDetached`.** A room with 6 seats exceeds the
   orchestrator level default of 6 pending detached children only at the edge;
   confirm whether rooms should have their own `levelDefaults` entry or reuse
   `orchestrator`. Proposal: reuse, cap seats at that number, say so in the UI.
4. **LAN discovery dependency.** Ship the minimal multicast announcer only if it
   stays under ~150 lines; otherwise require `avahi`/`dns-sd` on PATH and document
   it (AGENT.md: no dependency for something doable in 20 lines — this is not
   20 lines, so it is a real decision).
5. **Cost sharing across peers.** The grantor accounts the cost; should the
   consumer's `user_quotas.max_tokens_per_day` also count remote tokens? Proposal:
   yes — the user spent them, whichever host ran the model.
6. **Who may create workrooms and open federation** in a multi-user install:
   admin only for `octi swarm open` and grants; any user for workrooms within
   their quota. Confirm.
