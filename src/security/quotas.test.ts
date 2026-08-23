/**
 * Phase 3c-1 — QuotaManager tests.
 *
 * Verifies:
 *   - getEffectiveQuota inherits global config when no override row.
 *   - setOverride writes per-field overrides; null clears a field.
 *   - getUsage counts running agents, sums totalTokens for the day,
 *     and counts api_request audit rows from the last minute.
 *   - willExceed returns allowed/denied with the right structured
 *     reason, against the effective cap (override or default).
 *   - clearOverride drops the row entirely.
 *
 * Backed by ephemeral PGlite — no Docker.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const aliceId = '11111111-1111-1111-1111-111111111111';
const bobId = '22222222-2222-2222-2222-222222222222';

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-quotas-'));

  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();

  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([
    { id: aliceId, username: 'alice' },
    { id: bobId, username: 'bob' },
  ]);
  const { _resetQuotaManagerForTests } = await import('@/security/quotas');
  _resetQuotaManagerForTests();
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('getEffectiveQuota', () => {
  test('inherits global config when no override row exists', async () => {
    const { getQuotaManager } = await import('@/security/quotas');
    const { getConfig } = await import('@/config');
    const cfg = getConfig();

    const q = await getQuotaManager().getEffectiveQuota(aliceId);
    expect(q.maxConcurrentAgents).toBe(cfg.agent.maxConcurrentAgents);
    // maxTokenBudget=0 maps to MAX_SAFE_INTEGER (unlimited).
    if (cfg.agent.maxTokenBudget > 0) {
      expect(q.maxTokensPerDay).toBe(cfg.agent.maxTokenBudget);
    } else {
      expect(q.maxTokensPerDay).toBe(Number.MAX_SAFE_INTEGER);
    }
    expect(q.maxApiCallsPerMinute).toBe(cfg.api.rateLimitMax);
    expect(q.overrides.maxConcurrentAgents).toBe(false);
    expect(q.overrides.maxTokensPerDay).toBe(false);
    expect(q.overrides.maxApiCallsPerMinute).toBe(false);
  });
});

describe('setOverride', () => {
  test('first call inserts a row; subsequent calls update', async () => {
    const { getQuotaManager } = await import('@/security/quotas');
    const mgr = getQuotaManager();

    let row = await mgr.setOverride(aliceId, { maxConcurrentAgents: 3 });
    expect(row.maxConcurrentAgents).toBe(3);
    expect(row.maxTokensPerDay).toBeNull();

    row = await mgr.setOverride(aliceId, { maxTokensPerDay: 50_000 });
    // Existing override preserved; new one added.
    expect(row.maxConcurrentAgents).toBe(3);
    expect(row.maxTokensPerDay).toBe(50_000);
  });

  test('passing null clears that field (revert to default)', async () => {
    const { getQuotaManager } = await import('@/security/quotas');
    const mgr = getQuotaManager();

    await mgr.setOverride(aliceId, { maxConcurrentAgents: 7 });
    const cleared = await mgr.setOverride(aliceId, { maxConcurrentAgents: null });
    expect(cleared.maxConcurrentAgents).toBeNull();

    const eff = await mgr.getEffectiveQuota(aliceId);
    expect(eff.overrides.maxConcurrentAgents).toBe(false);
  });
});

describe('getUsage', () => {
  test('counts running agents, daily tokens, and api_request audit rows', async () => {
    const { getDb } = await import('@/db/postgres');
    const { agents } = await import('@/db/schema/agents');
    const { auditLog } = await import('@/db/schema/audit');
    const { seedSession } = await import('@/test-helpers/multiuser-fixtures');
    const db = getDb();

    const aliceSession = await seedSession({ userId: aliceId, channelId: 'q-a-1' });

    // Running agent (counts) + completed agent (doesn't count toward
    // concurrent, but tokens DO count toward daily).
    await db.insert(agents).values([
      {
        id: 'qm-alice-running-1', sessionId: aliceSession.id, userId: aliceId,
        role: 'general', model: 'test', topic: 'test',
        status: 'running', totalTokens: 1234,
      },
      {
        id: 'qm-alice-done-1', sessionId: aliceSession.id, userId: aliceId,
        role: 'general', model: 'test', topic: 'test',
        status: 'completed', totalTokens: 4321,
      },
    ]);

    // API requests for alice (count) and bob (don't count).
    await db.insert(auditLog).values([
      { userId: aliceId, action: 'api_request' },
      { userId: aliceId, action: 'api_request' },
      { userId: bobId,   action: 'api_request' },
    ]);

    const { getQuotaManager } = await import('@/security/quotas');
    const usage = await getQuotaManager().getUsage(aliceId);
    expect(usage.concurrentAgents).toBe(1); // only the running one
    expect(usage.tokensToday).toBe(1234 + 4321);
    expect(usage.apiCallsLastMinute).toBe(2);
  });
});

describe('willExceed', () => {
  test('allowed when current + delta is at or below cap', async () => {
    const { getQuotaManager } = await import('@/security/quotas');
    const mgr = getQuotaManager();
    await mgr.setOverride(bobId, { maxConcurrentAgents: 5 });

    // No running agents seeded for bob → current=0, delta=5 → allowed (5 <= 5).
    const ok = await mgr.willExceed(bobId, 'concurrentAgents', 5);
    expect(ok.allowed).toBe(true);
  });

  test('denied returns structured reason with current + max', async () => {
    const { getQuotaManager } = await import('@/security/quotas');
    const mgr = getQuotaManager();
    await mgr.setOverride(bobId, { maxConcurrentAgents: 1 });

    // Add a running agent for bob.
    const { getDb } = await import('@/db/postgres');
    const { agents } = await import('@/db/schema/agents');
    const { seedSession } = await import('@/test-helpers/multiuser-fixtures');
    const bobSession = await seedSession({ userId: bobId, channelId: 'q-b-1' });
    await getDb().insert(agents).values({
      id: 'qm-bob-running-1', sessionId: bobSession.id, userId: bobId,
      role: 'general', model: 'test', topic: 'test', status: 'running', totalTokens: 0,
    });

    const denied = await mgr.willExceed(bobId, 'concurrentAgents', 1);
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      expect(denied.reason.kind).toBe('concurrentAgents');
      expect(denied.reason.current).toBe(1);
      expect(denied.reason.max).toBe(1);
    }
  });
});

describe('clearOverride', () => {
  test('drops the row; subsequent getEffectiveQuota inherits defaults again', async () => {
    const { getQuotaManager } = await import('@/security/quotas');
    const mgr = getQuotaManager();
    await mgr.setOverride(aliceId, { maxConcurrentAgents: 99 });

    expect(await mgr.clearOverride(aliceId)).toBe(true);
    const eff = await mgr.getEffectiveQuota(aliceId);
    expect(eff.overrides.maxConcurrentAgents).toBe(false);
    // Second clear is a no-op.
    expect(await mgr.clearOverride(aliceId)).toBe(false);
  });
});
