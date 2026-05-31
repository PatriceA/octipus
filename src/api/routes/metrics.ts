import { Elysia } from 'elysia';
import { checkDbHealth } from '@/db/postgres';
import { checkRedisHealth } from '@/db/redis';
import { secureCompare } from '@/utils/crypto';

/**
 * Prometheus metrics endpoint (M11).
 *
 * Disabled by default: returns 404 unless `METRICS_TOKEN` is set. When set, the
 * scraper must present it as `Authorization: Bearer <token>` or `?token=…`.
 * Token-gated rather than session-gated so a Prometheus scraper (which can't do
 * the normal login flow) can reach it without exposing internals to the world.
 */
const PROCESS_START = Date.now();

function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Resolve a probe to `0` if it rejects OR exceeds `ms` — a scrape must never
 *  block on a wedged dependency, and unit tests have no live DB/Redis. */
function withTimeout(probe: Promise<number>, ms: number): Promise<number> {
  return Promise.race([
    probe.catch(() => 0),
    new Promise<number>((resolve) => setTimeout(() => resolve(0), ms).unref?.()),
  ]);
}

async function renderMetrics(): Promise<string> {
  const mem = process.memoryUsage();
  const version = process.env.npm_package_version || '0.0.0';

  const [db, redisUp] = await Promise.all([
    withTimeout(checkDbHealth().then((h) => (h.healthy ? 1 : 0)), 2000),
    withTimeout(
      checkRedisHealth().then((h) => (h.healthy ? 1 : 0)),
      2000,
    ),
  ]);

  const lines = [
    '# HELP octipus_up 1 if the API process is serving.',
    '# TYPE octipus_up gauge',
    'octipus_up 1',
    '# HELP octipus_build_info Build information.',
    '# TYPE octipus_build_info gauge',
    `octipus_build_info{version="${escapeLabel(version)}"} 1`,
    '# HELP octipus_process_uptime_seconds Seconds since the process started.',
    '# TYPE octipus_process_uptime_seconds gauge',
    `octipus_process_uptime_seconds ${(Date.now() - PROCESS_START) / 1000}`,
    '# HELP process_resident_memory_bytes Resident set size in bytes.',
    '# TYPE process_resident_memory_bytes gauge',
    `process_resident_memory_bytes ${mem.rss}`,
    '# HELP nodejs_heap_used_bytes Heap memory used in bytes.',
    '# TYPE nodejs_heap_used_bytes gauge',
    `nodejs_heap_used_bytes ${mem.heapUsed}`,
    '# HELP nodejs_heap_total_bytes Heap memory total in bytes.',
    '# TYPE nodejs_heap_total_bytes gauge',
    `nodejs_heap_total_bytes ${mem.heapTotal}`,
    '# HELP octipus_db_up 1 if the primary database is reachable.',
    '# TYPE octipus_db_up gauge',
    `octipus_db_up ${db}`,
    '# HELP octipus_redis_up 1 if Redis/Valkey is reachable.',
    '# TYPE octipus_redis_up gauge',
    `octipus_redis_up ${redisUp}`,
  ];
  return `${lines.join('\n')}\n`;
}

export const metricsRoutes = new Elysia({ prefix: '/metrics' }).get('/', async ({ request, set }) => {
  const expected = process.env.METRICS_TOKEN;
  if (!expected) {
    set.status = 404;
    return 'metrics disabled (set METRICS_TOKEN to enable)';
  }

  const url = new URL(request.url);
  const header = request.headers.get('authorization') || '';
  const presented = header.startsWith('Bearer ')
    ? header.slice(7)
    : url.searchParams.get('token') || '';

  if (!presented || !secureCompare(presented, expected)) {
    set.status = 401;
    return 'unauthorized';
  }

  set.headers['Content-Type'] = 'text/plain; version=0.0.4; charset=utf-8';
  return renderMetrics();
});
