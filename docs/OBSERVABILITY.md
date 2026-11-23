# Observability

Octipus exposes Prometheus metrics, correlates every orchestrated turn with a
run id for log forensics, and can export OpenTelemetry traces over OTLP. All
three are off or invisible until an operator turns them on.

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
      - targets: ['octipus:3005']
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
| `octipus_storage_up` | `1` if the storage provider (cache/queue/pub-sub) is reachable. |

### Domain metrics (counters / histograms)

| Metric | Type | Labels | Emitted at |
|---|---|---|---|
| `octipus_root_agent_runs_total` | counter | `channel`, `role`, `status` | every orchestrated turn (`AgentService.handleMessage`) |
| `octipus_classifications_total` | counter | `topic`, `method` | message classification |
| `octipus_tool_executions_total` | counter | `tool`, `status` | every tool dispatch (`BaseTool` middleware) |
| `octipus_tool_execution_duration_seconds` | histogram | `tool` | " |
| `octipus_llm_requests_total` | counter | `provider`, `model`, `status` | `ProviderRouter.complete` / `.stream` |
| `octipus_llm_request_duration_seconds` | histogram | `provider`, `model` | " |
| `octipus_llm_tokens_total` | counter | `provider`, `model`, `direction` | non-streaming completions (prompt/completion tokens) |
| `octipus_swarm_spawns_total` | counter | `role`, `depth`, `planned` | child agent spawns (`SwarmSpawner.spawnChild`); `planned="true"` = parent supplied a `plan` (an executor is used only if configured) |
| `octipus_channel_messages_total` | counter | `channel`, `direction` | inbound/outbound channel messages |

Metric emission is best-effort: every emit is wrapped so a telemetry error can
never break a request or an agent turn.

## Run correlation (`runId`)

Every call to `AgentService.handleMessage` mints a `run_<uuid>` and binds
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

## Tracing (OpenTelemetry)

Spans for requests, turns, pipeline stages, model calls, tool calls and
deliveries, exported over OTLP/HTTP to any OpenTelemetry collector (Jaeger,
Tempo, Honeycomb, Grafana Cloud, …). The code is `src/core/tracing.ts`.

### Turning it on

**Off by default.** Like the metrics endpoint, it is switched on by
environment variables, here the standard OpenTelemetry ones:

| Variable | Effect |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Turns tracing on; spans go to `<endpoint>/v1/traces`. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Turns tracing on; the full traces URL, used as is. |
| `OTEL_TRACES_EXPORTER=otlp` | Turns tracing on with the default endpoint `http://localhost:4318/v1/traces`. |
| `OTEL_TRACES_EXPORTER=none` / `OTEL_SDK_DISABLED=true` | Off, whatever else is set. |
| `OTEL_EXPORTER_OTLP_HEADERS` / `_TRACES_HEADERS` | Headers for the collector, e.g. `authorization=Bearer …`. |
| `OTEL_EXPORTER_OTLP_TIMEOUT`, `OTEL_EXPORTER_OTLP_COMPRESSION` | Exporter timeout and `gzip`. |
| `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES` | Resource; the default `service.name` is `octipus`, `service.version` the running version. |
| `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG` | Sampling (default `parentbased_always_on`), e.g. `parentbased_traceidratio` and `0.1`. |
| `OTEL_BSP_*` | Batch size, queue size and delay of the batch span processor. |

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
OTEL_SERVICE_NAME=octipus-prod
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=0.25
```

Spans are sent as OTLP/HTTP with JSON bodies, which every collector accepts on
its HTTP port (4318). A configuration this build cannot honour stops the
process at boot with the reason rather than exporting nothing:
`OTEL_TRACES_EXPORTER` other than `otlp` or `none`, or
`OTEL_EXPORTER_OTLP_PROTOCOL=grpc`. Export failures (a collector that is down)
are logged at `warn`. Pending spans are flushed at shutdown.

While tracing is off, the OpenTelemetry SDK is never loaded: the span helpers
return before touching it, and only the dependency-free
`@opentelemetry/api` package is imported.

### Spans

| Span | Kind | Where | Attributes |
|---|---|---|---|
| `<METHOD> <route>` | server | every HTTP request (the application layer, `src/api/http/app.ts`) | `http.request.method`, `http.route`, `url.path`, `url.scheme`, `http.response.status_code` |
| `agent.run` | internal | every orchestrated turn, rooms included (`AgentService`) | `octipus.run_id`, `octipus.session_id`, `octipus.channel`, `octipus.trigger`, `octipus.outcome`, `octipus.topic` |
| `agent.child` | internal | a child agent spawn (`SwarmSpawner.spawnChild`) | `octipus.agent.parent_id`, `.role`, `.depth`, `.planned`, `.child_status` |
| `pipeline.run` | internal | a pipeline walk | `octipus.pipeline.id`, `octipus.session_id` |
| `pipeline.stage` | internal | each node visit: step, loop head, human input | `octipus.pipeline.id`, `.node_key` (`n0`, `loop1`), `.stage_kind`, `.stage_type` |
| `chat <model>` | client | every model call, streaming or not (the provider accounting boundary) | `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, `octipus.llm.streaming`, `octipus.llm.request_type` |
| `execute_tool <name>` | internal | every tool call the agent makes (`ToolExecutor`) | `gen_ai.tool.name`, `gen_ai.tool.call.id`, `octipus.tool.id`, `octipus.agent.id`, `octipus.agent.role` |
| `channel.deliver` | client | each message sent out on a channel | `octipus.channel`, `octipus.channel.attachments` |
| `webhook.deliver` | client | a hook's webhook action | `http.request.method`, `server.address`, `url.scheme`, `http.response.status_code` |

Parents follow the async call tree (an `AsyncLocalStorage` context manager),
so a model call made by a child agent inside `spawn_child` nests under that
tool call, under the turn, under the request. Model calls and tool calls of a
turn are siblings under `agent.run`, in the order they ran. `octipus.run_id`
is the same `run_…` id stamped into the logs, so a trace and its log lines
find each other.

**Propagation.** An inbound request carrying a W3C `traceparent` header
continues that trace. Outgoing webhook deliveries carry `traceparent` (and
`tracestate`) of their span, unless the hook configures that header itself.
Turns that arrive over the gateway WebSocket or a polling channel start a
trace of their own at `agent.run`.

**Not traced.** Database queries (Drizzle's built-in spans would carry the
query parameters, and are inactive in the installed version), WebSocket
frames, and requests to model providers below the `chat` span: no
`traceparent` is sent to a provider.

### What spans never carry

Ids, names, counts, durations, status and the error class only. No prompt,
completion, message text, tool argument or result, file path, header, secret
or token. This is enforced in code: span attributes are typed against a closed
list of keys (`SPAN_ATTRIBUTE_KEYS`), and a test drives a request through a
turn, model calls and tool calls with marked content and fails if any of it
reaches a span. Specifically:

- **Errors** set the span status to `ERROR` and record `error.type` as the
  error's class (`DiaryUnreadable`, `ClassifiedError`, a status code for an
  HTTP failure), never the message, which can quote user content; no exception
  events or stack traces are recorded.
- **URLs.** An inbound request records its path through the log redactor
  (`redactUrlForLog`: the token segment of a public media, invite or form link
  is replaced) and the route template; the query string is not recorded at all.
  A webhook records only the receiving host: a webhook URL's path is often its
  secret.
- **Channels** record the channel type, never the channel id (a phone number on
  WhatsApp) or the content.

## Verification evidence

Completion checks are recorded to an append-only `verification_evidence` ledger
to preserve the checks recorded for a task. A QA verdict may itself be
model-generated; the ledger does not turn that verdict into independent proof. Today QA-validation verdicts (initial + each retry)
are persisted; the schema-gate and `pre_verify` kinds are reserved for the
follow-up work.

| Column | Meaning |
|---|---|
| `kind` | `qa_verdict` \| `schema_gate` \| `pre_verify` \| `adhoc` |
| `passed` | Did the deliverable pass this check? |
| `confidence` | `high` \| `medium` \| `low` (verdict-style checks) |
| `detail` | Check-specific payload (issues, feedback, retry count) |
| `session_id` / `pipeline_id` / `stage` | Where the check ran |

Read a session's evidence (ownership-scoped — you only see your own sessions;
admins see all):

```
GET /api/verification/:sessionId
→ { sessionId, verified, evidence: [ … ] }
```

`verified` **fails loud**: a session with *no* recorded evidence is **not**
verified (never assume a pass we can't show); it is `true` only when at least
one check ran and none failed. This aggregate describes recorded checks, not
all required acceptance criteria, and does not certify task correctness. Recording is best-effort at the call site — a
ledger write can never break the pipeline.

## Trajectory export

Recorded trajectories (see `TRAJECTORY_LOGGING`, `trajectory_runs`, and the
daily JSONL under `<workspace>/trajectories/`) can be exported as chat-format
training data for offline eval / fine-tune pipelines:

```
npx tsx scripts/trajectories/export.ts \
  [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--outcome success] [--out file.jsonl]
```

It reads the dailies (compressed or plain), emits one `{ messages, meta }`
example per run (a `user → assistant` pair plus outcome/topic/tokens metadata),
**re-runs the PII filter at export time** (belt-and-braces over the recorder's
inline scrub), and prints a `scanned / exported / filtered / malformed` summary
to stderr — no silent truncation. Without `--out` it writes JSONL to stdout.
The same records feed the learning loop via `skill_distill source=trajectory`
(see [Skill lifecycle](LANE-ROLE-SKILL-ROUTING.md)).
