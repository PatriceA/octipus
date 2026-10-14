import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Cache } from '@/db/cache';
import { closeStorage, initializeStorage } from '@/db/storage';
import { getHealthChecker, HealthChecker } from './health-checker';

// A provider with its own client (`direct`) and none for anything else, so a
// model of another provider is one served through the LiteLLM proxy.
const direct = vi.hoisted(() => ({ calls: 0, healthy: true }));
vi.mock('@/models/providers', () => ({
  getProviderRouter: () => ({
    getProviderByName: (name: string) => name === 'direct'
      ? { checkHealth: async () => { direct.calls++; return direct.healthy ? { healthy: true, latencyMs: 12 } : { healthy: false, error: 'API key not configured' }; } }
      : undefined,
  }),
}));

// checkProvider('litellm', …) reaches getConfig() for the proxy URL/key, which
// validates the full config schema (security secrets ≥32 chars). Seed them like
// the other suites do so the LiteLLM branch can resolve config under `npm test`.
const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

/**
 * Health-checker tests focused on the LiteLLM-routed branch.
 *
 * Regression context: models registered under provider `litellm`
 * (e.g. `deepseek-chat`, `deepseek-v4-pro-litellm`) were being probed
 * with a real `maxTokens:1` completion every 60s, burning upstream
 * tokens — the `deepseek` skip-set entry never matched because the row's
 * provider is `litellm`, not `deepseek`. The fix derives their status from
 * the proxy `/health` endpoint + circuit breaker, issuing zero completions.
 *
 * The provider `/health` response is cached under a single key, so we clear
 * it between tests. `globalThis.fetch` is stubbed and restored per test.
 */

const ROUTES_CACHE_KEY = 'health:litellm:routes';
const LITELLM_MODELS = [
  { name: 'deepseek-chat', modelId: 'deepseek-chat' },
  { name: 'deepseek-v4-pro-litellm', modelId: 'deepseek-v4-pro' },
];

const realFetch = globalThis.fetch;

function stubFetch(impl: (url: string) => Promise<Response> | Response): void {
  globalThis.fetch = ((input: RequestInfo | URL) =>
    Promise.resolve(impl(String(input)))) as typeof fetch;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeAll(() => {
  // In-memory cache so Cache works without an external storage provider.
  initializeStorage({ mode: 'embedded' });
});

afterAll(async () => {
  // Reset the process-global storage provider. `initializeStorage` is
  // idempotent (`if (provider) return provider`), so leaving the embedded
  // provider installed would starve a later integration suite's
  // `setupIntegrationStorage()` — its external re-init becomes a no-op and
  // `getRedis()` returns a non-persisting proxy (e.g. the scheduler heartbeat
  // then reads null). Closing it here restores symmetry with quota-enforcement.
  await closeStorage();
});

beforeEach(async () => {
  await new Cache().delete(ROUTES_CACHE_KEY);
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('HealthChecker — LiteLLM routes', () => {
  test('does NOT issue a completion for litellm-routed models', async () => {
    const calls: string[] = [];
    stubFetch((url) => {
      calls.push(url);
      return jsonResponse({ healthy_endpoints: [], unhealthy_endpoints: [] });
    });

    await new HealthChecker().checkProvider('litellm', LITELLM_MODELS);

    // Only the proxy /health endpoint is touched — never /chat/completions.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some((u) => u.endsWith('/health'))).toBe(true);
    expect(calls.some((u) => u.includes('/completions') || u.includes('/chat'))).toBe(false);
  });

  test('reports healthy when the proxy lists no unhealthy endpoints', async () => {
    stubFetch(() =>
      jsonResponse({
        healthy_endpoints: [{ model: 'deepseek/deepseek-chat' }, { model: 'deepseek/deepseek-v4-pro' }],
        unhealthy_endpoints: [],
      }),
    );

    const result = await new HealthChecker().checkProvider('litellm', LITELLM_MODELS);

    expect(result.provider).toBe('litellm');
    expect(result.status).toBe('healthy');
    expect(result.models.every((m) => m.status === 'healthy')).toBe(true);
  });

  test('marks the matching model unhealthy and degrades the provider', async () => {
    stubFetch(() =>
      jsonResponse({
        healthy_endpoints: [{ model: 'deepseek/deepseek-v4-pro' }],
        unhealthy_endpoints: [{ model: 'deepseek/deepseek-chat', error: 'invalid api key' }],
      }),
    );

    const result = await new HealthChecker().checkProvider('litellm', LITELLM_MODELS);

    expect(result.status).toBe('degraded');
    const chat = result.models.find((m) => m.name === 'deepseek-chat');
    expect(chat?.status).toBe('unhealthy');
    expect(chat?.error).toBe('invalid api key');
    expect(result.models.find((m) => m.name === 'deepseek-v4-pro')?.status).toBe('healthy');
  });

  test('reports degraded (not healthy) when the proxy is unreachable', async () => {
    stubFetch(() => {
      throw new Error('fetch failed');
    });

    const result = await new HealthChecker().checkProvider('litellm', LITELLM_MODELS);

    expect(result.status).toBe('unhealthy'); // all models degraded → 0 healthy → unhealthy provider
    expect(result.models.every((m) => m.status === 'degraded')).toBe(true);
    expect(result.models[0]?.error).toMatch(/unavailable/);
  });

  test('getHealthChecker returns a singleton', () => {
    expect(getHealthChecker()).toBe(getHealthChecker());
  });
});

describe('HealthChecker — other providers', () => {
  const MODELS = [
    { name: 'a', modelId: 'a' },
    { name: 'b', modelId: 'b' },
    { name: 'c-embed', modelId: 'c-embed', topics: ['embedding'] },
  ];
  beforeEach(async () => {
    direct.calls = 0;
    direct.healthy = true;
    for (const p of ['direct', 'routed']) await new Cache().delete(`health:provider:${p}`);
  });

  test('a provider with its own client is asked once, whatever its model count', async () => {
    const checker = new HealthChecker();
    const result = await checker.checkProvider('direct', MODELS);
    expect(direct.calls).toBe(1);
    expect(result.status).toBe('healthy');
    expect(result.models.map((m) => [m.name, m.status, m.latency])).toEqual([['a', 'healthy', 12], ['b', 'healthy', 12], ['c-embed', 'healthy', 12]]);
    // Cached: a second check (the next tick, another dashboard) asks nobody.
    await checker.checkProvider('direct', MODELS);
    expect(direct.calls).toBe(1);
  });

  test('a failing provider client marks every model with its error', async () => {
    direct.healthy = false;
    const result = await new HealthChecker().checkProvider('direct', MODELS);
    expect(result.status).toBe('unhealthy');
    expect(result.error).toBe('API key not configured');
    expect(result.models.every((m) => m.status === 'unhealthy')).toBe(true);
  });

  test('a provider served through the proxy is never sent a completion or an embedding', async () => {
    const calls: string[] = [];
    stubFetch((url) => {
      calls.push(url);
      return jsonResponse({});
    });
    const result = await new HealthChecker().checkProvider('routed', MODELS);
    expect(calls.every((u) => u.endsWith('/health/liveliness'))).toBe(true);
    expect(calls.length).toBe(1);
    expect(result.status).toBe('healthy');
  });

  test('…and is unhealthy when the proxy cannot be reached', async () => {
    stubFetch(() => {
      throw new Error('fetch failed');
    });
    const result = await new HealthChecker().checkProvider('routed', MODELS);
    expect(result.status).toBe('unhealthy');
    expect(result.models[0]?.error).toMatch(/LiteLLM proxy/);
  });
});
