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
