/**
 * Telemetry — Prometheus metrics (WS4 observability, item 1).
 *
 * A single `prom-client` registry replaces the hand-rendered exposition that
 * used to live in `src/api/routes/metrics.ts`. The health/build gauges keep
 * their EXACT previous names (`octipus_up`, `octipus_db_up`,
 * `process_resident_memory_bytes`, …) so existing dashboards/alerts survive the
 * swap; new counters/histograms are added alongside them.
 *
 * Emission contract: every hook site calls a `record*` helper below, never a
 * metric object directly. The helpers swallow their own errors — a telemetry
 * bug (bad label, registry hiccup) must never break a request or an agent turn.
 * `collectDefaultMetrics` is intentionally NOT enabled: we hand-set the handful
 * of process gauges that the old endpoint exposed, and nothing more, to keep
 * the scrape surface stable and cheap.
 */
import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import { coreLogger } from '@/utils/logger';

export const registry = new Registry();

// ── Health / build gauges (names preserved from the old hand-rendered set) ──
const upGauge = new Gauge({
  name: 'octipus_up',
  help: '1 if the API process is serving.',
  registers: [registry],
});
const buildInfo = new Gauge({
  name: 'octipus_build_info',
  help: 'Build information.',
  labelNames: ['version'],
  registers: [registry],
});
const uptimeGauge = new Gauge({
  name: 'octipus_process_uptime_seconds',
  help: 'Seconds since the process started.',
  registers: [registry],
});
const rssGauge = new Gauge({
  name: 'process_resident_memory_bytes',
  help: 'Resident set size in bytes.',
  registers: [registry],
});
const heapUsedGauge = new Gauge({
  name: 'nodejs_heap_used_bytes',
  help: 'Heap memory used in bytes.',
  registers: [registry],
});
const heapTotalGauge = new Gauge({
  name: 'nodejs_heap_total_bytes',
  help: 'Heap memory total in bytes.',
  registers: [registry],
});
const dbUpGauge = new Gauge({
  name: 'octipus_db_up',
  help: '1 if the primary database is reachable.',
  registers: [registry],
});
const redisUpGauge = new Gauge({
  name: 'octipus_redis_up',
  help: '1 if Redis/Valkey is reachable.',
  registers: [registry],
});

const PROCESS_START = Date.now();

// ── Domain counters / histograms ────────────────────────────────────────────
const DURATION_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30];
const LLM_BUCKETS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60];

const orchestratorRuns = new Counter({
  name: 'octipus_orchestrator_runs_total',
  help: 'Orchestrated turns, by entry channel, resolved role, and outcome.',
  labelNames: ['channel', 'role', 'status'],
  registers: [registry],
});
const classifications = new Counter({
  name: 'octipus_classifications_total',
  help: 'Message classifications, by resolved topic and method.',
  labelNames: ['topic', 'method'],
  registers: [registry],
});
const toolExecutions = new Counter({
  name: 'octipus_tool_executions_total',
  help: 'Tool executions, by tool and outcome.',
  labelNames: ['tool', 'status'],
  registers: [registry],
});
const toolDuration = new Histogram({
  name: 'octipus_tool_execution_duration_seconds',
  help: 'Tool execution wall-clock, by tool.',
  labelNames: ['tool'],
  buckets: DURATION_BUCKETS,
  registers: [registry],
});
const llmRequests = new Counter({
  name: 'octipus_llm_requests_total',
  help: 'LLM completion/stream requests, by provider, model, and outcome.',
  labelNames: ['provider', 'model', 'status'],
  registers: [registry],
});
const llmLatency = new Histogram({
  name: 'octipus_llm_request_duration_seconds',
  help: 'LLM request latency, by provider and model.',
  labelNames: ['provider', 'model'],
  buckets: LLM_BUCKETS,
  registers: [registry],
});
const llmTokens = new Counter({
  name: 'octipus_llm_tokens_total',
  help: 'LLM tokens, by provider, model, and direction (prompt|completion). prompt includes cached tokens.',
  labelNames: ['provider', 'model', 'direction'],
  registers: [registry],
});
// Separate metric — NOT a direction on llmTokens — because cached tokens are a
// subset of the prompt direction; a shared counter would double-count on any
// sum-across-directions query. This is the cache-hit numerator; prompt is the
// denominator.
const llmCachedTokens = new Counter({
  name: 'octipus_llm_cached_tokens_total',
  help: 'Cached prompt tokens (subset of prompt-direction llm_tokens), by provider and model.',
  labelNames: ['provider', 'model'],
  registers: [registry],
});
const swarmSpawns = new Counter({
  name: 'octipus_swarm_spawns_total',
  help: 'Child agent spawns, by child role, depth, and whether the parent supplied a plan (planned children route to the lane executorModel).',
  labelNames: ['role', 'depth', 'planned'],
  registers: [registry],
});
const channelMessages = new Counter({
  name: 'octipus_channel_messages_total',
  help: 'Channel messages, by channel and direction (inbound|outbound).',
  labelNames: ['channel', 'direction'],
  registers: [registry],
});

/** Normalize a label value to a bounded, low-cardinality string. */
function label(v: string | undefined | null, fallback = 'unknown'): string {
  const s = (v ?? '').toString().trim();
  return s.length > 0 ? s : fallback;
}

function guard(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    coreLogger.debug({ err }, 'metric emission failed (ignored)');
  }
}

export function recordOrchestratorRun(
  channel: string | undefined,
  role: string | undefined,
  status: 'success' | 'error',
): void {
  guard(() => orchestratorRuns.inc({ channel: label(channel), role: label(role), status }));
}

export function recordClassification(
  topic: string | undefined,
  method: 'deterministic' | 'llm',
): void {
  guard(() => classifications.inc({ topic: label(topic), method }));
}

export function recordToolExecution(
  tool: string,
  status: 'success' | 'error' | 'cancelled',
  seconds: number,
): void {
  guard(() => {
    toolExecutions.inc({ tool: label(tool), status });
    toolDuration.observe({ tool: label(tool) }, seconds);
  });
}

export function recordLlmRequest(
  provider: string | undefined,
  model: string | undefined,
  status: 'success' | 'error',
  seconds: number,
  tokens?: { prompt?: number; completion?: number; cached?: number },
): void {
  guard(() => {
    const p = label(provider);
    const m = label(model);
    llmRequests.inc({ provider: p, model: m, status });
    llmLatency.observe({ provider: p, model: m }, seconds);
    if (tokens?.prompt && tokens.prompt > 0) {
      llmTokens.inc({ provider: p, model: m, direction: 'prompt' }, tokens.prompt);
    }
    if (tokens?.completion && tokens.completion > 0) {
      llmTokens.inc({ provider: p, model: m, direction: 'completion' }, tokens.completion);
    }
    // Cached prompt tokens are a subset of `prompt` — its own metric so a
    // dashboard can show cache-hit ratio without double-counting input volume.
    if (tokens?.cached && tokens.cached > 0) {
      llmCachedTokens.inc({ provider: p, model: m }, tokens.cached);
    }
  });
}

export function recordSwarmSpawn(role: string | undefined, depth: number, planned = false): void {
  guard(() => swarmSpawns.inc({ role: label(role), depth: String(depth), planned: String(planned) }));
}

export function recordChannelMessage(
  channel: string | undefined,
  direction: 'inbound' | 'outbound',
): void {
  guard(() => channelMessages.inc({ channel: label(channel), direction }));
}

/**
 * Render the full registry as Prometheus text exposition. Health probes are
 * passed in (the route already runs them with a timeout) so this module stays
 * free of DB/Redis imports.
 */
export async function renderMetrics(dbUp: number, redisUp: number): Promise<string> {
  const mem = process.memoryUsage();
  const version = process.env.npm_package_version || '0.0.0';

  upGauge.set(1);
  buildInfo.reset();
  buildInfo.set({ version }, 1);
  uptimeGauge.set((Date.now() - PROCESS_START) / 1000);
  rssGauge.set(mem.rss);
  heapUsedGauge.set(mem.heapUsed);
  heapTotalGauge.set(mem.heapTotal);
  dbUpGauge.set(dbUp);
  redisUpGauge.set(redisUp);

  return registry.metrics();
}

/** Content type for the exposition (matches prom-client's own). */
export const METRICS_CONTENT_TYPE = registry.contentType;
