# Mission control

**Agents → Mission control** (`/agents`) lists every agent run of the user's
day in one place, whoever started it, with what is running now, what waits on
the user and which schedules run next. The paged list of all runs across days
is **Run history** (`/agents/history`).

## Started by

Every agent row records what started it (`agents.source`, with details in
`agents.origin`):

| Source | When |
| --- | --- |
| You, in chat | A turn from the web chat, TUI, REST API or voice |
| Spawned by an agent | A child of another agent (`spawn_child`); its origin keeps the hook or pipeline its tree started from |
| Heartbeat | A heartbeat hook, including role heartbeats that pick up to-dos |
| Schedule | A schedule hook (cron, recurring task, daily briefing) |
| Webhook | An incoming webhook hook |
| Pipeline | A pipeline stage worker; `origin.pipelineId` names the run |
| Companion | An action of a Companion supervision goal; `origin.goalId` names it |
| Monitor | A session monitor's wake-up |
| Messaging channel | Telegram, Slack, Teams, WhatsApp |
| Shared room | A room turn in a shared space |
| Manual test | *Test* on a hook |

**How it is recorded.** Entry points that know more than the spawn does set an
ambient origin around the work they start (`withAgentOrigin` in
`src/core/agent-origin.ts`): the hook runner (`HookManager.triggerHook`) with the
hook's id and name, the Companion dispatcher with the goal, and the pipeline
walk with the pipeline id. `AgentManager.spawn` resolves the origin of each new
agent from that, its parent and the turn's channel (`resolveAgentOrigin`), and
writes it with the row.

Rows written before migration `0170_agent_origin` have no origin. Mission
control shows them as **Not recorded** rather than guessing.

## What the page shows

- **Working now** — running agents with what started them, tokens and recorded
  cost, and *Stop* / *Open session*.
- **Needs you** — permission approvals waiting on the user. If they cannot be
  read, the tile says so instead of showing 0.
- **Runs today** and **recorded spend today** — spend is the sum of `cost_log`
  for the day; requests without a price (CLI subscriptions, unpriced local
  models) are not in it, and a run without any priced request shows *not
  recorded*.
- **Up next** — enabled schedule and heartbeat hooks, soonest first; a heartbeat
  shows its check interval.
- **All runs today** — filterable by source, linking to the agent and its session.

`GET /api/agents/overview` returns the data. It reads through the principal's
scoped repositories: the user's own agents, hooks and spend in the current
workspace.

### In the sidebar and the chat

- The **Mission control** item in the sidebar shows how many runs are working
  now and, in coral, how many approvals wait on the user (`GET
  /api/agents/pulse`, polled every 10 s). A folded *Agents* group shows the
  same on its heading. Live runs come from the worker registry and count only
  when the principal's scoped repository finds their row.
- The **chat** shows the agents its turns spawned in a strip above the
  conversation: role (or pipeline stage), state and tokens, working ones first,
  each opening its run view.

## Triggers

**Agents → Triggers** (`/agents/triggers`, `GET /api/agents/triggers`) lists
everything that starts an agent without the user typing — heartbeats,
schedules, webhooks, event hooks, session monitors and Companion goals — and
what each decided today:

- **Today** — one lane per trigger: runs, failures, heartbeat checks that
  skipped, and the next run.
- **Heartbeat checks today** — the funnel: checks, minus each skip reason in the
  order the gate tests them, equals turns started. Skipped checks use no model
  tokens.
- **Why did it run, or not?** — a heartbeat's latest decisions with their
  reasons (from `heartbeat_checks`, see [HEARTBEAT.md](HEARTBEAT.md#seeing-what-it-decided)).
- **All triggers** — type, what it starts (a role or an action), cadence,
  today's runs and failures, next run and whether it is on. Editing stays in
  *Hooks & schedules*.

A **session monitor** is listed with its interval and the session whose agent it
wakes on a change; its last check today is a lane event (a failure when the
check recorded an error) and its name opens the session. A **Companion goal**
that is open, or closed today, is listed with its state; each Companion action
today is a run (or a failure) on its lane, and its name opens *Companion*.

## Run detail

Opening a run (`/agents/view?id=…`, `GET /api/agents/:id/run`) shows, above
its event timeline:

- **Why this run exists** — the provenance chain, outermost first: what started
  the tree (the *Started by* source and channel), the hook, the heartbeat check
  that passed just before the run (with its ready to-dos), the pipeline or
  Companion goal, and the parent that spawned it. Each step links to where it is
  managed. A run from before origins were recorded says so.
- **Run tree** — its parent, itself and the workers it spawned, each linking to
  its own run view.
- **Prompt** — what its first request held, by category, as in the
  [context inspector](CONTEXT-INSPECTOR.md): the root's sizes from the user
  message it answered, a worker's from its agent row. Section text can be read
  while the process still holds it.

The read goes through the principal's scoped repositories: another user's run
is *not found*.

## Roster

**Agents → Roster** (`/agents/roster`, `GET /api/agents/roster`) shows every
role as an agent the user manages: the root agent (Octipus, which answers chat)
and each specialist role, including a role only seen on older to-dos or hooks
(marked *not in the registry*). For each:

- what it is for (the role's description), its lane, tool groups and whether it
  is read-only;
- how it starts — delegated to from chat or a pipeline, and its **heartbeat**
  switch (the same toggle as the to-do board's role-agents panel, `PUT
  /api/tasks/role-agents`), with its check interval, next check and the latest
  decision from `heartbeat_checks`;
- its assigned to-dos (open of total), flagged *waiting* when its heartbeat is
  off;
- today's runs and the latest one, with what started it.

A banner says when the server's heartbeat is switched off or `tasks/write` is
not allowed, since either stops every role heartbeat. Role prompts and lane
bindings are edited on *Topics*.
