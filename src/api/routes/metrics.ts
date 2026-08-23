import { Elysia } from '@/api/http';
import { METRICS_CONTENT_TYPE, renderMetrics } from '@/core/telemetry';
import { checkDbHealth } from '@/db/postgres';
import { checkRedisHealth } from '@/db/redis';
import { secureCompare } from '@/utils/crypto';

/**
 * Prometheus metrics endpoint (M11 · WS4).
 *
 * Disabled by default: returns 404 unless `METRICS_TOKEN` is set. When set, the
 * scraper must present it as `Authorization: Bearer <token>` or `?token=…`.
 * Token-gated rather than session-gated so a Prometheus scraper (which can't do
 * the normal login flow) can reach it without exposing internals to the world.
 *
 * The exposition itself is produced by the shared `prom-client` registry in
 * `src/core/telemetry.ts` — the health/build gauge NAMES are preserved there so
 * existing dashboards survive, and every domain counter/histogram emitted by
 * the app appears here too. This route only owns auth + the DB/Redis probes.
 */

/** Resolve a probe to `0` if it rejects OR exceeds `ms` — a scrape must never
 *  block on a wedged dependency, and unit tests have no live DB/Redis. */
function withTimeout(probe: Promise<number>, ms: number): Promise<number> {
  return Promise.race([
    probe.catch(() => 0),
    new Promise<number>((resolve) => setTimeout(() => resolve(0), ms).unref?.()),
  ]);
}

async function collectExposition(): Promise<string> {
  const [db, redisUp] = await Promise.all([
    withTimeout(checkDbHealth().then((h) => (h.healthy ? 1 : 0)), 2000),
    withTimeout(
      checkRedisHealth().then((h) => (h.healthy ? 1 : 0)),
      2000,
    ),
  ]);
  return renderMetrics(db, redisUp);
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

  set.headers['Content-Type'] = METRICS_CONTENT_TYPE;
  return collectExposition();
});
