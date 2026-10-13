# Performance and resource audit — 2026-10-13

> **Measurement report.** Numbers apply to the environment and revisions named
> here (Linux container, Node 24.21, embedded storage/PGlite, no providers or
> channels configured). Rerun the steps under [Method](#method) before treating
> them as a baseline elsewhere.

The [2026-08-23 pass](2026-08-23-feature-performance-pass.md) measured latency
and prompt tokens. This one looks at what Octipus costs a machine while it runs:
boot time, resident memory, idle CPU and database traffic, plus the per-turn hot
path and the web client. Five areas were read in full (startup, database, agent
turn, background timers and caches, web), then the main claims were checked
against a running build.

## Measured: before and after this branch

Warm boot of `node dist/index.js` (`npm run build` output), embedded mode,
second start of the same data directory.

| | Before | After |
|---|---|---|
| Process start → `/api/health` answers | ~3.4 s | ~2.6 s |
| Init phase (`Starting Octipus…` → `started successfully`) | 2.05 s | 1.34 s |
| Idle RSS after boot | 614 MB | 560 MB |
| JS heap used after GC | 117 MB | 93 MB |
| Channels discovered by the bundled build | **0** | 5 |
| Scheduler queue calls while idle | ~50/s, each a pop + re-push (write) | ~2/s, no queue writes |

The remaining idle RSS is mostly PGlite (≈220 MB of `external` WASM memory) and
loaded code; see [Not changed](#found-not-changed-yet) for the next steps.

## Fixed on this branch

1. **Scheduler busy-poll** (`src/core/scheduler.ts`). Five worker loops each
   polled the queue every 100 ms. A task not yet due was popped and pushed back
   on every poll, and artifact cleanup always keeps one task an hour ahead, so
   the queue was never empty: with external storage that is a constant
   `DELETE … FOR UPDATE SKIP LOCKED` / `INSERT` stream on `kv_queue` (WAL,
   dead tuples, vacuum), and 50 wake-ups a second in either mode. The queue now
   parks a delayed task under its due time (`push(item, priority, notBefore)`)
   and pops only due rows (`pop(dueBy)`). An idle worker sleeps until the
   earliest due time, at most 5 s (the heartbeat interval), and `schedule()` /
   `stop()` wake it at once.
2. **Artifact-cleanup chains piled up per restart** (`src/core/artifacts/cleanup.ts`).
   Each boot queued a new self-rescheduling hourly task; with the persistent
   Postgres queue, N restarts meant N chains. Each boot now names its chain in
   `kv_store`; older chains end the next time they fire.
3. **Channels never started in the production build** (`src/channels/discovery.ts`).
   Discovery read its own directory, which is `dist/` once bundled, so
   `npm start` logged `discovered: 0` — no Telegram, Slack, Teams or WhatsApp.
   Same bug `src/tools/discovery.ts` already fixed; same fix (a static map).
4. **Vendor SDKs loaded on every boot** (`src/channels/{slack,teams,telegram}`).
   botbuilder (~0.37 s, ~50 MB), `@slack/bolt` (~0.11 s, ~37 MB) and grammy now
   load in `connect()`, so an install that doesn't use a channel never pays for it.
5. **Playwright loaded to answer "is Chromium installed?"** (`src/tools/browser`).
   The boot-time availability probe imported all of Playwright (~0.3 s, ~80 MB
   kept for the life of the process). The path is now read by a short-lived
   child process; Playwright loads in-process only when a browser is used.
6. **Blocking CLI probes** (`src/tools/{docker,github,gitlab}`). `execSync` of
   `docker info` / `gh auth status` / `glab auth status` froze the event loop
   one after another (5 s timeout each; `gh` is a network call). Now async, so
   they run side by side.
7. **Tokenizer loaded every encoding** (`src/utils/token-count.ts`). The
   `js-tiktoken` root parses ~5.5 MB of rank tables (five encodings) at import.
   Only `o200k_base` is used; it is now required on first use from
   `js-tiktoken/lite`. Output is byte-identical.
8. **Trajectory writes went quadratic over a day** (`src/core/trajectories/recorder.ts`).
   Every turn re-read the whole day's JSONL synchronously to count lines. The
   count is now remembered with the file size; any outside change to the file
   falls back to a full count.
9. **Chat re-rendered every message per streamed token**
   (`web/components/chat/message-timeline.tsx`). The timeline rebuilt and
   re-sorted itself and re-parsed every message's markdown on each token. Rows
   are memoized and the timeline is built only when its inputs change.
10. **10-second history refetch replaced every message object**
    (`src/shared/chat-reconciliation.ts`). Unchanged rows (and the array, when
    nothing changed) keep their identity, so the memoized rows skip the render.
11. **Unused Material Symbols font** removed from the Google Fonts import.

## Found, not changed yet

Ordered by expected payoff. File references are to the 2026-10-13 tree.

### High

- **Per-iteration quota check: 4 queries before every model call.**
  `agent-worker.ts:~1155` → `willExceed('tokensPerDay')` runs all of
  `getUsage` (running agents, today's tokens, an `audit_log` count) plus an
  override read, though only today's tokens matter. Compute only the requested
  kind and cache per user for 5–30 s as `spend-budgets.ts` already does. This
  changes enforcement granularity, so it needs an owner's call.
- **Every authenticated `/api` request makes ~8 DB round trips before the
  handler**: per-IP and per-user rate limits (GET + SET each), session
  validation that UPSERTs `lastActivityAt` on every request, an uncached quota
  read, an awaited audit insert with `.returning()`. Throttle the activity
  write (e.g. once a minute), use one atomic increment per limit, cache quota
  overrides briefly, don't await the audit insert. External mode only.
- **Streaming deltas are broadcast one token at a time** (`event-bridge.ts`,
  `connection-manager.ts`, `event-bus.ts`): a `JSON.stringify` per receiving
  connection, a walk over every connection, and each delta enters the replay
  buffer, so a long answer evicts the events that matter for reconnect replay.
  Coalesce deltas every ~30–50 ms, keep `chat.delta` out of the replay buffer,
  stringify once per event.
- **Tool results are persisted and broadcast in full** (`tool-executor.ts:~1028`
  → `agent_events` JSONB, WS, replay buffer). Send `previewToolResult` instead.
- **Vector indexes are missing on every install that was empty at migration
  0055** — it creates HNSW only if rows existed then, promises "HNSW will be
  added on next migration run", but migrations are tracked by hash and nothing
  later creates it (checked: no other `hnsw` after 0055). KB search then
  seq-scans. Memory search orders by
  `1 - (embedding <=> v) DESC`, which can't use HNSW even when present.
- **`messages` lacks `(session_id, created_at DESC, id DESC)`** for the per-turn
  context load (top-N with a sort over the whole session today).
- **Launcher overhead** (`bin/octi`): `octi start web` rebuilds `mcp-server`
  (tsc) and `web` (vite) on every start and leaves four Node processes (two are
  idle `npm run` wrappers, ~40–60 MB each). Launch `node dist/index.js` and
  `node web/serve.mjs` directly and rebuild only when stale.

### Medium

- Monitors tick every 5 s with 4 queries even with no monitors
  (`core/monitors/service.ts`); skip when none are armed.
- Provider health checks every 60 s (`models/health-checker.ts`): CLI providers
  spawn `which` per model, LiteLLM-routed providers outside the skip list get a
  real billed "Hi" completion. Check per provider, less often, or on demand.
- MCP stdio servers all start at boot, one after another, and never stop when
  idle (`mcp/bridge.ts`). Connect in parallel and lazily; stop after idle.
- Playwright Chromium, once launched, is never closed when idle, and contexts
  opened without an id leak (`tools/browser`); websearch launches a second one.
- Embedding self-check on the boot path makes a real network call with a 120 s
  timeout and 3 retries, before vault credentials are loaded (`gateway.ts:96`).
- A failed session compaction retries every turn, re-reading and re-tokenizing
  the whole history (`session-compaction.ts`); record failures with a backoff.
- Prompt dumps (`agent.promptDumps`, on by default) sweep the dump directory
  with sync `readdirSync`/`statSync` and write the full prompt on every spawn.
- Logger defaults to in-process `pino-pretty` (`utils/logger.ts`); default to
  JSON when stdout isn't a TTY, or move pretty-printing to a transport thread.
- Growing tables with no pruning: `audit_log`, `cost_log`, `hook_executions`,
  `notifications`, `run_events`, `tool_actions`, `trajectory_runs`, …
- Skill lookups `SELECT *` the whole `skills` table (with embeddings) to find
  one row (`skills/registry.ts:112-123`).
- Web: CodeMirror is pulled into every `/chat` load via `FileViewer`, recharts
  into the dashboard; `serve.mjs` sends assets uncompressed and marks unhashed
  `public/` files `immutable` for a year; production sourcemaps ship in the
  desktop bundle; the chat page still refetches up to 10 000 messages every
  10 s even while the WebSocket is live.

### Low

- Seeds run a SELECT + UPDATE per row on every boot; hash the seed data and skip.
- `errorTimestamps` in `utils/log-stream.ts` is only pruned when stats are read.
- A few never-evicted maps (`file-mutation-queue`, `interjectHits`,
  `projectRootCache`, …); small, but unbounded.
- The orphan reaper runs every 120 s regardless of its configured interval.
- `NODE_COMPILE_CACHE` was measured and did not help measurably (±0.3 s noise).

## Method

```bash
npm run build
STORAGE_MODE=embedded DATA_DIR=… node dist/index.js   # second start, warm data dir
# time to first 200 from /api/health; /proc/<pid>/status VmRSS after 25 s idle;
# process.memoryUsage() after global.gc() via --expose-gc --import <probe>;
# idle CPU from /proc/<pid>/stat utime+stime over 60 s.
```

Import costs were measured per package in a fresh `node` process
(`await import(pkg)`, wall time and RSS delta).
