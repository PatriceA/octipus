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
loaded code. The first table is the first pass alone; the second pass's
measurements are under [Final measurements](#final-measurements).

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

## Second pass: the rest of the findings, and bugs found on the way

Everything the first pass listed as "found, not changed yet" was then worked,
together with a code review of the recent upstream commits and of this branch.

### Database and API

- Quota check before each model call: one query for the dimension it gates
  (was 3 aggregates + an override read), tokens-today cached 5 s per user
  (`billable_tokens` is only written when an agent finishes, so nothing is
  lost), effective quota cached 10 s and dropped on override writes.
- Per-request overhead (external mode): one atomic increment per rate-limit
  window instead of GET+SET (which also raced); `lastActivityAt` written at
  most once a minute; audit insert not awaited and without `RETURNING`.
- Vector search: HNSW is built at runtime once a table's rows share one
  dimension (migration 0055 only did it for tables that had rows then, so new
  installs searched by sequential scan); memory search orders by bare distance
  so the index can serve it; filtered searches run with
  `hnsw.iterative_scan = strict_order` (pgvector 0.8+) so a user owning a
  small share of the rows still gets `LIMIT` results — measured 0/10 without
  it, 10/10 with it.
- Migration 0138: `messages(session_id, created_at, id)` and
  `cost_log(user_id, created_at)`.
- Cron hooks claimed with compare-and-set (a hook could fire twice across
  instances); agent cleanup deletes in batches (one `IN` list broke above
  ~65k ids); daily batched pruning of old `api_request` audit rows, hook
  executions, read notifications and settled permission requests (90 days,
  `retention_policies` purpose `log_history`; billing/trace tables kept).
- Skills looked up by id, without the embedding column (also no longer sent to
  the browser); memory reads skip the embedding; monitors skip their 4 queries
  per 5 s tick while no monitor is live; settings remember misses; three
  per-item query loops replaced; skill seeding writes only changed rows; the
  capability probe runs side by side and upserts in one statement.

### Gateway, agent turn and background work

- Streamed deltas coalesced per 40 ms / 512 chars (order kept: any other
  event flushes first), each event serialized once and sent only over its
  user's connections; `chat.delta` kept out of the replay buffer; idle
  sessions' replay buffers expire after 30 min and oversized payloads are not
  stored (resume gets `gap: true`).
- Tool results on `observation` events clipped to 2,400 chars (the model still
  gets full output); finished workers released after 10 min, not 1 h.
- Failed session compaction backs off (5 min doubling to 6 h) instead of
  re-running the whole map-reduce every turn; short sessions are settled from
  one aggregate instead of reading and tokenizing the transcript.
- Prompt dumps written asynchronously, swept at most hourly; spawn-time
  `git status`/`git diff --stat` async and in parallel.
- Logs are JSON when stdout is not a terminal (`octi logs` pretty-prints);
  error timestamps pruned on push.
- Provider health: no billed "Hi" completions as probes, one check per
  provider, CLI binary presence cached, every 5 min instead of every minute.
- MCP servers connect in parallel, off the boot path, with one shared 15 s
  deadline for spawns that need them.
- KB self-check after boot (no longer stalls startup for up to minutes on an
  unreachable embedding endpoint), bounded, with a re-check when a slow cold
  model answers late.
- One headless Chromium shared by the browser and websearch tools, closed after
  5 min idle; leaked contexts and SSRF-blocked pages are closed.
- Token-count cache bounded by total characters (it could pin hundreds of MB
  of history strings); several small per-key maps bounded.

### Web client and launcher

- JS each page downloads on top of the app shell: `/` 380 → 32 kB, `/chat`
  734 → 311 kB, `/eval/view` 399 → 16 kB (CodeMirror, recharts, qrcode load on
  first use); React in its own long-cached vendor chunk; sourcemaps no longer
  linked (web) or shipped (desktop).
- `serve.mjs`: gzip/brotli, `immutable` only for hashed `/assets/`, ETag/304
  for the rest (unhashed files were cached for a year), async stat.
- Chat history polled only when the WebSocket can't deliver it (channel
  sessions, disconnected); room view no longer defeats the timeline memo; row
  identity kept without serializing every message.
- Idle timers stop (swarm tree tick, unhealthy-provider poll backs off to
  60 s, hidden-tab guard); reconnects jittered.
- `octi start web` launches `node` directly (no idle npm wrappers) and
  rebuilds `mcp-server` and the web bundle only when stale (also on Windows);
  health polled every 0.25 s.

### Bugs fixed along the way

- **Built server (`npm start`) feature loss** — every place that found code by
  path at runtime broke once bundled into `dist/`: chat channels (0
  discovered), artifact toolbox (empty), capability installers (`@/…`
  specifiers Node cannot resolve), local STT/TTS Python workers (not in
  `dist/`), whisper.cpp install root (one directory above the install).
- Upstream review: `steer_child` never reached a child (looked up by spawn
  handle, not agent id); federated room notices reached only one member per
  visiting install; a chat "yes" to a CLI question threw into nowhere (now
  explained to the user, and the chat prompt shows the questions); unacknowledged
  live guidance interrupted every `collect_children`; an agent was not told
  where codemode servers went when codemode was blocked; paged history still
  counted every sibling message.
- `octi stop` killed every `node …dist/index.js` on the machine; `build_info`
  reported version 0.0.0 under `node dist/index.js`; the project-root cache
  cached `null` for parent directories (writes in a real repo could be
  redirected); the CLI worker dumped prompts for sessions whose text must stay
  in their own rows; channel tool emojis and stall resets never fired (the
  handler matched on a session id agent events don't carry); silent catches
  in the CLI worker and HTTP after-hooks now log; artifact cleanup chains piled
  up per restart; eslint failed after a Playwright run.

### Left as is, on purpose

- The 5-minute cap on a CLI run waiting for approval is documented
  (docs/CLI-AGENTS.md) and tested.
- `bin/octi.cmd` still starts servers through `npm run` (only the rebuild
  check was ported; it could not be exercised on Windows here).
- Provider SDK retries behind the bounded boot embedding call still run in
  the background.

## Final measurements

`main` (d2f9b65), the first pass alone (fe6fe36) and this branch's head, each
built with `npm run build` and booted from its own fresh embedded data
directory on the same idle machine, back to back. Second to fourth boot of
each (the first applies migrations); RSS 15 s after ready, CPU over the next
30 s of idling.

| | `main` | First pass | Head |
|---|---|---|---|
| Process start → `/api/health` | 4.06–4.21 s | 3.31–3.52 s | 3.10–3.56 s |
| RSS after boot | 578–610 MB | 528–566 MB | 489–533 MB |
| Idle CPU (ticks / 30 s) | 20–22 | 9–12 | 5–6 |
| JS heap used after GC | 117 MB | 93 MB | 58 MB |

These numbers are from a quieter run than the first table above, so the two
tables are not directly comparable; compare within this one. The remaining
boot time is mostly loading the 6.7 MB bundle and its dependencies, PGlite
start-up, and the out-of-process Chromium path probe (~0.5 s), which could
still move off the critical path. The remaining idle RSS is mostly PGlite's
WASM heap (~220 MB `external`).

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
