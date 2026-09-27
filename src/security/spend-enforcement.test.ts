/**
 * Dollar spend budgets — runtime enforcement.
 *
 * agent-manager.spawn() refuses with SpendBudgetExceededError once the
 * user's budget is spent — before any worker exists — and the heartbeat
 * gate skips its tick. The per-LLM-call (agent-worker) and CLI-start
 * (cli-agent-worker) sites call the same checkSpend contract.
 *
 * Backed by ephemeral PGlite.
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

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-spend-enf-'));

  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();

  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: aliceId, username: 'alice' }]);
  const { _resetQuotaManagerForTests } = await import('@/security/quotas');
  _resetQuotaManagerForTests();

  const { upsertBudget } = await import('@/security/spend-budgets');
  await upsertBudget({ userId: aliceId, scopeKind: 'user', period: 'day', limitUsd: 1 });
  const { getDb } = await import('@/db/postgres');
  const { costLog } = await import('@/db/schema/models');
  await getDb().insert(costLog).values({
    userId: aliceId, modelName: 'test', inputTokens: 1, outputTokens: 1, totalCost: 1.25,
  });
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('gate: dollar spend budget', () => {
  test('agent-manager.spawn refuses once the budget is spent', async () => {
    const { AgentManager } = await import('@/core/agent-manager');
    const { SpendBudgetExceededError } = await import('@/security/spend-budget-error');
    const { seedSession } = await import('@/test-helpers/multiuser-fixtures');
    const sess = await seedSession({ userId: aliceId });

    const err = await new AgentManager().spawn({ sessionId: sess.id, userId: aliceId, role: 'general' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpendBudgetExceededError);
    expect((err as InstanceType<typeof SpendBudgetExceededError>).code).toBe('SPEND_BUDGET_EXCEEDED');

    const { listBudgets } = await import('@/security/spend-budgets');
    const [row] = await listBudgets(aliceId);
    expect(row.pausedAt).not.toBeNull();
  });

  test('heartbeat skips its tick while paused', async () => {
    const { evaluateHeartbeatGate } = await import('@/core/heartbeat');
    const hook = { userId: aliceId, triggerConfig: {} } as unknown as import('@/db/schema/hooks').Hook;
    const r = await evaluateHeartbeatGate(hook, {
      enabled: true, intervalMinutes: 60, quietHoursStart: 22, quietHoursEnd: 7, quietHoursTimezone: 'UTC',
      maxRunsPerDay: 24, probeGithub: false, probeCalendar: false, calendarLookaheadMinutes: 60,
    }, new Date(new Date().setUTCHours(12, 0, 0, 0)));
    expect(r.decision).toEqual({ run: false, reason: 'spend_budget' });
  });
});
