import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { metricsRoutes } from './metrics';

type ElysiaLike = { handle: (req: Request) => Promise<Response> };

// Mount the route under a parent app so Elysia builds/compiles the route tree
// (calling .handle() on a bare sub-instance does not resolve routes).
const app = new Elysia().group('/api', (a) => a.use(metricsRoutes)) as unknown as ElysiaLike;

const prev = process.env.METRICS_TOKEN;
afterEach(() => {
  if (prev === undefined) delete process.env.METRICS_TOKEN;
  else process.env.METRICS_TOKEN = prev;
});

describe('metrics route (M11)', () => {
  test('404 when METRICS_TOKEN is unset (disabled by default)', async () => {
    delete process.env.METRICS_TOKEN;
    const res = await app.handle(new Request('http://localhost/api/metrics'));
    expect(res.status).toBe(404);
  });

  test('401 with a missing/wrong token', async () => {
    process.env.METRICS_TOKEN = 'scrape-secret-token';
    const noTok = await app.handle(new Request('http://localhost/api/metrics'));
    expect(noTok.status).toBe(401);
    const wrong = await app.handle(
      new Request('http://localhost/api/metrics', { headers: { authorization: 'Bearer nope' } }),
    );
    expect(wrong.status).toBe(401);
  });

  test('200 + Prometheus exposition with the correct token', async () => {
    process.env.METRICS_TOKEN = 'scrape-secret-token';
    const res = await app.handle(
      new Request('http://localhost/api/metrics', { headers: { authorization: 'Bearer scrape-secret-token' } }),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('octipus_up 1');
    expect(body).toContain('# TYPE process_resident_memory_bytes gauge');
    expect(body).toContain('octipus_db_up');
  });

  test('accepts the token via ?token= query param', async () => {
    process.env.METRICS_TOKEN = 'scrape-secret-token';
    const res = await app.handle(
      new Request('http://localhost/api/metrics?token=scrape-secret-token'),
    );
    expect(res.status).toBe(200);
  });
});

/**
 * Reachability, not behaviour. Every assertion above exercises the route
 * object directly — which is exactly how this endpoint shipped unmounted and
 * unreachable for its whole life while its tests stayed green.
 */
describe('metrics route is actually mounted', () => {
  test('is registered on the API server and public to the auth guard', async () => {
    const server = await Bun.file(`${import.meta.dir}/../server.ts`).text();
    expect(server).toContain('.use(metricsRoutes)');

    const { isPublicPath } = await import('../middleware/auth-guard');
    // A scraper cannot log in; if the guard is not told, the route's own token
    // check is never reached and the endpoint answers 401 forever.
    expect(isPublicPath('/api/metrics')).toBe(true);
    // And nothing else got waved through by the same prefix rule.
    expect(isPublicPath('/api/models')).toBe(false);
  });
});
