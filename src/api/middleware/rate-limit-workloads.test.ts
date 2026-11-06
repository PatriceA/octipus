import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Elysia } from '@/api/http';
import { ANONYMOUS_PRINCIPAL, type Principal } from '@/security/principal';

const state = vi.hoisted(() => ({ counts: new Map<string, number>(), quota: 1000 }));
vi.mock('@/security/rate-limiter', () => ({ getRateLimiter: () => ({
  check: async (key: string, limit: number) => {
    const count = (state.counts.get(key) ?? 0) + 1;
    state.counts.set(key, count);
    return { allowed: count <= limit, remaining: Math.max(0, limit - count), retryAfter: 60 };
  },
}) }));
vi.mock('@/security/quotas', () => ({ getQuotaManager: () => ({
  getEffectiveQuota: async () => ({ maxApiCallsPerMinute: state.quota }),
}) }));
import { apiRateWorkload, rateLimitMiddleware } from './rate-limit';

const admin: Principal = { kind: 'user', userId: 'owner', username: 'owner', isAdmin: true };
const indexing = '/api/connectors/cocoindex/document/embeddings';
function app(principal: Principal = admin) {
  return new Elysia().derive(() => ({ principal })).use(rateLimitMiddleware)
    .post(indexing, ({ set }) => {
      if (principal.kind === 'anonymous') { set.status = 401; return { error: 'Not authenticated' }; }
      return { ok: true };
    })
    .get('/api/companion/settings', () => ({ ok: true }));
}
const call = (server: ReturnType<typeof app>, path: string, method = 'GET') => server.handle(new Request(`http://localhost${path}`, { method }));

beforeEach(() => { state.counts.clear(); state.quota = 1000; });

describe('indexing and interactive API limits', () => {
  test('a stale indexing token remains rejected and bounded without starving authenticated UI reads', async () => {
    const indexer = app(ANONYMOUS_PRINCIPAL);
    const browser = app();
    for (let i = 0; i < 600; i++) expect((await call(indexer, indexing, 'POST')).status).toBe(401);
    expect((await call(indexer, indexing, 'POST')).status).toBe(429);
    expect((await call(browser, '/api/companion/settings')).status).toBe(200);
  });
  test('an indexing burst is still capped without blocking the UI after restart', async () => {
    const server = app();
    for (let i = 0; i < 600; i++) expect((await call(server, indexing, 'POST')).status).toBe(200);
    const limited = await call(server, indexing, 'POST');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('60');
    expect((await call(server, '/api/companion/settings')).status).toBe(200);
  });

  test('both workloads enforce the owner quota independently', async () => {
    state.quota = 1;
    const server = app();
    expect((await call(server, indexing, 'POST')).status).toBe(200);
    expect((await call(server, indexing, 'POST')).status).toBe(429);
    expect((await call(server, '/api/companion/settings')).status).toBe(200);
    expect((await call(server, '/api/companion/settings')).status).toBe(429);
  });

  test('untrusted requests cannot choose or multiply workload buckets', () => {
    expect(apiRateWorkload(indexing, 'POST')).toBe('indexing');
    expect(apiRateWorkload(indexing, 'GET')).toBe('api');
    expect(apiRateWorkload(`${indexing}/anything`, 'POST')).toBe('api');
    expect(apiRateWorkload('/api/models', 'POST')).toBe('api');
  });
});
