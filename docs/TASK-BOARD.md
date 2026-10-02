# Task Board

The work board lets people and agents share one to-do list without stepping
on each other. It extends the existing `tasks` table rather than adding a
separate board: a task can be **assigned** to a person, a role or a swarm
node; an agent **checks a task out** before working it, so two agents never
do the same work; and each task has a **comment thread** for progress and
hand-off notes. Closing a task **wakes** whatever was waiting on it, and a
**role agent** can wake on the heartbeat to work the tasks assigned to its
role.

## Where it lives

The board is part of the tasks page (`/tasks`, `web/app/tasks/page.tsx`).
The toolbar switches between two views, remembered per browser:

- **list** — tasks grouped by next action, priority, due date, category or
  none; sub-tasks nest under their parent.
- **board** — one column per status (`open`, `in_progress`, `done`; archived
  stays out of the way), with lanes by category inside each column. Cards
  drag between columns, or move with their arrow buttons.

Board-specific pieces (`web/components/tasks/work-board.tsx`):

- an assignee chip on each row and card, and an inline assignee editor;
- an **Assignee** filter in the toolbar: all, unassigned, assigned to agents
  (role or node), or one role;
- a role picker on quick add ("Assign to role");
- a lease badge on a checked-out task: `<holder> · working · <age>` while the
  claim is live, `claim lapsed` once it has run out, and a **Release claim**
  button (with a confirm);
- a comment thread per task, loaded when opened;
- a collapsible **Role agents** panel (see below).

The page re-reads the list every 30 seconds while it is visible, so agent
progress shows up without a reload.

## Task fields

| Field | Values | Meaning |
|---|---|---|
| `status` | `open`, `in_progress`, `done`, `archived` | `open` and `in_progress` are "active". |
| `assigneeKind` | `user`, `role`, `node`, or null | Who the task is for. A `role` task may be picked up by any agent of that role. |
| `assigneeRef` | string, up to 200 chars | The user, role or node id. |
| `parentId` | task id or null | Makes the task a sub-task. A parent with active children is waiting on them. |
| `blockedBy` | task ids | The task waits until none of these is active. |
| `checkedOutBy` | string or null | Current holder of the checkout (server-managed). |
| `checkedOutAt` | timestamp or null | When the lease was taken or last renewed (database clock). |
| `checkoutRunId` | string or null | The run that holds the claim, for diagnostics. |

Assignee rules: `assigneeKind` and `assigneeRef` are set together. A null or
empty kind, or a null ref on its own, clears the assignee. A ref without a
kind is refused (`400`).

The schema is `src/db/schema/tasks.ts`; the board columns and the
`task_comments` table come from migration `0113_task_board.sql`.

## Checkout and lease

Claiming a task is one conditional `UPDATE`, so of two concurrent claimers
exactly one wins; the other gets `409` naming the holder. A claim succeeds
only if the task is active and either the caller already holds it, or the
lease is free (no holder, or the holder's lease has lapsed) **and** the task
is not waiting on an active blocker or an active sub-task. A waiting task is
refused with `409` and `reason: "blocked"`, listing what it waits on. A
successful claim moves the task to `in_progress`.

- **Duration.** A checkout is a 30-minute lease (`TASK_CHECKOUT_TTL_MS` in
  `src/core/tasks/checkout.ts`), judged entirely on the database clock.
- **Renewal.** Checking out again as the same holder is idempotent and moves
  `checkedOutAt` to now. A holder renews even if it has since split the task
  into sub-tasks (the blocked rule applies only to new claimers).
- **Release.** The holder may release; the task goes from `in_progress`
  back to `open`. The owner can force a release of anyone's claim (the
  **Release claim** button does this). Releasing a task nobody holds
  succeeds and writes nothing.
- **Expiry.** A lease that is not renewed within 30 minutes is not cleared by
  a reaper; it simply stops counting, and the next claimer takes it over in
  the same conditional update. This is how a crashed agent's claim clears.
- **Other ways a claim ends.** Moving a task to `open`, `done` or `archived`
  clears the checkout.

Holder enforcement differs by caller. The tasks tool's `update_task` and
`complete_task` refuse a write while another agent holds a live checkout (the
check is inside the same `UPDATE`). The REST routes do not: the user can
always edit a task, and a status change to open, done or archived ends any
claim.

An agent's board identity is stable across turns, so it can renew, release
or complete its own claim later: `pipeline:<pipelineId>/<nodeKey>` for a
pipeline stage, otherwise `<role>@<rootSessionId>`. Two parallel workers of
one role in one session share that identity. A claim made through the API
without an `actor` is recorded as `user:<userId>`.

Agents use `checkout_task` (with `release: true` to give a claim back) from
the `tasks` tool.

## Comments

Each task has a thread of comments (`task_comments`), deleted with the task.
A comment records its author kind (`user` or `agent`), the author reference
(the user id, or the agent's board identity) and a body of up to 10,000
characters. Users post through the API or the tasks page; agents post with
the `add_task_comment` tool. Reading a thread returns the newest 200
comments, oldest first, with `truncated: true` when older ones were left out.

## Dependency wakeups

When a task leaves the active set (closed as `done` or `archived`, or deleted
while still active), two kinds of task may have been waiting on it:

| Event | Fires for |
|---|---|
| `task.unblocked` | An active task whose `blockedBy` includes the closed task and which now has no active blocker. If two blockers remain, closing one wakes nobody. |
| `task.children_completed` | The closed task's parent, if it is still active and none of its children is active any more. |

"Waiting" uses the same rule as the ranker and the tasks page. A blocker id
that exists but cannot be read still counts as blocking, so a wakeup is never
a false positive. When two closes free one task back to back, only one of
them fires. Re-closing an already closed task fires nothing.

Who is notified:

- **The task owner** gets one in-app notification per woken task
  (`task_unblocked` or `task_children_completed`; a task woken both ways gets
  one combined notification).
- **The role agent**, if the woken task is assigned to a role and the owner
  has an enabled heartbeat hook for that role: the hook is marked due, so the
  next cron tick runs its gate instead of waiting out the interval. Quiet
  hours, the daily cap and the quota still apply.

Wakeups run detached from the write: they never slow it down or fail it.
They are a shortcut, not the only way work is found; a role agent's regular
heartbeat still picks up ready tasks. The code is in
`src/core/tasks/wakeups.ts`.

## Goal ancestry in child briefs

This applies to swarm agents spawned with `spawn_child`, not to task rows.
Each spawned child carries the briefs of the tasks above it (root-most first,
each clipped to 300 characters) in its context metadata. When it spawns its
own children, their message includes a short "Why this task exists (the tasks
above yours, top down)" section. Entries that only repeat the original
request or the parent summary are dropped, and each entry goes through the
same input guard as the task brief. See `composeChildMessage` in
`src/core/swarm/spawner.ts`.

## Tasks taken on in a group channel

A member of a [group channel](CHANNELS.md#group-channels) can hand the bot
work: `@Octipus take this — <what>`, or a 🐙 reaction on a message. That puts
a task on the member's own board (their default workspace), created in
progress and without the tasks tool's ASK, since the member asked for it:

- `source = channel`, and `sourceRef` holds the member's session for that
  thread (`sessionId`, the link to the thread), the channel's name (`label`),
  a link to the message (`url`) and its platform id (`messageId`; taking the
  same message twice finds the first task);
- the notes say who asked, where, and whose message it was.

The work runs in that thread session, with the group channel's rules. While
the task is open, each turn in the thread sees it with its newest board
comments, and the root agent can close it with `complete_taken_task`, which
reaches only the tasks taken in that thread and adds its result as a comment.
Closing, archiving or deleting the task by any route posts one line in the
thread (`onTaskClosed` in `src/core/tasks/wakeups.ts`). Board comments are not
posted in the channel. While the task is open its thread session is kept by
the session retention sweep. The code is in `src/core/channels/taken-tasks.ts`.

## Audit trail

Task mutations write an audit row with action `task_mutated` (migration
`0115_audit_task_mutated.sql`). The row carries the task id, the operation
(`create`, `update`, `complete` or `delete`), the names of the changed fields
(never their values), the actor and a run id.

| Path | Actor | Run id |
|---|---|---|
| `/api/tasks` routes (create, update, complete, delete) | `user`; `onBehalfOf` names the owner when an admin acts on someone else's task | null |
| `tasks` tool: `create_task`, `add_tasks`, `update_task`, `complete_task` | `agent`, identified by the spawned agent's id | root session id |
| Source ingestion (email, reader, research) | `system` | null |
| A task taken on in a group channel | `system` (`channel`) on create; `agent` when `complete_taken_task` closes it | the thread session |

An update that changes nothing, and `complete_task` on a task already done,
write no row. Checkout, release and comments are not audited. The write is
best effort and never fails the mutation. Admins can see the rows on the
admin audit page (`/admin/audit`, filter by action `task_mutated`) or with
`GET /api/admin/audit?action=task_mutated`.

## Role agents

A role agent is a heartbeat hook whose `triggerConfig.role` names a role
(for example `coding`). It uses the same gate as the plain heartbeat (see
[HEARTBEAT.md](./HEARTBEAT.md)), but its probe is the owner's tasks assigned
to that role that are ready: active, not waiting on anything, and not held by
a live checkout. A non-empty probe spawns the role's agent with up to 20 of
those tasks and a fixed protocol: check out first and skip any task that is
refused, renew on long work, comment as it goes, then `complete_task`, or
comment and release if it cannot finish.

**Turning one on.** Open the **Role agents** panel on the tasks page. It lists
every role that has active tasks assigned (or whose agent is already on),
with a switch per role. The panel is per user across all workspaces: a role
agent works every task assigned to its role, whichever workspace it is in. An
unknown role can be turned off but not on. The switch calls
`PUT /api/tasks/role-agents`, which creates or re-enables one hook
`Heartbeat (<role>)`, or disables every hook for that role.

**Requirements.**

- `heartbeat.enabled` must be on for the server. The panel says so when it
  is off.
- The owner must set the `tasks` tool's `write` action to **Allow** (on the
  tools or permissions page). It defaults to ASK, and a heartbeat turn has
  nobody to answer. Without it the gate skips with
  `tasks_permission_required` and the panel shows "needs board permission".

**One-time notification.** The first time a role agent finds ready tasks but
lacks `tasks/write`, the owner gets a `heartbeat_permission_required`
notification ("The `<role>` agent has tasks ready but cannot work them"). It
is not repeated on later ticks. When a later tick finds ready tasks with the
permission granted, the flag resets, so losing the permission again sends a
new notice.

**One turn at a time.** A role hook runs at most one turn at a time, across
all server processes, through a lease on the hook row. The lease lasts the
agent timeout (`agent.defaultTimeout`, or one hour when that is 0) plus 10
minutes; the running turn renews it and clears it when it ends. A tick that
finds a live lease skips with `in_flight`.

## Several server processes

On external PostgreSQL, wakeups reach every server process: the originating
process files the notification and marks role hooks due, then publishes the
event over `LISTEN/NOTIFY` on the `octipus_task_wakeups` channel. Other
processes re-emit it locally for in-memory use only, so side effects happen
once. On embedded PGlite there is one process and none of this runs.

Leases on role hooks lapse on their own if a process dies. Two environment
variables decide which leases a process may clear at startup:
`OCTIPUS_INSTANCE_ID` and `OCTIPUS_SINGLE_PROCESS`. See
[CONFIGURATION.md](./CONFIGURATION.md#environment-variables) for how to set
them safely.

## REST endpoints

All paths are under `/api` and act on the caller's own tasks.

| Method | Path | Description |
|---|---|---|
| GET | `/api/tasks` | List tasks; filters `status`, `due=today`, `category`, `assigneeKind`, `assigneeRef`, `view=next`. Rows carry `leaseExpiresAt`, plus `serverNow`. |
| POST | `/api/tasks` | Create a task; accepts `assigneeKind` / `assigneeRef`, `parentId`, `blockedBy`. |
| PATCH | `/api/tasks/:id` | Update a task; overrides any checkout. Null `assigneeKind` unassigns. |
| DELETE | `/api/tasks/:id` | Delete a task (wakes dependents if it was active). |
| POST | `/api/tasks/:id/checkout` | Claim or renew; body `{ actor?, runId? }`. `409` on conflict or `blocked`. |
| POST | `/api/tasks/:id/release` | Release a claim; body `{ actor?, force? }`. `409` if another actor holds it and `force` is not set. |
| GET | `/api/tasks/:id/comments` | The newest 200 comments, oldest first, with `truncated`. |
| POST | `/api/tasks/:id/comments` | Add a comment as the user; body `{ body }`. |
| GET | `/api/tasks/role-agents` | Roles with task counts, hook state, `boardWritesAllowed` and `heartbeatEnabled`. |
| PUT | `/api/tasks/role-agents` | Turn a role agent on or off; body `{ role, enabled }`. |
| GET | `/api/admin/audit?action=task_mutated` | Admin only: task mutation audit rows. |
