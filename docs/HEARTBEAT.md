# Heartbeat

The heartbeat is a periodic, per-user agent turn that reviews standing context
(due tasks, unread notifications) against your standing instructions, then
**acts or stays silent**. It's Octipus's proactive loop — the assistant checking
in on its own, adapted to a multi-user platform with per-user gating, quotas,
and quiet hours.

**Off by default.** Nothing runs until you enable it globally *and* a user opts
in. The one proactive turn that IS on by default is the seeded weekday
**Daily Briefing** hook — see [HOOKS.md](./HOOKS.md#daily-briefing-seeded).

## How it works

Every 60s cron tick, `maybeRunHeartbeats` (`src/core/heartbeat.ts`) processes
each user's due heartbeat hook through a **cheap-first gate** — no LLM tokens are
spent until the last step:

1. **Global switch** — `config.heartbeat.enabled` off ⇒ skip.
2. **Quiet hours** — current hour in `[quietHoursStart, quietHoursEnd)`
   (evaluated in `quietHoursTimezone`, wraps midnight) ⇒ skip.
3. **Daily cap** — user already hit `maxRunsPerDay` today ⇒ skip.
4. **Quota** — user is out of their daily token budget ⇒ skip.
5. **Pending-work probe** — any **due open tasks** (`due_at ≤ now`) or
   **unread notifications** (both DB-only), plus two external sources that
   each run only when enabled and fail soft to "nothing": **open pull
   requests of yours whose checks are failing** (one `gh api graphql` search
   across every repo the CLI can see; silently empty when `gh` is not
   installed or authenticated) and **calendar events starting within the
   lookahead window** on a connected Google or Microsoft calendar (one
   request per connected provider). Nothing in any of the four ⇒ skip.

   Two rules keep those sources honest. The server's `gh` identity belongs
   to whoever authenticated it — the operator — so the GitHub probe runs
   **only for admin users** (and a stored DENY on `github/read` still
   wins); a per-user GitHub credential is enterprise-track work. And a red
   PR or a meeting has no "done" a user can click, so each hook remembers
   what it already surfaced (`triggerConfig.heartbeatSeen`) and only a NEW
   item wakes it; the set is pruned to what the latest probe still sees, so
   a PR that went green and red again counts as new. A source that could
   not be read on a tick (gh timed out, a calendar returned 5xx) keeps its
   previous set rather than pruning it — "could not read" is not "cleared".
   The pruning happens only when the probe runs: an item that clears and
   returns with the same state entirely inside quiet hours or after the
   daily cap is not re-surfaced, a trade-off taken so those skips stay free.
   One `gh` search is shared by every due hook on a tick, and gates run
   four at a time.

Only a non-empty probe spawns an orchestrated turn on the **`heartbeat`
channel** (so the run is tagged `origin='heartbeat'` for audit), seeded with the
pending checklist plus your standing instructions. **Silence is the default:** an
empty probe costs zero tokens.

## Standing instructions — the `HEARTBEAT` note

Your standing orders live in a single pinned note with slug `heartbeat` (reusing
the notes tool/table — no new schema). Whatever you write there is prepended to
every heartbeat turn. Example:

```
# HEARTBEAT

- If a task is overdue by more than a day, draft a plan and notify me.
- Summarize unread GitHub notifications; only ping me for failing CI on my PRs.
- Never send outbound messages without my approval.
```

Create/update it like any note (`write_note` with `slug: "heartbeat"`), then pin
it. If the note is absent, the heartbeat still runs on the probe findings alone.

## Enabling

**Globally** (operator) — set in DB settings or via env:

```
HEARTBEAT_ENABLED=true
HEARTBEAT_INTERVAL_MINUTES=60
HEARTBEAT_QUIET_HOURS_START=22
HEARTBEAT_QUIET_HOURS_END=7
HEARTBEAT_QUIET_HOURS_TZ=America/New_York
HEARTBEAT_MAX_RUNS_PER_DAY=24
```

**Per user** — call `ensureHeartbeatHook(userId)` (a settings toggle wires to
this). It creates one enabled `trigger='heartbeat'` hook, idempotently.
`disableHeartbeatHook(userId)` turns it back off. The global switch still gates
whether any user's hook actually runs.

## Config reference

| Setting | Default | Meaning |
|---|---|---|
| `heartbeat.enabled` | `false` | Master switch. |
| `heartbeat.intervalMinutes` | `60` | Minutes between runs per user (5–1440). |
| `heartbeat.quietHoursStart` / `End` | `22` / `7` | No runs in `[start, end)`; equal = disabled. |
| `heartbeat.quietHoursTimezone` | `UTC` | IANA tz for quiet hours + the daily-cap day boundary. |
| `heartbeat.maxRunsPerDay` | `24` | Hard per-user daily cap (1–288). |
| `heartbeat.probeGithub` | `true` | Wake for your open PRs with failing checks (`HEARTBEAT_PROBE_GITHUB`). |
| `heartbeat.probeCalendar` | `true` | Wake for calendar events about to start (`HEARTBEAT_PROBE_CALENDAR`). |
| `heartbeat.calendarLookaheadMinutes` | `60` | How far ahead the calendar probe looks (5–1440; `HEARTBEAT_CALENDAR_LOOKAHEAD_MINUTES`). |

## Safety rails

- **Cheap-first gate** — quiet hours, daily cap, and quota are checked before the
  DB probe; the probe is checked before any LLM turn.
- **No duplicate fires** — `next_run_at` is advanced *before* the (possibly
  long) turn starts.
- **Auditability** — heartbeat runs carry `origin='heartbeat'` in the ambient
  `RunContext` (and `channel='heartbeat'` in trajectories).
- **Kill switch** — disable the hook (`disableHeartbeatHook`) or flip
  `heartbeat.enabled` off.

## Not yet wired (follow-ups)

- A first-class **goals** object — standing instructions are a pinned note for
  now (deliberate; schema can follow usage).
- Settings-page UI toggle (the backend `ensureHeartbeatHook` /
  `disableHeartbeatHook` + `heartbeat.*` settings are in place for it).
