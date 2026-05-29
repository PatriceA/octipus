import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { metricsRoutes } from './metrics';

const prev = process.env.METRICS_TOKEN;
afterEach(() => {
  if (prev === undefined) delete process.env.METRICS_TOKEN;
  else process.env.METRICS_TOKEN = prev;
});

describe('metrics route (M11)', () => {
  test('404 when METRICS_TOKEN is unset (disabled by default)', async () => {
    delete process.env.METRICS_TOKEN;
    const res = await metricsRoutes.handle(new Request('http://x/metrics'));
    expect(res.status).toBe(404);
  });

  test('401 with a missing/wrong token', async () => {
    process.env.METRICS_TOKEN = 'scrape-secret-token';
    const noTok = await metricsRoutes.handle(new Request('http://x/metrics'));
    expect(noTok.status).toBe(401);
    const wrong = await metricsRoutes.handle(
      new Request('http://x/metrics', { headers: { authorization: 'Bearer nope' } }),
    );
    expect(wrong.status).toBe(401);
  });

  test('200 + Prometheus exposition with the correct token', async () => {
    process.env.METRICS_TOKEN = 'scrape-secret-token';
    const res = await metricsRoutes.handle(
      new Request('http://x/metrics', { headers: { authorization: 'Bearer scrape-secret-token' } }),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('octipus_up 1');
    expect(body).toContain('# TYPE process_resident_memory_bytes gauge');
    expect(body).toContain('octipus_db_up');
  });

  test('accepts the token via ?token= query param', async () => {
    process.env.METRICS_TOKEN = 'scrape-secret-token';
    const res = await metricsRoutes.handle(
      new Request('http://x/metrics?token=scrape-secret-token'),
    );
    expect(res.status).toBe(200);
  });
});
