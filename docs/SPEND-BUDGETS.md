# Spend Budgets

A spend budget is a US-dollar cap on what a user's agents may spend over a UTC
day or a UTC month. At a warn percentage (80% by default) the user is notified
once; at 100% their agents are paused, and every new agent run is refused until
the period rolls over or an admin raises the limit.

Budgets are off until an admin sets one. A user with no budget is not capped by
cost. Enforcement lives in `src/security/spend-budgets.ts`; the table is
`spend_budgets` (migration `0114_spend_budgets.sql`).

## What a budget is

Every budget belongs to one user and is identified by (user, scope, period).
Saving a budget with the same user, scope and period replaces the existing one.

| Scope | `scopeRef` | Counts |
|---|---|---|
| `user` | none | every `cost_log` row of the user ("All agents") |
| `role` | role name, trimmed | the user's rows whose agent has that role |
| `workspace` | workspace id (UUID, lowercased) | the user's rows attributed to that workspace |

A role or workspace budget narrows one user's spend; it is not shared across
the users of that role or workspace.

| Field | Meaning |
|---|---|
| `period` | `day` or `month`, both in UTC |
| `limitUsd` | the cap, a positive number |
| `warnRatio` | fraction of the limit at which to warn, in (0, 1]; default 0.8 |

A user can have several budgets, for example a monthly user budget plus a daily
budget on one role. Each applicable budget is checked, and any one at its limit
refuses the run.

## How spend is measured

Spend is `SUM(cost_log.total_cost)` since the start of the current period. The
same query drives enforcement and every screen, so a figure shown on a card is
the figure the pause acts on.

Workspace attribution uses the agent's workspace, falling back to the session's
workspace for rows without an agent. `cost_log` has no workspace column, so rows
with neither count toward the user scope only, and a workspace budget can
under-count them.

Cost is only as good as what the provider reports. Each `cost_log` row carries
a `costSource` (`src/db/cost-source.ts`):

- `reported`: USD from the provider.
- `estimated`: USD computed from model pricing. Rows without a source predate
  the field and are treated as estimates.
- `unknown`: CLI and subscription providers that report no cost. These calls
  are logged at $0.

The budget views report the estimated part of the spend and the number of
unmeasured calls. When there are unmeasured calls this period, the meter says
they "count as $0 — real spend may be higher". A budget does not block on
unknown cost; it simply under-counts work done through those providers.

## Enforcement

`checkSpend` runs before an invocation:

- when an agent is spawned (`agent-manager`);
- before each LLM call in an agent worker;
- before a CLI agent starts;
- on each heartbeat tick. The tick checks only the user scope; role and
  workspace budgets are enforced when the tick's turn spawns its agents.

The check happens before a call, not during it, so the call that crosses the
limit completes and the next check refuses.

System and local principals (non-UUID user ids) have no budgets.

Budget rows and spend sums are cached in-process for 30 seconds. Another process
may therefore see a change (a new limit, a cleared pause) up to 30 seconds late.
A pause is never missed: a stale row still sees spend at or over the limit.

## Warn and pause

| State | When | What happens |
|---|---|---|
| `ok` | below the warn ratio | nothing |
| `warned` | spend >= limit x `warnRatio` | one `spend_budget_warning` notification per period; amber banner |
| `paused` | spend >= limit, or a pause stamped this period | one `spend_budget_paused` notification per period; runs refused; red banner |

The warning and the pause are each recorded with a timestamp (`warned_at`,
`paused_at`) claimed by a conditional update, so each notifies once per period
even with several processes running. Notifications are created only by a real
check (an agent run), never by reading the budget.

A refused run is not reported as a stop or a generic error. The agent row is
marked failed with `failureReason` `spend_budget`, and the chat reply names the
budget, the limit, the spend and the reset time, for example: "Agents are
paused: your monthly spend budget of $25.00/month is reached ($25.40 spent this
month). It resets 2026-10-01 00:00 UTC. Ask an admin to raise the limit."

## Reset

The stamps are compared against the current period start, so a stamp from an
earlier period has no effect. A budget rolls over on its own at 00:00 UTC (daily)
or 00:00 UTC on the first of the month (monthly), with no job involved. The
`resetsAt` field in the API is the start of the next period.

## Managing budgets (admins)

Admins manage budgets at `/admin/quotas`, the "Quotas & budgets" tab, in the
Spend budgets section below the quota table. Pick a user from the dropdown, or
use the wallet button on that user's quota row.

- **Add.** "Add budget" opens a form: scope (all of the user's agents, one
  agent role, or one workspace the user owns), period (per UTC day or month),
  limit in USD, and warn % (default 80).
- **Edit.** Only the limit and warn % can change; scope and period identify the
  budget, so to change them add a new budget and delete the old one. Saving
  clears any warning and pause; the new limit is checked on the next agent run,
  which pauses again if spend is still over it.
- **Delete.** Removes the budget after a confirm.
- **Resume.** Shown on a paused budget. It clears the pause only. It helps once
  spend is back under the limit (costs corrected, or the limit raised);
  otherwise the next agent run pauses the budget again. When spend is still at
  or over the limit the section says so and suggests raising the limit with
  Edit instead, since saving also clears the pause.

Every change is written to the audit log as `settings_changed` with resource
type `spend_budget`.

## What users see

- **Banner.** At the top of the app, polling `/api/spend-budgets/me` every 60
  seconds. It is red when a budget is paused. A user-scope pause, or a pause of
  the workspace currently active, cannot be dismissed. A role pause or another
  workspace's pause can be dismissed for the browser session. It is amber when a
  budget is at its warn ratio, and dismissible for the session; a new warning
  or a new period shows it again. Both link to the budgets card.
- **Dashboard card.** A read-only "Spend budgets" card at `/#budgets`: for each
  budget, spend against the limit with a mark at the warn ratio, a state badge,
  the reset time in local time, and the estimated / unmeasured note. With no
  budget it says agents are not capped by cost.
- **Notifications.** The inbox at `/notifications` has a "budgets" filter.
  Budget notifications show an icon, a label ("budget warning" or "budget
  reached · agents paused"), the spend-versus-limit line and a link to the card.
  They are tinted only while unread.
- **Chat.** A refused turn renders a card, "Agents are paused — spend budget
  reached", with the budget, limit, spend, reset time and a link to the card.
  The refusal is saved with the message, so the card survives a reload.

## Quotas versus budgets

Both are per-user caps set on the same admin screen, but they are separate.

| | Quotas | Spend budgets |
|---|---|---|
| Measures | tokens per day, concurrent agents, API calls per minute | USD from `cost_log` |
| Error | `QuotaExceededError` (`QUOTA_EXCEEDED`) | `SpendBudgetExceededError` (`SPEND_BUDGET_EXCEEDED`) |
| Scope | the user | user, role or workspace, per day or month |
| Chat | "Quota reached" card | "Agents are paused" card |

Both are also distinct from an agent's own per-spawn `maxTokenBudget`.

## REST endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/spend-budgets/me` | The caller's budgets with this period's spend, state and reset time. Read-only. |
| GET | `/api/admin/spend-budgets` | Admin: all budget rows; with `?userId=`, also `statuses` (the same view the user sees). |
| PUT | `/api/admin/spend-budgets` | Admin: create or update by (user, scope, period); clears warning and pause. |
| DELETE | `/api/admin/spend-budgets/:id` | Admin: delete a budget. |
| POST | `/api/admin/spend-budgets/:id/resume` | Admin: clear a budget's pause. |
| GET | `/api/admin/users/:id/workspaces` | Admin: workspaces a user owns, for the workspace scope picker. |

The PUT body is `{ userId, scopeKind, scopeRef?, period, limitUsd, warnRatio? }`.
It returns 400 when `limitUsd` is not positive, `warnRatio` is outside (0, 1],
`scopeRef` is missing for a role or workspace budget, or a workspace `scopeRef`
is not a UUID; 404 when the user does not exist.
