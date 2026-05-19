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
  if (level === 'error' || level === 'fatal') {
    errorTimestamps.push(Date.now());
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
  return {
    total: counters.total,
    byLevel: counters.byLevel,
    byComponent: counters.byComponent,
    errorsLastMinute: errorTimestamps.length,
    bufferSize: buffer.length,
    uptimeSec,
    logsPerSecond: counters.total / uptimeSec,
  };
}
