import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';

/**
 * In-process ring buffer + pub/sub for log records.
 *
 * pino writes serialized JSON lines to `ringBufferStream`; we parse them,
 * keep the last N in memory, update counters, and emit a `log` event.
 * Consumed by `src/api/routes/logs.ts` to drive the live log dashboard.
 */

const MAX_BUFFER = 2000;
const ERROR_WINDOW_MS = 60_000;

type LogRecord = {
  time: string;
  level: string;
  msg?: string;
  component?: string;
  service?: string;
  [k: string]: unknown;
};

const buffer: LogRecord[] = [];
const errorTimestamps: number[] = [];

// Cap distinct error messages tracked so a flood of unique messages can't grow
// unbounded. Once full we stop adding new keys but keep counting known ones.
const MAX_ERROR_KEYS = 200;
const topErrors = new Map<string, { count: number; lastSeen: number }>();
// Per-tool and per-provider rollups for the ops dashboard. Bounded naturally by
// the number of distinct tools / providers.
const toolStats = new Map<string, { calls: number; errors: number; totalMs: number }>();
const providerStats = new Map<string, { calls: number; errors: number }>();

export const logEvents = new EventEmitter();
logEvents.setMaxListeners(0);

const counters = {
  total: 0,
  byLevel: {} as Record<string, number>,
  byComponent: {} as Record<string, number>,
  startedAt: Date.now(),
};

function levelName(n: number): string {
  if (n >= 60) return 'fatal';
  if (n >= 50) return 'error';
  if (n >= 40) return 'warn';
  if (n >= 30) return 'info';
  if (n >= 20) return 'debug';
  return 'trace';
}

function ingest(line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let raw: any;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return;
  }
  const level = typeof raw.level === 'number' ? levelName(raw.level) : String(raw.level ?? 'info');
  const rec: LogRecord = { ...raw, level };
  buffer.push(rec);
  if (buffer.length > MAX_BUFFER) buffer.shift();

  counters.total++;
  counters.byLevel[level] = (counters.byLevel[level] ?? 0) + 1;
  if (typeof rec.component === 'string') {
    counters.byComponent[rec.component] = (counters.byComponent[rec.component] ?? 0) + 1;
  }
  const isError = level === 'error' || level === 'fatal';
  if (isError) {
    errorTimestamps.push(Date.now());
    const key = typeof rec.msg === 'string' && rec.msg ? rec.msg : '(no message)';
    const existing = topErrors.get(key);
    if (existing) {
      existing.count++;
      existing.lastSeen = Date.now();
    } else if (topErrors.size < MAX_ERROR_KEYS) {
      topErrors.set(key, { count: 1, lastSeen: Date.now() });
    }
  }

  // Per-tool rollup (tool-executor logs { tool, durationMs }).
  if (typeof rec.tool === 'string') {
    const s = toolStats.get(rec.tool) ?? { calls: 0, errors: 0, totalMs: 0 };
    s.calls++;
    if (isError) s.errors++;
    if (typeof rec.durationMs === 'number') s.totalMs += rec.durationMs;
    toolStats.set(rec.tool, s);
  }

  // Per-provider rollup (model providers log { provider }).
  if (typeof rec.provider === 'string') {
    const s = providerStats.get(rec.provider) ?? { calls: 0, errors: 0 };
    s.calls++;
    if (isError) s.errors++;
    providerStats.set(rec.provider, s);
  }

  logEvents.emit('log', rec);
}

export const ringBufferStream = new Writable({
  write(chunk, _enc, cb) {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    for (const part of text.split('\n')) ingest(part);
    cb();
  },
});

export function getRecent(limit = 200): LogRecord[] {
  const n = Math.max(1, Math.min(MAX_BUFFER, limit));
  return buffer.slice(-n);
}

export function getStats() {
  const now = Date.now();
  while (errorTimestamps.length && now - errorTimestamps[0] > ERROR_WINDOW_MS) {
    errorTimestamps.shift();
  }
  const uptimeSec = Math.max(1, Math.floor((now - counters.startedAt) / 1000));
  const topErrorList = [...topErrors.entries()]
    .map(([msg, v]) => ({ msg, count: v.count, lastSeen: v.lastSeen }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const tools = [...toolStats.entries()]
    .map(([tool, s]) => ({
      tool,
      calls: s.calls,
      errors: s.errors,
      errorRate: s.calls ? s.errors / s.calls : 0,
      avgMs: s.calls ? Math.round(s.totalMs / s.calls) : 0,
    }))
    .sort((a, b) => b.calls - a.calls);

  const providers = [...providerStats.entries()]
    .map(([provider, s]) => ({
      provider,
      calls: s.calls,
      errors: s.errors,
      errorRate: s.calls ? s.errors / s.calls : 0,
    }))
    .sort((a, b) => b.calls - a.calls);

  return {
    total: counters.total,
    byLevel: counters.byLevel,
    byComponent: counters.byComponent,
    errorsLastMinute: errorTimestamps.length,
    bufferSize: buffer.length,
    uptimeSec,
    logsPerSecond: counters.total / uptimeSec,
    topErrors: topErrorList,
    tools,
    providers,
  };
}
