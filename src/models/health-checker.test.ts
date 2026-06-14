import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { RedisCache } from '@/db/redis';
import { initializeStorage } from '@/db/storage';
import { getHealthChecker, HealthChecker } from './health-checker';

// checkProvider('litellm', …) reaches getConfig() for the proxy URL/key, which
// validates the full config schema (security secrets ≥32 chars). Seed them like
// the other suites do so the LiteLLM branch can resolve config under `bun test`.
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
  // In-memory cache so RedisCache works without a real Valkey/Redis.
  initializeStorage({ mode: 'embedded' });
});

beforeEach(async () => {
  await new RedisCache().delete(ROUTES_CACHE_KEY);
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
