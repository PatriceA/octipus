# Hooks & Tasks

Unified automation system. Hooks react to events (messages, agent completions, webhooks) or run on cron schedules (tasks). Both are stored in the same `hooks` table — a "task" is simply a hook with a `schedule` trigger.

## Hooks

### Concepts

A hook has three parts:
1. **Trigger** — what event fires the hook
2. **Conditions** (optional) — filter rules that must match
3. **Action** — what to do when triggered

### Triggers

| Trigger | Fires when | Config fields |
|---------|-----------|---------------|
| `message_received` | New message on any channel | `channelTypes[]`, `messagePatterns[]` (regex), `sessionFilter` |
| `agent_started` | Agent begins work | `sessionFilter.topics[]`, `sessionFilter.userIds[]` |
| `agent_completed` | Agent finishes successfully | same as above |
| `agent_failed` | Agent errors out | same as above |
| `tool_executed` | A tool runs | `toolIds[]`, `toolNames[]` |
| `permission_requested` | Tool needs user approval | — |
| `schedule` | Cron timer fires | `cronExpression`, `timezone` |
| `webhook` | Inbound HTTP POST to `/api/hooks/incoming/:hookId` | `webhookSecret`, `messageTemplate` |

### Actions

| Action | What it does | Config fields |
|--------|-------------|---------------|
| `notify` | Send message to channel(s) | `notifyChannels[]`, `notifyMessage`, `channelType`, `channelId` |
| `spawn_agent` | Start an AI agent | `agentPrompt`, `agentTopic`, `agentModel`, `orchestrated` |
| `webhook` | Send outgoing HTTP request | `webhookUrl`, `webhookMethod`, `webhookHeaders`, `webhookBody` |
| `n8n_workflow` | Trigger N8N workflow | `workflowId`, `workflowData` |
| `execute_tool` | Run a registered tool | `toolId`, `toolAction`, `toolParams` |

### Notify Action — Channel Format

`notifyChannels` uses format `type:channelId`:

```
telegram:123456789        # Telegram chat ID
slack:C0123ABCDEF         # Slack channel ID
webchat:session-uuid      # WebChat session ID
teams:channel-id          # Microsoft Teams channel
```

To find your Telegram chat ID: send any message to the bot and check backend logs (`~/.octipus/backend.log`).

### Template Variables

Use `{{path.to.value}}` in `notifyMessage`, `agentPrompt`, and `webhookBody`:

| Variable | Available in triggers |
|----------|---------------------|
| `{{message.content}}` | message_received |
| `{{message.channelType}}` | message_received |
| `{{message.channelId}}` | message_received |
| `{{message.userId}}` | message_received |
| `{{agent.id}}` | agent_started, agent_completed, agent_failed |
| `{{agent.sessionId}}` | agent_started, agent_completed, agent_failed |
| `{{agent.topic}}` | agent_started, agent_completed, agent_failed |
| `{{agent.status}}` | agent_completed, agent_failed |
| `{{tool.name}}` | tool_executed |
| `{{tool.toolId}}` | tool_executed |
| `{{webhook.path}}` | webhook |
| `{{webhook.method}}` | webhook |
| `{{webhook.body.*}}` | webhook (nested fields) |
| `{{schedule.cronExpression}}` | schedule |
| `{{schedule.scheduledTime}}` | schedule |

### Conditions

Optional array of rules that ALL must match for the hook to fire:

```json
{
  "conditions": [
    { "field": "message.content", "operator": "contains", "value": "deploy" },
    { "field": "message.channelType", "operator": "equals", "value": "telegram" }
  ]
}
```

Operators: `equals`, `contains`, `matches` (regex), `gt`, `lt`, `in` (array).

### Execution Control

| Field | Purpose |
|-------|---------|
| `isEnabled` | Toggle hook on/off |
| `priority` | Higher priority hooks run first (default: 0) |
| `maxExecutions` | Stop after N runs (null = unlimited) |
| `cooldownMs` | Minimum ms between executions (default: 0) |

### Example Configurations

**GitHub push handler via inbound webhook:**
```json
{
  "name": "GitHub Push Handler",
  "trigger": "webhook",
  "triggerConfig": {
    "webhookSecret": "my-secret-123",
    "messageTemplate": "New push to {{body.repository.name}} by {{body.pusher.name}}: {{body.head_commit.message}}"
  },
  "action": "notify",
  "actionConfig": {
    "channelType": "telegram",
    "channelId": "123456789"
  }
}
```

**Notify on agent failure:**
```json
{
  "name": "Error alert",
  "trigger": "agent_failed",
  "triggerConfig": {},
  "action": "notify",
  "actionConfig": {
    "notifyChannels": ["telegram:123456789"],
    "notifyMessage": "Agent failed on topic '{{agent.topic}}'"
  }
}
```

**Scheduled daily check:**
```json
{
  "name": "Morning email check",
  "trigger": "schedule",
  "triggerConfig": { "cronExpression": "0 9 * * *", "timezone": "Europe/Berlin" },
  "action": "spawn_agent",
  "actionConfig": {
    "agentPrompt": "Check Gmail for unread emails and summarize.",
    "orchestrated": true
  }
}
```

## Inbound Webhooks

External services can trigger hooks by POSTing to `/api/hooks/incoming/:hookId`. This enables GitHub, Stripe, smart home sensors, n8n, and any HTTP-capable service to drive agent actions.

### Setup

1. Create a hook with `trigger: "webhook"` via the API or UI
2. Set `triggerConfig.webhookSecret` for authentication
3. Optionally set `triggerConfig.messageTemplate` for payload transformation
4. Configure the external service to POST to `https://your-host/api/hooks/incoming/<hook-uuid>`

### Authentication

Every request must include the webhook secret via one of:
- `Authorization: Bearer <secret>` header
- `X-Webhook-Secret: <secret>` header

Requests without valid secrets are rejected with 401.

### Payload Templating

Use Mustache-style `{{path.to.value}}` syntax to transform incoming JSON payloads into agent prompts:

```json
{
  "messageTemplate": "Push to {{body.repository.name}} by {{body.pusher.name}}: {{body.head_commit.message}}"
}
```

If no template is provided, the raw JSON payload is forwarded to the agent.

### Delivery

Results can be routed to a channel via `actionConfig`:
- `channelType` + `channelId` — direct delivery (e.g., `telegram` + `123456789`)
- `notifyChannels[]` — standard multi-channel delivery

### Example: GitHub → Telegram

```bash
# 1. Create the webhook hook
curl -X POST https://your-host/api/hooks \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "GitHub Push Alert",
    "trigger": "webhook",
    "triggerConfig": {
      "webhookSecret": "gh-secret-123",
      "messageTemplate": "Push to {{body.repository.name}} by {{body.pusher.name}}"
    },
    "action": "notify",
    "actionConfig": { "channelType": "telegram", "channelId": "123456789" }
  }'

# 2. Configure GitHub webhook to POST to:
# https://your-host/api/hooks/incoming/<returned-hook-uuid>
# with secret: gh-secret-123
```

## Scheduled Tasks

A scheduled task is a hook with `trigger: "schedule"`. The cron runner checks every 60 seconds for due hooks and executes them. In the UI, these appear under the "Scheduled Tasks" tab.

### Schedule Types

**Recurring (cron):** Runs on a repeating schedule using cron expressions. The schedule picker offers presets, interval, daily, weekly, and raw cron modes.

**One-time (datetime):** Runs exactly once at a specific date and time, then auto-disables. Set `triggerConfig.scheduledAt` instead of `cronExpression`. In the UI, use the "Date & Time" tab in the schedule picker.

### Calendar View

The **Calendar tab** in the Hooks & Tasks page shows a weekly grid of scheduled tasks:
- **Recurring tasks** appear on their next run day (green)
- **Datetime tasks** appear on their exact scheduled day (blue)
- Navigate weeks with arrow buttons, "Today" resets to current week
- Server timezone is displayed for reference

### Schedule-Specific Fields

| Field | Purpose |
|-------|---------|
| `triggerConfig.cronExpression` | Cron schedule (for recurring tasks) |
| `triggerConfig.scheduledAt` | ISO 8601 datetime (for one-time tasks) |
| `triggerConfig.timezone` | Timezone (default: UTC) |
| `nextRunAt` | Computed next execution time |
| `lastError` | Last execution error (null on success) |

### Cron Expression Format

```
* * * * *
│ │ │ │ │
│ │ │ │ └── Day of week
│ │ │ └──── Month
│ │ └────── Day of month
│ └──────── Hour
└────────── Minute

*/5 * * * *     Every 5 minutes
0 * * * *       Every hour at :00
0 9 * * *       Daily at 9:00 AM
0 */2 * * *     Every 2 hours
0 9 * * 1-5     Weekdays at 9:00 AM
```

### Away digest in a hook prompt

A `spawn_agent` hook may set `actionConfig.awayDigestHours` (a positive
number). Before the run, the owner's "while you were away" digest for that
many hours (`src/core/digest/away.ts`: finished and failed agents, pipelines
finished or waiting, pending approvals, new to-dos, unread count) is rendered
as markdown and prepended to `agentPrompt`. No model call is spent on it, and
a digest that cannot be built is logged and skipped rather than failing the
hook.

### Daily Briefing (seeded)

Every user gets one scheduled hook at registration, **Daily Briefing**: weekdays
at 08:00 (UTC by default), an orchestrated `spawn_agent` turn whose result is
delivered to the user. The prompt is integration-agnostic — it always reads the
to-do list and notifications, and only reads calendar / mail / GitHub when those
tools are connected, finishing with the three actions to take first. It is an
ordinary hook: edit the schedule or timezone, pause it, or delete it on the
Hooks page. It costs one agent turn per weekday.

Users who registered before it existed, or who paused it, can bring it back:

```bash
curl -X POST localhost:3005/api/hooks/briefing -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"timezone":"Europe/Berlin"}'
curl -X DELETE localhost:3005/api/hooks/briefing -H "Authorization: Bearer $TOKEN"   # pause
```

Code: `src/core/briefing.ts`. The heartbeat ([HEARTBEAT.md](./HEARTBEAT.md)) is
the complementary loop — silent unless something is pending, off by default.

### Task Status (derived)

| Status | Condition |
|--------|-----------|
| `active` | `isEnabled` and no `lastError` |
| `paused` | `!isEnabled` |
| `error` | `lastError` is set — check execution log for details |

## Execution Log

Every hook and recurring task execution is recorded in the `hook_executions` table. View logs in the UI under Hooks > Execution Log tab.

Each log entry contains:
- **source**: `hook` or `manual_test`
- **status**: `success`, `error`, or `skipped`
- **triggerType / actionType**: what fired and what ran
- **result**: full action output (JSON)
- **error**: error message if failed
- **durationMs**: execution time
- **triggerContext**: sanitized snapshot of what triggered the hook

### Debugging Hooks

1. Go to Hooks page > click the history icon on the hook row
2. Or switch to "Execution Log" tab for all executions
3. Expand an entry to see full result/error and trigger context
4. If no executions appear, verify:
   - Hook is enabled
   - Trigger config matches (channel types, patterns, webhook path)
   - Conditions aren't filtering everything out
   - Cooldown hasn't blocked it
   - Max executions hasn't been reached

## API Endpoints

### Hooks

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/hooks` | List user's hooks |
| POST | `/api/hooks` | Create hook |
| GET | `/api/hooks/:id` | Get hook |
| PATCH | `/api/hooks/:id` | Update hook |
| DELETE | `/api/hooks/:id` | Delete hook |
| POST | `/api/hooks/:id/toggle` | Enable/disable |
| POST | `/api/hooks/:id/test` | Trigger manually |
| GET | `/api/hooks/:id/executions` | Execution history for hook |
| GET | `/api/hooks/executions/all` | All user executions |
| GET | `/api/hooks/suggestions` | Suggested hooks |
| POST | `/api/hooks/suggestions/:id/apply` | Apply suggestion |
| POST | `/api/hooks/briefing` | Ensure (create / re-enable) the seeded Daily Briefing; optional `timezone`, `cronExpression` |
| DELETE | `/api/hooks/briefing` | Pause the Daily Briefing |

### Recurring Tasks (compatibility)

The `/api/recurring-tasks` endpoints still work as a compatibility layer — they map to schedule-triggered hooks internally.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/recurring-tasks` | List schedule hooks |
| POST | `/api/recurring-tasks` | Create schedule hook |
| GET | `/api/recurring-tasks/:id` | Get schedule hook |
| PATCH | `/api/recurring-tasks/:id` | Update schedule hook |
| GET | `/api/recurring-tasks/:id/executions` | Execution history |
| DELETE | `/api/recurring-tasks/:id` | Delete schedule hook |

## Swarm Lifecycle Events

The swarm root agent (Root agent → Agent → Subagent) publishes its own gateway event family (`swarm.*`) alongside the older `agent.*` events. These are pure observability signals — they are **not** hook triggers today (the hook system matches on `agent_*` triggers, which still fire for every swarm node because every node is also an agent). If you need to react to swarm-specific state — fan-out breach, cycle blocks, budget warnings — subscribe on the gateway instead of the hook system.

| Event | When it fires |
|-------|---------------|
| `swarm.node_spawned` | A new Root agent / Agent / Subagent is created. Payload includes `rootSessionId`, `nodeId`, `parentNodeId`, `kind`, `depth`, `topicPath`, `role`, `expertId`, `model`, `budgets`, `taskBriefPreview`. |
| `swarm.node_completed` | Node finished; `ChildResult` is attached (status + output + usedTokens + durationMs). |
| `swarm.budget_warning` | Node crossed its budget warning threshold. |
| `swarm.call_graph_cycle_blocked` | Duplicate / ancestor-chain fingerprint rejected a spawn. |

All `swarm.*` events participate in the gateway replay buffer (`swarm.*` pattern); subscribers can catch up after reconnect.

Wake-gate: scheduled hooks can carry a `wakeGate` (`command` / `http` / `tool`) evaluated just-before-run. A failing gate emits `skipped_by_wakegate` and skips execution.
