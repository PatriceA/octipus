/**
 * Dollar spend budgets — checkSpend tests.
 *
 * Verifies:
 *   - under the limit → ok, no warning.
 *   - at warn_ratio (80%) → one warning notification, not repeated.
 *   - at or over 100% → throws SpendBudgetExceededError, stamps paused_at,
 *     stays paused on the next check.
 *   - the period rolls over: yesterday's pause and spend no longer count.
 *   - role scope sums only cost_log rows of agents with that role.
 *
 * Each test seeds its own user so cost_log sums don't bleed between tests.
 * Backed by ephemeral PGlite — no Docker.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const NOON = new Date('2026-07-12T12:00:00Z');
const EARLIER = new Date('2026-07-12T09:00:00Z');

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-spend-'));

  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
});

beforeEach(async () => {
  const { _resetSpendBudgetsForTests } = await import('@/security/spend-budgets');
  _resetSpendBudgetsForTests();
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

async function newUser(): Promise<string> {
  const id = randomUUID();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id, username: `u-${id.slice(0, 8)}` }]);
  return id;
}

async function logCost(userId: string, totalCost: number, opts: { agentId?: string; at?: Date } = {}) {
  const { getDb } = await import('@/db/postgres');
  const { costLog } = await import('@/db/schema/models');
  await getDb().insert(costLog).values({
    userId, agentId: opts.agentId, modelName: 'test', inputTokens: 1, outputTokens: 1,
    totalCost, createdAt: opts.at ?? EARLIER,
  });
}

async function notificationsOf(userId: string, type: string) {
  const { getDb } = await import('@/db/postgres');
  const { notifications } = await import('@/db/schema/notifications');
  return getDb().select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.type, type)));
}

describe('checkSpend', () => {
  test('under the limit → ok, no warning', async () => {
    const { checkSpend, upsertBudget } = await import('@/security/spend-budgets');
    const userId = await newUser();
    await upsertBudget({ userId, scopeKind: 'user', period: 'day', limitUsd: 10 });
    await logCost(userId, 3);

    const [status] = await checkSpend({ userId }, NOON);
    expect(status.state).toBe('ok');
    expect(status.spentUsd).toBeCloseTo(3);
    expect(status.limitUsd).toBe(10);
    expect(await notificationsOf(userId, 'spend_budget_warning')).toHaveLength(0);
  });

  test('at 80% → one warning, not repeated', async () => {
    const { checkSpend, upsertBudget, _resetSpendBudgetsForTests } = await import('@/security/spend-budgets');
    const userId = await newUser();
    await upsertBudget({ userId, scopeKind: 'user', period: 'day', limitUsd: 10 });
    await logCost(userId, 8);

    expect((await checkSpend({ userId }, NOON))[0].state).toBe('warn');
    _resetSpendBudgetsForTests();
    const [again] = await checkSpend({ userId }, NOON);
    expect(again.state).toBe('warn');
    expect(again.budget.warnedAt).not.toBeNull();
    expect(await notificationsOf(userId, 'spend_budget_warning')).toHaveLength(1);
  });

  test('over 100% → throws and sets paused_at; stays paused', async () => {
    const { checkSpend, upsertBudget, listBudgets } = await import('@/security/spend-budgets');
    const { SpendBudgetExceededError } = await import('@/security/spend-budget-error');
    const userId = await newUser();
    await upsertBudget({ userId, scopeKind: 'user', period: 'month', limitUsd: 5 });
    await logCost(userId, 6);

    const err = await checkSpend({ userId }, NOON).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpendBudgetExceededError);
    const reason = (err as InstanceType<typeof SpendBudgetExceededError>).reason;
    expect(reason.spentUsd).toBeCloseTo(6);
    expect(reason.limitUsd).toBe(5);
    expect(reason.period).toBe('month');

    const [row] = await listBudgets(userId);
    expect(row.pausedAt).not.toBeNull();
    await expect(checkSpend({ userId }, NOON)).rejects.toBeInstanceOf(SpendBudgetExceededError);
    expect(await notificationsOf(userId, 'spend_budget_paused')).toHaveLength(1);
  });

  test('the period rolls over: yesterday’s spend and pause no longer count', async () => {
    const { checkSpend, upsertBudget } = await import('@/security/spend-budgets');
    const userId = await newUser();
    await upsertBudget({ userId, scopeKind: 'user', period: 'day', limitUsd: 5 });
    await logCost(userId, 6);
    await expect(checkSpend({ userId }, NOON)).rejects.toThrow(/Spend budget exceeded/);

    const nextDay = new Date('2026-07-13T12:00:00Z');
    const [status] = await checkSpend({ userId }, nextDay);
    expect(status.state).toBe('ok');
    expect(status.spentUsd).toBe(0);
  });

  test('role scope counts only that role’s agents', async () => {
    const { checkSpend, upsertBudget } = await import('@/security/spend-budgets');
    const { SpendBudgetExceededError } = await import('@/security/spend-budget-error');
    const { seedSession } = await import('@/test-helpers/multiuser-fixtures');
    const { getDb } = await import('@/db/postgres');
    const { agents } = await import('@/db/schema/agents');
    const userId = await newUser();
    const sess = await seedSession({ userId });
    const coder = `coder-${rand(4)}`;
    const general = `general-${rand(4)}`;
    await getDb().insert(agents).values([
      { id: coder, sessionId: sess.id, userId, role: 'coder', model: 'test', topic: 'test', status: 'completed' },
      { id: general, sessionId: sess.id, userId, role: 'general', model: 'test', topic: 'test', status: 'completed' },
    ]);
    await upsertBudget({ userId, scopeKind: 'role', scopeRef: 'coder', period: 'day', limitUsd: 2 });
    await logCost(userId, 50, { agentId: general });
    await logCost(userId, 1, { agentId: coder });

    // Another role does not see the coder budget at all.
    expect(await checkSpend({ userId, role: 'general' }, NOON)).toEqual([]);
    const [status] = await checkSpend({ userId, role: 'coder' }, NOON);
    expect(status.state).toBe('ok');
    expect(status.spentUsd).toBeCloseTo(1);

    await logCost(userId, 1.5, { agentId: coder });
    const { _resetSpendBudgetsForTests } = await import('@/security/spend-budgets');
    _resetSpendBudgetsForTests();
    await expect(checkSpend({ userId, role: 'coder' }, NOON)).rejects.toBeInstanceOf(SpendBudgetExceededError);
  });

  test('raising the limit clears the pause', async () => {
    const { checkSpend, upsertBudget, _resetSpendBudgetsForTests } = await import('@/security/spend-budgets');
    const userId = await newUser();
    await upsertBudget({ userId, scopeKind: 'user', period: 'day', limitUsd: 5 });
    await logCost(userId, 6);
    await expect(checkSpend({ userId }, NOON)).rejects.toThrow();

    const row = await upsertBudget({ userId, scopeKind: 'user', period: 'day', limitUsd: 100 });
    expect(row.pausedAt).toBeNull();
    _resetSpendBudgetsForTests();
    expect((await checkSpend({ userId }, NOON))[0].state).toBe('ok');
  });

  test('system / local principals have no budgets', async () => {
    const { checkSpend } = await import('@/security/spend-budgets');
    expect(await checkSpend({ userId: 'system' })).toEqual([]);
  });
});
