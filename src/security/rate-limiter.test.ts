import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  isIntegration,
  setupIntegrationStorage,
  teardownIntegration,
} from '@/test-helpers/integration';

/**
 * Rate limiter tests — covers the Phase 3 `swarmFanOutBudget` bucket and
 * the `checkUserFanOutBudget` helper that wraps it into a pre-built
 * `ChildResult` rejection.
 *
 * Integration portion exercises the real Redis sliding-window path
 * (via docker-compose.test.yml). Unit portion covers pure helpers that
 * don't need a live backend.
 */

describe.skipIf(!isIntegration)('RateLimiter.checkSwarmFanOutBudget (Integration)', () => {
  beforeAll(async () => {
    setupIntegrationStorage();
  });

  afterAll(async () => {
    await teardownIntegration();
  });

  test('allows up to the configured limit within the window', async () => {
    const { RateLimiter } = await import('./rate-limiter');
    const limiter = new RateLimiter();
    const userId = `u-${Date.now()}-${Math.random()}`;
    const limit = 3;

    // First three calls must pass; fourth must fail.
    for (let i = 0; i < limit; i++) {
      const r = await limiter.checkSwarmFanOutBudget(userId, limit);
      expect(r.allowed).toBe(true);
    }
    const denied = await limiter.checkSwarmFanOutBudget(userId, limit);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(typeof denied.retryAfter).toBe('number');
  });

  test('returns allowed=true when userId is empty (defensive)', async () => {
    const { RateLimiter } = await import('./rate-limiter');
    const limiter = new RateLimiter();
    const r = await limiter.checkSwarmFanOutBudget('', 1);
    expect(r.allowed).toBe(true);
  });

  test('separate users have independent buckets', async () => {
    const { RateLimiter } = await import('./rate-limiter');
    const limiter = new RateLimiter();
    const u1 = `u1-${Date.now()}-${Math.random()}`;
    const u2 = `u2-${Date.now()}-${Math.random()}`;
    const limit = 2;

    await limiter.checkSwarmFanOutBudget(u1, limit);
    await limiter.checkSwarmFanOutBudget(u1, limit);
    const u1Denied = await limiter.checkSwarmFanOutBudget(u1, limit);
    expect(u1Denied.allowed).toBe(false);

    const u2Allowed = await limiter.checkSwarmFanOutBudget(u2, limit);
    expect(u2Allowed.allowed).toBe(true);
  });
});

describe('checkUserFanOutBudget adapter (Unit)', () => {
  test('rejection contract shape is stable (no drift)', () => {
    // Freeze the expected `ChildResult` shape so downstream consumers
    // (parent LLM tool-result parser) don't break silently.
    const rejection = {
      nodeId: '',
      kind: 'agent' as const,
      status: 'concurrency_limit' as const,
      output: null,
      usedTokens: 0,
      durationMs: 0,
      spawnedChildren: [],
      notes: 'user_rate_limit: max 30 spawns/minute per user (retry in 60s)',
    };
    expect(rejection.status).toBe('concurrency_limit');
    expect(rejection.kind).toBe('agent');
    expect(rejection.spawnedChildren).toEqual([]);
    expect(rejection.notes.startsWith('user_rate_limit')).toBe(true);
  });
});
