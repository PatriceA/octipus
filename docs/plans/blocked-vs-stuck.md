# Octipus goes silent, and never says whether it is working or stuck

## The complaint

> *"The child was spawned immediately. The child took 25 sec to do the task. The
> message came back 14min later. Absolut bad performance. Why? the answer was
> there, it was collected, but than long nothing."*

The specific 14-minute case was the toolshim and is fixed (see
`project_octipus_delivery_lag`, `scripts/run-health.ts`). This document is about
what is left: octipus still goes quiet for minutes at a time, and **nothing
tells the user whether that silence is progress or a hang.**

## Measurement

Longest gap between consecutive `agent_events` rows within a single agent run,
over a 5-hour window on 2026-08-01:

| role / model | longest silence | final status | actual cause |
|---|---|---|---|
| orchestrator / deepseek-v4-flash | **2015s** (33.5 min) | completed | pipeline `awaiting_approval` |
| coding / ornith:35b | **901s** | failed | ollama `OLLAMA_LOAD_TIMEOUT=15m` |
| orchestrator / deepseek-v4-flash | 582s | stopped | blocked in `collect_children` on the above |
| coding / ornith:35b | 469s | failed | same load failure |
| orchestrator / deepseek-v4-flash | 245s | completed | legitimately blocked on children |
| coding / qwen3.5:9b | 90s | completed | 66s cold model load |

Reproduce:

```sql
WITH ev AS (
  SELECT agent_id, created_at,
         LEAD(created_at) OVER (PARTITION BY agent_id ORDER BY created_at) AS nxt
    FROM agent_events WHERE created_at > now() - interval '5 hours'
)
SELECT a.role, a.model, a.status,
       round(MAX(EXTRACT(EPOCH FROM (ev.nxt - ev.created_at)))::numeric,0) AS max_silent_s
  FROM ev JOIN agents a ON a.id::text = ev.agent_id
 WHERE ev.nxt IS NOT NULL GROUP BY a.id, a.role, a.model, a.status
 HAVING MAX(EXTRACT(EPOCH FROM (ev.nxt - ev.created_at))) > 60
 ORDER BY max_silent_s DESC;
```

## The finding

**Every one of those silences has a legitimate explanation.** None is an
unexplained wedge. Three distinct states are represented:

1. **Waiting for the human** (2015s) — pipeline `awaiting_approval`. Correct
   behaviour; `create_pipeline` is deliberately exempt from the wall race so an
   approval wait is never killed. Do not remove that exemption.
2. **Waiting for a child** (582s, 245s) — `collect_children`. Correct; the wait
   is credited back via `pausedMs` so the parent isn't penalised.
3. **Stuck on something that will never succeed** (901s, 469s) — a 21GB model
   that cannot load in available RAM, burning ollama's full 15-minute timeout
   before failing. See `project_octipus_ornith_wont_load`.

**They are indistinguishable from outside.** The event stream shows the same
thing for all three: nothing. That is the actual defect. The user cannot tell
"your approval is the blocker" from "a child is working" from "this will fail in
14 more minutes", and so reads all of them as "octipus is broken".

Note the state already exists internally — `AgentWorker.blockedSince`
(`src/core/agent-worker.ts:66`), documented as *"non-null while the worker is
inside a legitimately-long blocking wait"*, and the orphan reaper already reads
it to avoid killing a healthy worker. **It is never surfaced to the user.**

## Phase 1 — say what you are waiting for

**Files:** `src/core/agent-worker.ts`, `src/core/gateway/event-bridge.ts`

While `blockedSince` is non-null, emit a periodic progress event (every ~15-30s)
carrying *what* is blocking and *for how long*: `collect_children` (with the
pending child count), a `final` tool awaiting approval, or a plain LLM call in
flight. `whileBlocked()` already wraps every such region and is the natural
place to hang the timer.

This is the whole fix for cases 1 and 2 — the work is fine, only the reporting
is missing.

**Check:** a run blocked >30s on `collect_children` produces at least one
progress event naming it; a fast run produces none.

## Phase 2 — surface a pending approval in the response path

A `POST /chat` caller blocks until approval or `approvalTimeoutMs` (1h) with no
signal. The approval IS raised properly — `approval_required` notification, the
orchestrator event bridged to `orchestrator.approval_required`, and an entry at
`GET /chat/approvals/pending` — so WS clients (web UI, TUI) see it. Only the
synchronous REST caller is blind.

Decide one: either return a typed "awaiting approval" response with the
`requestId` instead of holding the connection, or document that REST callers
must poll `/chat/approvals/pending`. Any scenario/e2e script driving REST needs
the polling either way — the auto-approve loop used to validate this is worth
keeping as a test helper.

**Check:** a REST-driven pipeline run can be carried to completion without a
human, and never looks like a hang.

## Phase 3 — fail fast on a model that cannot load

901s spent to discover a model won't load is the worst of the three cases: it is
pure loss, and it looks exactly like the two healthy ones. `OLLAMA_LOAD_TIMEOUT`
is 15m to accommodate genuinely slow first loads, so the fix is not simply
lowering it.

Cheapest honest option: before binding work to a local model, check
`GET /api/ps` plus available RAM against the model's size, and fail loud with
"model X needs ~21GB, ~17GB available" rather than blocking for 15 minutes. The
sizing data already exists — the hwfit catalog reads live registry manifest
sizes (`project_octipus_hwfit`).

**Check:** binding a lane to a model too large for current free RAM surfaces an
actionable error in seconds, not a 15-minute stall.

## Risk

Do not "fix" this by adding wall-clock ceilings to the blocking waits. Cases 1
and 2 are correct behaviour and a ceiling would kill real work — a human may
legitimately take an hour to approve. The 2026-08-01 ceilings
(`TOOLSHIM_TIMEOUT_MS`, `DEFAULT_UNRACED_TURN_CEILING_MS`) deliberately bound
only LLM calls and tools, never these regions. **The problem is observability,
not enforcement** — except in Phase 3, which is a genuine dead end and should
fail rather than wait.

## Related

- `project_octipus_delivery_lag` — the fixed 14-minute case and
  `scripts/run-health.ts`, which measures the post-answer half of this.
- `project_octipus_ornith_wont_load` — cause of the 901s entries.
- `docs/plans/pipeline-evidence-gate.md` — the other half of the same run.
