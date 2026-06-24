# Perf audit — web UI load times & agent history

Investigation prompted by "page loading in the web UI sometimes takes a few
seconds even with little data; the agents page takes ~3s." This note records
the bottlenecks found and what was changed.

## Findings

### 1. `/agents` returned an unbounded, heavy payload (primary)

`GET /agents` had no pagination. For an admin it ran
`agentRepository.listRecent()` (`LIMIT 200`), for a user `listOwn()` — both
`SELECT *`, i.e. every column including the `metadata` and `tool_calls` JSONB
blobs, for up to 200 rows. The agents page then **re-fetched the whole list
every 2 seconds** (`refetchInterval: 2000`). On a box with a few hundred
finished agents that is a 200-row JSONB-laden response on a 2s loop — the
likely source of the ~3s feel (serialize on the server, ship, parse + re-render
200 rows in React on every tick).

Indexes were already fine (`agents_created_at_idx`, `_user_id_idx`,
`_status_idx`, `_session_id_idx`), so this was payload/refetch volume, not a
missing index.

**Fix:** server-side pagination.
- `agentRepository.listRecent(limit, offset)` + `countAll()`.
- `ScopedAgentRepo.listOwn(limit, offset)` / `findBySessions(…, limit, offset)`
  + `countOwn()` / `countBySessions()`.
- `GET /agents?limit=&offset=` — `limit` defaults to 50, clamped to ≤200.
  Response now `{ agents, total, limit, offset, hasMore }`. Live (in-memory)
  agents anchor the first page only; later pages are pure history.
- Web agents page: 50-per-page table with Prev/Next, `keepPreviousData` to
  avoid flicker, and polling reduced to **5s and only on page 0** (history is
  static, so paging through it no longer triggers a 2s poll of large pages).
- Dashboard `active-agents` widget now reads `total` from the response instead
  of counting a now-bounded array.

### 2. Endless agent history accumulates forever (root cause of #1 growing)

`agents` rows and their `agent_events` were never pruned. Over time this is
what makes the list big and the page slow — and nobody needs months of agent
logs on a test system.

**Fix:** weekly sweep in `cron-runner.ts` (`maybeCleanupAgents`), mirroring the
existing `maybeCleanupSessions` / `maybeCleanupKnowledge` loops.
- Deletes finished agents (`completed_at < cutoff`) **and their events**;
  running agents (NULL `completed_at`) are never touched.
- Default retention **14 days**, overridable per deployment by upserting a
  `retention_policies` row with `purpose = 'agent_history'` and a `max_age_days`
  (no migration required — the table already exists).
- Implemented as `agentRepository.deleteCompletedBefore(cutoff)` (events first,
  then agents, to avoid orphans — there is no FK cascade between the two).

## Not changed (candidates for a follow-up, if the feel persists)

- The list still `SELECT *` then maps to a lean shape in the route. At 50 rows
  the JSONB columns are negligible; if profiling later says otherwise, switch
  the list queries to an explicit column projection (drop `metadata` /
  `tool_calls`, which the list view doesn't render).
- Most other pages are Next.js client components doing a single `useQuery` on
  mount; if any feel slow it's worth checking the same two levers (payload size
  + refetch cadence) before reaching for anything structural.
