# Orchestration gaps found against T3 Code (2026-11)

T3 Code (pingdotgg/t3code) exposes its orchestrator to provider agents through
an app-owned MCP server: delegated tasks, thread send/wait/interrupt, and
scheduled tasks. We compared its design with Octipus's swarm, CLI bridge,
steering and webhook paths, reading the Octipus code rather than the docs.
This plan keeps only the gaps that hold in Octipus's own model. Sessions do not
control each other (several agents on one problem is one session with a
swarm), and the agent never chooses its model (lanes are bound before the turn).

Already fixed in the same change as this plan:

- A burst of webhook deliveries to an `orchestrated: false` `spawn_agent` hook
  ran parallel agents in one session. The run now waits in `withSessionTurn`
  (`src/hooks/actions.ts`).
- `steer_child` answered "Guidance queued" when a CLI child refused the
  guidance (`src/core/swarm/steer-tool.ts`).

## 1. Child questions and approvals reach the parent

Today a child's approval request and Claude-CLI question go to the user, in the
root session and as a push notification (children run in the root session).
The parent agent is never told.

- `collect_children` waits on a timer only (`detached-child-manager.ts:84-134`).
  A child waiting on approval does not wake it; on timeout the parent reads
  "STILL RUNNING… call collect_children again" with no mention of the approval
  (`collect-tool.ts:116-128`).
- A parent that is not waiting gets nothing.
- Native children cannot ask a question at all. CLI children are told to "Use
  request_user_approval" (`cli-agent-worker.ts:762`), which is root-only
  (`root-runner.ts:371`).
- A native child waiting on approval has its wall clock paused and can wait
  forever. A CLI child fails after 5 minutes unanswered.

Steps:

1. When a child's `permission_request` (or CLI question) opens, record it on the
   parent's pending-child entry and call `interruptWaits()` on the parent.
2. `collect_children` returns that child with `status="waiting"` and a
   `pendingApproval` / `pendingQuestion` element: request id, kind, a short
   summary, and that the user is being asked. It does not grant the parent
   authority to answer an approval.
3. A parent not in a wait gets one short notice through the normal steering
   path, which queues where steering is not possible. One notice per request.
4. Fix the prompt mismatch: CLI children either get a child-safe question tool
   whose answer goes to the user, or stop being told to call a tool they do not
   have.

Tests: native and CLI child, parent waiting and not waiting, request answered
before the notice is delivered (no stale notice).

## 2. Retry keys for tools that create work

`spawn_child` is already safe: a repeated brief is rejected while the first is
in flight and served from the stored result once completed
(`call-graph.ts:53-125`, `spawn-cache.ts`). The duplicates come from:

- **`octipus_chat`** on the standalone MCP server. The client aborts after 25 s
  (`mcp-server/src/client.ts:113`) while the turn keeps running on the server.
  A retry adds the user message again and starts a second turn. Most likely to
  occur.
- **Dropped CLI-bridge calls.** Only `collect_children` keeps an undelivered
  result (`cli-agent-worker.ts:736-740`). A retried `create_pipeline`,
  `create_task` and so on runs again.
- **`create_pipeline` across turns.** The guard is per-turn
  (`meta-tools.ts:94,197`).
- **Standalone MCP tools** `octipus_spawn_agent`, `octipus_create_task`,
  `octipus_create_recurring_task`, `octipus_create_pipeline`.

Steps:

1. Optional `clientRequestId` on those tools, and an `Idempotency-Key` header on
   `/api/chat`, `/api/pipelines`, `/api/agents` and `/api/tools/execute`.
2. Reuse the delivery claim store (`claimDelivery` in
   `src/hooks/webhook-delivery.ts`), scoped to the user plus the key, holding
   the created id. A retry returns that id, or joins the turn still in flight.
3. The CLI bridge keeps the undelivered result of any mutating tool, keyed by
   the call's `clientRequestId`, as it already does for `collect_children`.
4. `octipus_chat` sends a generated key itself, so the 25 s client timeout
   followed by a model retry no longer duplicates the turn.

## 3. Explicit send modes

Delivery code exists for every adapter. What is missing is a choice and an
honest report of what happened.

- A text-only web or TUI message steers the running turn, the same message with
  an attachment queues, and channels always queue (`message-handler.ts:311-327`,
  `channels/index.ts:1183`).
- There is no stop-and-restart, and steering never interrupts a running tool.
- Vibe and Antigravity accept a steer and then end the turn with "N guidance
  items remain unhandled".
- `/stop` does not cancel turns already queued behind the session lock
  (inferred: the lock has no cancel API).

Steps:

1. `mode: auto | queue | steer | restart` on `chat.send`, `chat.steer` and
   `steer_child`. `auto` keeps today's behaviour.
2. The result says what happened: `steered`, `queued`, `restarted`, `refused`.
   For adapters that cannot take input mid-turn, `auto` becomes `queued`
   instead of reporting an injection.
3. `restart` interrupts the turn at the next boundary and starts a new turn
   with the message first, ahead of anything already queued.
4. Give the session lock a cancel so `/stop` can drop queued turns, and say so
   in the reply.

## 4. Lane visibility for delegation

Not a model picker. Lanes stay bound by the admin.

1. The `routePolicy.primaryModel` mismatch denial names the configured model
   (`spawner.ts:678`).
2. Before spawning, check that the lane's model is usable: CLI installed and
   logged in, circuit breaker closed. Refuse fast with that reason instead of
   spending a run, a retry and a backup attempt.
3. Optional: a read-only `list_lanes` tool with each lane's primary, backup and
   executor models and their health.

## 5. Remaining webhook risks

- A spawn that fails at `maxConcurrentAgents` still marks the delivery done, so
  a redelivery is ignored and the event is lost (`webhook-delivery.ts:600-650`).
  Release the claim when the action did not start an agent.
- Cooldown and `maxExecutions` skips write no execution row
  (`hooks/manager.ts:174-185`). Record them so a skipped event is visible.
- Two concurrent first deliveries can each mint a hook session; only one is
  saved (`actions.ts:334`). Make the persist conditional on `session_id IS NULL`
  and use the stored value.
- The session lock, run queue and merge windows are per process
  (docs/WEBHOOKS.md). Multi-replica deployments need a shared lock before
  ordering can be promised there.

## Status

All five sections are implemented on branch `ccr-24ad81d5-4cu34d`, each with
a review pass and fixes. Known limits kept on purpose: pipeline stages are not
matched to a parent's pending children (§1); the CLI bridge's retry cache is
per run, only `create_pipeline` keys survive into a new run (§2); there is no
shared multi-replica session lock (§5).

## Order

1. Child questions and approvals (1), as it affects every swarm run with ASK
   tools.
2. Retry keys (2), starting with `octipus_chat`.
3. Webhook claim release and the session-mint race (5).
4. Send modes (3).
5. Lane visibility (4).
