# Heartbeat

Heartbeat is a background scheduler. Its checks do not start General, call a
model, create a chat session, or post a synthetic user message. It checks for
pending work and either records a notification, starts an actual assigned task,
or stays quiet.

## Personal checks

Enable **Settings → Heartbeat → Run my heartbeat**. Set your interval there and review the server quiet hours. An admin's enable action also starts the server heartbeat service;
a non-admin cannot override an operator-paused server. The roster and task board
show status and link to Settings, without introducing another switch.

Every cron tick, `maybeRunHeartbeats` checks due hooks. Quiet hours and the daily
cap apply before the probes. Probes cover:

- Due open tasks, plus undated tasks explicitly assigned to an agent role.
- Unread notifications, excluding routine `agent_complete` events and heartbeat's
  own digests. Actionable failures and approval notices remain visible.
- Your open pull requests with failing checks, when the GitHub probe is enabled.
- Meetings starting within the configured lookahead window.
- New mail, if **Watch my inbox** is on.

New findings produce an owner-only notification. Findings and their checkpoint
are committed in one database transaction. Merely recording a digest never marks
source notifications read, tasks complete, or email handled. Notification
checkpoints remember delivery; a burst larger than the per-check limit drains
in chronological order rather than being hidden behind the same unread items.
PRs and meetings are remembered until they clear. An unavailable source keeps
its previous checkpoint; unavailable does not mean empty.

The server's authenticated `gh` belongs to the operator, so the GitHub probe is
admin-only and honors a stored `github/read` denial. Calendar and email use the
owner's connected accounts. New findings are delivered to the local notification
service, without posting a chat or sending their content to external push relays.

## Actual task work

A ready task assigned to a registered role can start that role's worker, even
without a due date. Roles without an explicit configuration follow the personal
heartbeat. Any explicit role heartbeat owns its role: an enabled hook schedules
it separately; a disabled hook means paused and blocks personal fallback.
**Settings → Heartbeat** shows which roles follow the personal setting. Turning
one off saves an explicit pause, even if it never had its own hook.

Personal fallback handles one task at a time, highest priority then oldest. It
claims the task before routing, rereads current instructions and source
protection, and creates a server-owned `automation` execution context in the
task's workspace. This record supports tools, approvals and audit without being
a personal chat. No checklist conversation is created. Task workers use their
role's configured model and ordinary unattended permissions and budgets.

A worker needs `tasks/write` set to Allow to check out, comment on and complete
work. A missing grant is reported once, without spinning a model. Quiet hours,
the user-wide daily cap, token quota and spend budgets still gate actual work.
The check itself consumes no model tokens. Only personally owned tasks are
eligible; shared-space tasks are excluded. Active blockers, waiting children and
live checkouts prevent dispatch.

The parent hook lease excludes overlapping checks across server processes. It
is renewed during work; task claims are renewed too. Losing a task claim or hook
lease stops the affected worker and its descendants. An unfinished fallback task
is returned to its owner so it is not retried forever. Progress and results live
in task comments; completion is recorded only through actual task completion.

An explicitly configured role can work tasks through a pipeline template rather
than a single worker. Pipeline outcomes remain visible on the Pipelines page.

## Inbox watch

**Watch my inbox** reports new mail through notifications. It does not start a
mail-review agent, create tasks or reply drafts, send mail, or mark mail read.
Those actions require an explicit user request or a separately configured
workflow. This replaces the previous implicit General-agent mail check.

Mail before the watch was enabled is excluded, as are Gmail promotions, social
and forum categories. Only mail no agent/user has already handled is eligible.
The existing mail-watch ledger records `surfaced`, not `handled`. The settings
page's outcome history still shows actions performed by other inbox workflows.

## Standing instructions

Your personal note with slug `heartbeat` guides actual task workers. It does not
create work or start a model when the scheduler has no assigned task. Use it for
rules such as how to report progress or when to return work to you. Instructions
are guidance, not permission grants.

## Seeing what happened

**Agents → Triggers** shows heartbeat checks, handled findings or dispatched work,
skip reasons and the next check. `heartbeat_checks` stores IDs and counts, not
private task/mail text. Decisions are retained for 14 days. A successful personal
check may mean a notification was delivered; it does not imply an agent ran.
Worker and pipeline results must be inspected for acceptance evidence.

## Config reference

| Setting | Default | Meaning |
|---|---|---|
| `heartbeat.enabled` | `false` | Server service switch. |
| `heartbeat.intervalMinutes` | `60` | Default interval; users can select 5–1440 minutes. |
| `heartbeat.quietHoursStart` / `End` | `22` / `7` | Quiet interval; equal values disable quiet hours. |
| `heartbeat.quietHoursTimezone` | `UTC` | Timezone for quiet hours and the daily cap. |
| `heartbeat.maxRunsPerDay` | `24` | Per-user cap across handled personal checks and role runs. |
| `heartbeat.probeGithub` | `true` | Check the owner's failing pull requests. |
| `heartbeat.probeCalendar` | `true` | Check upcoming connected-calendar events. |
| `heartbeat.calendarLookaheadMinutes` | `60` | Calendar window, 5–1440 minutes. |
| `heartbeat.probeEmail` | `true` | Allow users to watch new mail. |

Preferences are `GET`/`PUT /api/heartbeat/me`; role overrides are
`GET`/`PUT /api/tasks/role-agents`. All controls live in Settings.
