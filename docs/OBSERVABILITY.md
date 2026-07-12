# Observability

Octipus exposes Prometheus metrics and correlates every orchestrated turn with
a run id for log forensics. This page covers what's shipping today (metrics +
run correlation, WS4 items 1–2). Distributed tracing (OpenTelemetry) is a later
phase and will be documented here when it lands.

## Metrics endpoint

`GET /api/metrics` renders Prometheus text exposition from a single
[`prom-client`](https://github.com/siimon/prom-client) registry
(`src/core/telemetry.ts`).

- **Disabled by default.** The endpoint returns `404` unless `METRICS_TOKEN` is
  set. When set, a scraper must present the token as
  `Authorization: Bearer <token>` or `?token=<token>`. It's token-gated (not
  session-gated) so a Prometheus scraper can reach it without the login flow.
- The health/build gauge **names are stable** — existing dashboards built against
  the previous hand-rendered endpoint keep working.

Example scrape config:

```yaml
scrape_configs:
  - job_name: octipus
    metrics_path: /api/metrics
    authorization:
      credentials: ${METRICS_TOKEN}
    static_configs:
      - targets: ['octipus:3000']
```

## Metric catalog

### Health / build (gauges)

| Metric | Meaning |
|---|---|
| `octipus_up` | `1` while the API process is serving. |
| `octipus_build_info{version}` | Build version label. |
| `octipus_process_uptime_seconds` | Seconds since process start. |
| `process_resident_memory_bytes` | RSS. |
| `nodejs_heap_used_bytes` / `nodejs_heap_total_bytes` | Heap usage. |
| `octipus_db_up` | `1` if the primary database is reachable. |
| `octipus_redis_up` | `1` if Redis/Valkey is reachable. |

### Domain metrics (counters / histograms)

| Metric | Type | Labels | Emitted at |
|---|---|---|---|
| `octipus_orchestrator_runs_total` | counter | `channel`, `role`, `status` | every orchestrated turn (`OrchestratorService.handleMessage`) |
| `octipus_classifications_total` | counter | `topic`, `method` | message classification |
| `octipus_tool_executions_total` | counter | `tool`, `status` | every tool dispatch (`BaseTool` middleware) |
| `octipus_tool_execution_duration_seconds` | histogram | `tool` | " |
| `octipus_llm_requests_total` | counter | `provider`, `model`, `status` | `ProviderRouter.complete` / `.stream` |
| `octipus_llm_request_duration_seconds` | histogram | `provider`, `model` | " |
| `octipus_llm_tokens_total` | counter | `provider`, `model`, `direction` | non-streaming completions (prompt/completion tokens) |
| `octipus_swarm_spawns_total` | counter | `role`, `depth` | child agent spawns (`SwarmSpawner.spawnChild`) |
| `octipus_channel_messages_total` | counter | `channel`, `direction` | inbound/outbound channel messages |

Metric emission is best-effort: every emit is wrapped so a telemetry error can
never break a request or an agent turn.

## Run correlation (`runId`)

Every call to `OrchestratorService.handleMessage` mints a `run_<uuid>` and binds
it as ambient context (`src/core/run-context.ts`, backed by
`AsyncLocalStorage`) for the whole turn — including every child agent, tool
call, and LLM request it fans out to.

Two consumers read it with no threading:

- **Logs** — the pino `mixin` stamps `runId` onto every log line emitted inside
  the turn. Grep one `runId` to reconstruct an entire turn across every
  component that touched it.
- **`agent_events`** — each row records the `run_id` (indexed), so an operator
  can pull a turn's full event trail across all its child agents with one query:

  ```sql
  SELECT * FROM agent_events WHERE run_id = 'run_…' ORDER BY id;
  ```

Events emitted outside any orchestrated turn have a `NULL` `run_id`.
