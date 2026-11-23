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
| `spawn_agent` | Start an AI agent | `agentPrompt`, `agentTopic`, `agentModel`, `orchestrated`, `projectPath` |
| `webhook` | Send outgoing HTTP request | `webhookUrl`, `webhookMethod`, `webhookHeaders`, `webhookBody` |
| `n8n_workflow` | Trigger N8N workflow | `workflowId`, `workflowData` |
| `execute_tool` | Run a registered tool | `toolId`, `toolAction`, `toolParams` |

### Agent Action — Project Folder

For an agent action, **Project folder** in the create/edit form selects an
absolute folder on its execution environment. It is owner configuration, not a
webhook template. Folder grants and environment revocation still apply. The
folder and environment are saved on the session and passed to direct workers,
including new per-thread sessions. A missing local folder fails instead of
running in a different project. Leave it empty to retain the session's existing
project or use the environment default.

### Notify Action — Channel Format

`notifyChannels` uses format `type:channelId`:

```
telegram:123456789        # Telegram chat ID
slack:C0123ABCDEF         # Slack channel ID
webchat:<your-user-id>    # Your own web chat (all your open web chat connections)
teams:channel-id          # Microsoft Teams conversation
```

The type is split on the first colon, so Teams ids that contain colons work as-is. `actionConfig.notifyOwner: true` ("Notify me") sends to every external chat linked to the hook owner instead of naming targets.

To find your Telegram chat ID: send any message to the bot and check backend logs (`~/.octipus/backend.log`).

Not every chat id is accepted: see [Who a hook may notify](#who-a-hook-may-notify).

### Who a hook may notify

Hooks, scheduled tasks, monitors, notifications and agent tools send on behalf of a user, so the bot only messages chats that user may notify. The rule lives in `src/channels/ownership.ts` and is applied to every outbound send: a notify hook's `notifyChannels` / `channelType` + `channelId`, a notification's `deliverTo`, a monitor's reply, and the `messaging` tool.

A target (`channelType`, `channelId`) is allowed when it is one of:

- **Your own linked chat, always.** A chat verified to your account (see [Account Linking](CHANNELS.md#account-linking)), or your 1:1 conversation with the bot on that identity: a Teams personal chat or a Slack DM (`D…`) whose user is you.
- **An admin-approved shared destination.** Shared channels and groups (a Slack `#alerts` channel, a Telegram group, a Teams channel or group chat) are allowed only when an admin has listed them under **Admin → Notification destinations**, either for everyone or for an org you are a member of.

Anything else is refused with: `<type>:<id> is not linked to you and not an approved shared destination; ask an admin to add it under Admin → Notification destinations`. Only `telegram`, `slack`, `teams` and `whatsapp` have outbound chat ids; any other channel type (apart from `webchat` / `api`, below) is never a target.

**When targets are checked.**

- On save: `POST /api/hooks`, `PATCH /api/hooks/:id`, applying a hook suggestion, and `POST /api/recurring-tasks` return `400` naming each rejected target. An edit only checks targets that are new compared with the stored config, so a hook already holding a now-invalid target stays editable.
- On send: a notify hook skips each target that is not allowed and logs a warning with the hook id; the other targets still receive the message. If no target is left, the execution fails with the refusal message. Removing a destination in the admin page therefore makes hooks that target it stop sending there.

**Existing hooks with targets that are no longer allowed** (saved before this check, or whose chat was unlinked or whose destination was removed):

- `GET /api/hooks` and `GET /api/hooks/:id` return `invalidTargets`, a list of `type:id` strings. The hooks page shows it as an "N invalid target(s)" badge; its tooltip lists the targets that are skipped when the hook runs.
- At startup the server logs one warning with, per user, the number of affected hooks and targets (`Hooks with notification targets their owner may no longer send to ...`). Only `notify` and `execute_tool` hooks are scanned.

To fix a flagged hook, replace the target with one of your own linked chats, or ask an admin to approve it.

**Web chat and API targets.** `webchat` and `api` address the in-app surfaces. The only valid target is your own user id, `webchat:<your-user-id>`, which is delivered to all of your live web chat connections. Raw web chat connection ids and any other user's id are refused. Migration `0117_hook_inapp_targets` rewrote stored `webchat:<connection id>` and `api:<anything>` targets (in `notifyChannels` and in `channelType` + `channelId`) to `webchat:<owner id>`.

**Teams.** A proactive Teams send needs a conversation reference, which Teams only provides when a message arrives from that conversation. References are persisted (`kv_store`, key `teams:convref:<id>`) and reloaded after a restart. A Teams target the bot has never seen resolves as "unresolved" rather than "not linked": `the Teams conversation cannot be resolved yet; the user must message the bot in Teams once`. Your own Teams identity (the id stored when you linked Teams) is delivered to your 1:1 conversation(s) with the bot. Teams channels and group chats need an approved destination.

**Monitors and sessions.** A monitor replies to its session's chat only if the monitor's owner may notify that chat; otherwise nothing is sent and the delivery fails with the same error. `POST /api/sessions` only creates a session on an external channel (`telegram`, `slack`, `teams`, `whatsapp`) whose chat the caller may notify; other session types are accepted as before. `PATCH /api/sessions/:id` only updates `title`, `status`, `context` and `metadata`, so a session's chat cannot be changed after creation.

#### Adding a shared destination

Admins manage the allowlist at **Admin → Notification destinations** (`/admin/destinations`):

1. **Channel**: `telegram`, `slack`, `teams` or `whatsapp`.
2. **Channel / chat id**: the id exactly as a hook would name it after the colon, e.g. `C0123ALERTS` for `slack:C0123ALERTS`.
3. **Label** (optional): a display name such as `#alerts`.
4. **For**: `everyone` approves the destination for every user on the instance (stored with no org). Choosing an org approves it only for that org's members. The org list appears only when organizations are enabled; otherwise `everyone` is the only choice.

The same (channel, id, org) can be listed once; adding it again returns `409`. The trash icon removes a destination. Additions and removals are recorded in the audit log (`settings_changed`, resource type `notification_destination`).

The page uses these admin-only endpoints (stored in the `notification_destinations` table, migration `0116`):

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/notification-destinations` | List destinations and the allowed `channelTypes` |
| POST | `/api/admin/notification-destinations` | Add `{ channelType, channelId, label?, orgId? }`; `orgId` omitted or `null` means everyone. `400` for an unknown channel type, `404` for an unknown org, `409` if already listed |
| DELETE | `/api/admin/notification-destinations/:id` | Remove a destination |

#### Messaging tool: `send_message` and `send_to_user`

The same rule applies when an agent (or an `execute_tool` hook or task) uses the `messaging` tool:

- **`send_message`** (`channel`, `target`, `message`): the target must be one of your own linked chats, `webchat:<your-user-id>`, or an approved shared destination. This is enforced on every call, attended or not; approving the tool's permission prompt (or "always allow") does not widen it.
- **`send_to_user`** (`user_id`, `message`, optional `channel`): sends to the recipient's own verified linked chats. You may target only yourself. An admin may target another user only from an attended run that can prompt a human; unattended runs (cron, heartbeat, message hooks, `execute_tool`) may only target the calling user, admin or not.

When an `execute_tool` hook or a recurring task names the messaging tool with literal values, they are checked at save time: a `send_message` `channel` + `target` must pass the rule above, and a `send_to_user` `user_id` must be your own id (`A send_to_user hook can only message you`). Values containing `{{...}}` templates are only known at run time and are checked by the tool when it runs.

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

Both follow [Who a hook may notify](#who-a-hook-may-notify).

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
| `triggerConfig.watch` | Sources whose unchanged state skips a run (see [Watch](#watch-skip-unchanged-runs)) |
| `nextRunAt` | Computed next execution time |
| `lastError` | Last execution error (null on success) |

### A failed run tells you

When a scheduled hook's action fails — an orchestrated agent turn that
errors, is cancelled or is refused (no model, session budget spent, input
guard), a notify that reached no channel, a webhook that answered with an
error — the cron runner sets `lastError` and posts a `schedule_failed`
notification: `Scheduled task "<name>" failed`, with the first 280
characters of the error. A missing summary never goes unnoticed, and a
schedule that keeps failing does not repeat it: only the failure that sets
`lastError` from empty notifies (one atomic update, so two overlapping runs
cannot both), and the next success clears it. A run the hook's own gates
decline (cooldown, max executions, conditions, deactivated owner) clears
`lastError`, as before. The notification is in-app (and pushed to the web
client); it is not sent to chat channels, where a hook with "send result to
my linked channels" has already delivered the turn's answer. A direct (non-orchestrated) `spawn_agent` run reports success
when the agent starts, so its later failure is reported by the agent's own
`agent_error` notification instead.

A run refused before any agent started — the server at its concurrent-agent
limit (`maxConcurrentAgents`), or, for a direct spawn, a quota or paused spend
budget — is not a failure of the schedule. `lastError` is set to
`Not started: <reason>`. A one-shot is retried (1 minute backing off to 1
hour, for 24 hours after its time) and tells you, with a `schedule_failed`
notification titled `Scheduled task "<name>" did not start`, only if it gives
up. A recurring schedule does not retry that run, so the first refusal of a
streak tells you the same way, and it runs again at its next time. A
`Not started` marker does not count as a failure streak: if a later run
starts and fails, that failure notifies as usual.

### Watch: skip unchanged runs

A recurring schedule whose action is an orchestrated `spawn_agent` turn may
name the sources it depends on in `triggerConfig.watch` (at most 5). Before
each scheduled run the cron runner reads them **without a model call** and
hashes the observations, together with the hook's action config, into a
fingerprint (`src/hooks/schedule-watch.ts`). The run is **skipped** only when

1. every source was read,
2. the fingerprint equals the one the previous run recorded, and
3. that previous run confirmed success (the turn reported `outcome:
   "success"`; a refusal or a command's answer does not).

The fingerprint a successful run records is probed **after** the run
finished, so what the run itself wrote to a watched source (a report it
rewrote, a task it closed) does not count as a change next time. The flip
side: a change someone else made while the run was in progress is absorbed
into that baseline too.

A skipped run starts no agent and spends no tokens; it is recorded in the
execution log as `status: "skipped"` with `result.reason: "unchanged"`, does
not touch `lastError`, and is not a failure. The hook's own gates
(cooldown, max executions, conditions, deactivated owner) are checked first:
a hook that would not fire is neither probed nor logged. Otherwise the run
goes ahead as before. The first run, a run after a failed, refused or
interrupted one, a run while another is still in progress, and a run after
an edit of the prompt or the watch list always run. Each run is marked
`running` under its own run id when it starts and records its outcome only
if no later run has started since (compare-and-set), so an older
overlapping run never overwrites a newer one.

```json
{
  "trigger": "schedule",
  "triggerConfig": {
    "cronExpression": "*/30 * * * *",
    "watch": [
      { "kind": "url", "url": "https://status.example.com" },
      { "kind": "file", "path": "reports/today.md" },
      { "kind": "tasks" }
    ]
  },
  "action": "spawn_agent",
  "actionConfig": { "orchestrated": true, "agentPrompt": "Tell me what changed and what needs me." }
}
```

| `kind` | Reads | Probe |
|--------|-------|-------|
| `url` (`url`) | A public HTML page: the hash of its extracted article text | The plugin host's `web:read` fetch (`src/core/web-read/fetch.ts`): SSRF-guarded, HTML only, 5 MB cap |
| `file` (`path`) | A file (content hash up to 5 MB, else size + modification time) or a directory (its entries' names, sizes and times, not recursive, at most 1000) in the owner's workspace; a missing path is an observation | `WorkspaceFS` path resolution: relative to the workspace, nothing outside it |
| `tasks` | The owner's personal task board: count and latest update | One database query |
| `inbox` | The ids of recent inbox mail (the last 3 days, Gmail's bulk tabs excluded) | The heartbeat's inbox probe (`src/core/email/watch.ts`); needs the `inbox` module and a connected mailbox |
| `github_prs` | Open pull requests by the token's user whose checks are failing | The heartbeat's GitHub probe (the server's `gh`); admins only, a DENY on `github/read` wins |

In the web editor this is the **Watch** list of a recurring agent schedule:
one source per line (`url https://…`, `file reports/today.md`, `tasks`,
`inbox`, `github_prs`). **Run now** (the test button) always runs.

**Unavailable is never unchanged.** A source that errors, times out (20 s;
the fetch, mail request or `gh` process is aborted), is switched off or not
connected makes the run go ahead, and that run leaves
no fingerprint to compare the next one with. The last-run state
(`triggerConfig.watchState`: fingerprint, `running` / `success` / `failed` /
`unconfirmed`, run id) is written only by the server; the API drops a value
sent by a client. Editing only the action of a hook whose stored watch it can
no longer carry (turning off "Route through rootAgent", say) is refused with
"remove `watch`"; a hook whose stored watch was already ineligible stays
editable.

What this does not cover:

- Only recurring, orchestrated `spawn_agent` schedules can watch. A reminder
  (`notify`), a digest (`awayDigestHours`), a one-shot (`scheduledAt`), a
  heartbeat and a direct spawn are refused by the API and, if written around
  it, run every time anyway.
- A skip is decided on what the probes see, not on what the agent would read:
  a prompt that also depends on something not watched (the calendar, the
  date, another site) misses those changes. Watch only what the run is about.
- Pages that render their content with JavaScript, or change their text on
  every request, read as changed (or never as changed) accordingly; there is
  no selector. Directories are not watched recursively.
- Two probes per successful run (before and after) — cheap, but the URL and
  inbox sources are read twice.
- The inbox window slides: a message ageing out of the last 3 days changes the
  fingerprint and causes one extra run, never a missed one.
- No new integrations: only sources that already had a cheap, model-free
  probe are offered (no calendar change marker exists, so there is no
  `calendar` kind).

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
- **status**: `success`, `error`, or `skipped` (a watched schedule whose sources did not change: `result.reason` is `unchanged`; the UI shows "skipped — unchanged")
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
| POST | `/api/hooks/suggestions/:suggestionId/apply` | Apply suggestion |
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
| `swarm.node_spawned` | A new Root agent / Agent / Subagent is created. Payload includes `rootSessionId`, `nodeId`, `parentNodeId`, `kind`, `depth`, `topicPath`, `role`, `model`, `budgets`, and `taskBriefPreview`. The legacy `expertId` field may still be present for wire compatibility but is currently null after the expert layer was retired. |
| `swarm.node_completed` | Node finished; `ChildResult` is attached (status + output + usedTokens + durationMs). |
| `swarm.budget_warning` | Node crossed its budget warning threshold. |
| `swarm.call_graph_cycle_blocked` | Duplicate / ancestor-chain fingerprint rejected a spawn. |

All `swarm.*` events participate in the gateway replay buffer (`swarm.*` pattern); subscribers can catch up after reconnect.

Wake-gate: scheduled hooks can carry a `wakeGate` (`command` / `http` / `tool`) evaluated just-before-run. A failing gate emits `skipped_by_wakegate` and skips execution.
