# Tasks / TODOs (Personal)

> Design note, 2026-06-01. Feature #6 from `end-user-enrichment-plan.md`.
> A personal task list the **agent can read, create, and complete**. This is
> genuinely greenfield: `recurring_tasks` is cron *automation* and `task_state`
> is agent-internal *sibling discovery* — neither is a user todo list, and
> `web/app/tasks/page.tsx` currently just redirects to `/hooks`.

## What exists vs what's new
- **`recurring_tasks`** (schema): scheduled/cron automations (`status`:
  active/paused/error). NOT a personal todo. Leave as-is; reuse its scheduler
  for *reminders* only.
- **`task_state`** (schema): per-session agent output for sibling discovery.
  Unrelated; do not overload it.
- **NEW**: a `tasks` table + repo + API + a real `/tasks` page.

## Goal & non-goals
**Goal:** a simple, fast personal todo list (create, complete, due date,
priority, notes) that is **tenant-scoped** and **agent-integrated** — the agent
can add tasks ("remind me to email Bob", research/reader producing action
items), list "what's due today", and mark things done; chat & the work stream
can deep-link to a task.

**Non-goals:** projects/boards/kanban, subtasks/dependencies, collaboration/
assignment to others, calendar sync (that's the calendar tools' job; a task can
*reference* a calendar event but we don't rebuild CalDAV here).

## Data model
```
tasks (
  id uuid pk,
  userId uuid not null,          -- tenant scope (scoped repo enforces in SQL)
  title text not null,
  notes text,
  status text not null default 'open',   -- open | done | archived
  priority int not null default 0,        -- 0 none .. 3 high
  dueAt timestamptz,
  completedAt timestamptz,
  source text,                    -- 'user' | 'agent' | 'reader' | 'research' | 'email'
  sourceRef jsonb,                -- optional link back (sessionId, url, messageId…)
  createdAt, updatedAt
)
-- index on (userId, status, dueAt)
```
`source`/`sourceRef` are the differentiator: a task knows *where it came from*
(an agent turn, a reader action-item, an email triage) so the UI can link back.

## Tenancy & API
- **Scoped repo** following `src/db/repositories/scoped.ts` exactly — every
  query filtered by `principal.userId` in SQL; cross-tenant id lookups return
  null (the IDOR-safe pattern we already use for sessions/hooks). Admin-wide
  reads only via explicit `*Admin` methods.
- **REST** under `/api/tasks`: list (filter by status/due), create, update,
  toggle done, delete — TypeBox-validated bodies (the M14/M18 lesson: validate
  at the boundary, no `as any`).

## Agent integration (the point)
A new **`tasks` tool** (built-in, `src/tools/tasks/`) with `create_task`,
`list_tasks`, `complete_task`. Permission: `create`/`complete` default ASK (or
ALLOW for own tasks in single-user), `list` ALLOW (own tasks only). The tool
operates strictly on the calling user's tasks via the scoped repo. This lets:
- "remind me to renew the domain Friday" → `create_task`.
- Reader "extract action items" / Research "next steps" → batch `create_task`
  with `source` set.
- "what do I need to do today?" → `list_tasks` filtered by `dueAt`.
- Email triage → "create a task to reply" with `sourceRef` to the message.

Reminders reuse the **existing scheduler** (cron-runner): a due task can fire a
notification through the same channel-binding path hooks use — no new scheduler.

## Surface
- **Web**: replace the `/tasks` redirect with a real list — open/done filter,
  due dates, priority, quick-add, click to edit (file-view-style detail or a
  simple drawer). Show `source` provenance ("added by agent from research").
- **Chat / work stream**: completing or creating a task surfaces in the work
  stream (feature #1); chat can deep-link "✓ Created task: …".

## Testing
- **Scoped repo**: isolation tests like `sessions.isolation`/`hooks` — user A
  can't see/modify user B's tasks; cross-tenant id → null.
- **Tool**: unit — `create/list/complete` operate only on the caller's tasks;
  ASK-level permission respected.
- **API**: TypeBox validation rejects malformed bodies (400, not coerced).

## Sequencing
1. `tasks` schema + migration + scoped repo + isolation tests.
2. `/api/tasks` CRUD (validated) + the real `/tasks` web page.
3. `tasks` tool + permission wiring + work-stream surfacing.
4. Reminders via the existing scheduler; `source` links from reader/research/
   email (as those land).

## Dependencies
- Standalone for the core list. Richer `source` links depend on Reader (#4),
  Deep Research (#5), Email (#7) — additive, not blocking.
- Reminders reuse the existing cron-runner + channel bindings (exist).
