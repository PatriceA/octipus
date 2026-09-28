/**
 * Dollar spend budgets — runtime enforcement.
 *
 * agent-manager.spawn() refuses with SpendBudgetExceededError once the
 * user's budget (or the budget of the role it spawns, 'general' by default)
 * is spent — before any worker exists — and the heartbeat gate skips its
 * tick. A check that fails for any other reason does not block the spawn. The per-LLM-call (agent-worker) and CLI-start
 * (cli-agent-worker) sites call the same checkSpend contract.
 *
 * Backed by ephemeral PGlite.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Lets one test hold the worker inside its pre-LLM-call spend check. A
// transparent wrapper otherwise: every other test runs the real checkSpend.
const gate = vi.hoisted(() => ({
  hold: null as Promise<void> | null,
  entered: null as (() => void) | null,
}));
vi.mock('@/security/spend-budgets', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/security/spend-budgets')>();
  return {
    ...real,
    checkSpend: async (...args: Parameters<typeof real.checkSpend>) => {
      if (gate.hold) {
        gate.entered?.();
        await gate.hold;
      }
      return real.checkSpend(...args);
    },
  };
});

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const aliceId = '11111111-1111-1111-1111-111111111111';
const bobId = '22222222-2222-2222-2222-222222222222';

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-spend-enf-'));

  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();

  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: aliceId, username: 'alice' }, { id: bobId, username: 'bob' }]);
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

  test('spawn applies role budgets to the default role', async () => {
    const { AgentManager } = await import('@/core/agent-manager');
    const { SpendBudgetExceededError } = await import('@/security/spend-budget-error');
    const { seedSession } = await import('@/test-helpers/multiuser-fixtures');
    const { upsertBudget } = await import('@/security/spend-budgets');
    const { getDb } = await import('@/db/postgres');
    const { agents } = await import('@/db/schema/agents');
    const { costLog } = await import('@/db/schema/models');
    const sess = await seedSession({ userId: bobId });
    await getDb().insert(agents).values({
      id: 'se-general', sessionId: sess.id, userId: bobId, role: 'general', model: 'test', topic: 'test', status: 'completed',
    });
    await getDb().insert(costLog).values({
      userId: bobId, agentId: 'se-general', modelName: 'test', inputTokens: 1, outputTokens: 1, totalCost: 3,
    });
    await upsertBudget({ userId: bobId, scopeKind: 'role', scopeRef: 'general', period: 'day', limitUsd: 2 });

    // No role given: the worker runs as 'general', so that budget applies.
    const err = await new AgentManager().spawn({ sessionId: sess.id, userId: bobId }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpendBudgetExceededError);
    expect((err as InstanceType<typeof SpendBudgetExceededError>).reason.scopeKind).toBe('role');
  });

  test('a failing check does not block the spawn', async () => {
    // The table missing (e.g. a rolling deploy with SKIP_MIGRATIONS) makes
    // every check fail; spawns must still go through.
    const { executeRaw } = await import('@/db/postgres');
    const { _resetSpendBudgetsForTests } = await import('@/security/spend-budgets');
    await executeRaw('ALTER TABLE spend_budgets RENAME TO spend_budgets_off');
    _resetSpendBudgetsForTests();
    try {
      const { AgentManager } = await import('@/core/agent-manager');
      const { seedSession } = await import('@/test-helpers/multiuser-fixtures');
      const sess = await seedSession({ userId: aliceId });
      const worker = await new AgentManager().spawn({ sessionId: sess.id, userId: aliceId, model: 'test-model' });
      expect(worker.getContext().userId).toBe(aliceId);
    } finally {
      await executeRaw('ALTER TABLE spend_budgets_off RENAME TO spend_budgets');
      _resetSpendBudgetsForTests();
    }
  });

  test('a mid-run pause fails the worker as spend_budget, not as a user stop', async () => {
    // The pre-LLM-call gate aborts the worker's own controller before it
    // throws; the run's catch must still see a refusal, not a stop.
    const carolId = '33333333-3333-3333-3333-333333333333';
    const { seedUsers, seedSession } = await import('@/test-helpers/multiuser-fixtures');
    await seedUsers([{ id: carolId, username: 'carol' }]);
    const sess = await seedSession({ userId: carolId });
    const { AgentManager } = await import('@/core/agent-manager');
    const worker = await new AgentManager().spawn({ sessionId: sess.id, userId: carolId, model: 'test-model' });

    // The budget is spent after the spawn, i.e. mid-run.
    const { upsertBudget, _resetSpendBudgetsForTests } = await import('@/security/spend-budgets');
    const { getDb } = await import('@/db/postgres');
    const { costLog } = await import('@/db/schema/models');
    await getDb().insert(costLog).values({ userId: carolId, modelName: 'test', inputTokens: 1, outputTokens: 1, totalCost: 2 });
    await upsertBudget({ userId: carolId, scopeKind: 'user', period: 'day', limitUsd: 1 });
    _resetSpendBudgetsForTests();

    const statuses: unknown[] = [];
    worker.onEvent((e) => { if (e.type === 'status_change') statuses.push(e.data); });
    const err = await worker.run('hello').catch((e: unknown) => e);
    const { SpendBudgetExceededError } = await import('@/security/spend-budget-error');
    expect(err).toBeInstanceOf(SpendBudgetExceededError);
    expect(worker.getStatus()).toBe('failed');
    expect(statuses).toContainEqual(expect.objectContaining({ status: 'failed', reason: 'spend_budget' }));
    expect(statuses).not.toContainEqual(expect.objectContaining({ status: 'stopped' }));

    const { agentRepository } = await import('@/db/repositories/agent-repository');
    await expect.poll(async () => (await agentRepository.findById(worker.getContext().id))?.status).toBe('failed');
    const row = await agentRepository.findById(worker.getContext().id);
    expect(row?.metadata).toMatchObject({ failureReason: 'spend_budget' });
  });

  test('a stop while the spend check is pending stays a stop, even when the check then refuses', async () => {
    const daveId = '44444444-4444-4444-4444-444444444444';
    const { seedUsers, seedSession } = await import('@/test-helpers/multiuser-fixtures');
    await seedUsers([{ id: daveId, username: 'dave' }]);
    const sess = await seedSession({ userId: daveId });
    const { AgentManager } = await import('@/core/agent-manager');
    const worker = await new AgentManager().spawn({ sessionId: sess.id, userId: daveId, model: 'test-model' });

    // Spent, so the check will throw once it is released.
    const { upsertBudget, _resetSpendBudgetsForTests } = await import('@/security/spend-budgets');
    const { getDb } = await import('@/db/postgres');
    const { costLog } = await import('@/db/schema/models');
    await getDb().insert(costLog).values({ userId: daveId, modelName: 'test', inputTokens: 1, outputTokens: 1, totalCost: 2 });
    await upsertBudget({ userId: daveId, scopeKind: 'user', period: 'day', limitUsd: 1 });
    _resetSpendBudgetsForTests();

    let release!: () => void;
    const entered = new Promise<void>((r) => { gate.entered = r; });
    gate.hold = new Promise<void>((r) => { release = r; });
    const statuses: Array<{ status?: string }> = [];
    const types: string[] = [];
    worker.onEvent((e) => {
      types.push(e.type);
      if (e.type === 'status_change') statuses.push(e.data as { status?: string });
    });
    try {
      const running = worker.run('hello').catch((e: unknown) => e);
      await entered;
      worker.stop('user stop');
      release();
      const err = await running;
      const { SpendBudgetExceededError } = await import('@/security/spend-budget-error');
      expect(err).toBeInstanceOf(SpendBudgetExceededError);
    } finally {
      gate.hold = null;
      gate.entered = null;
    }

    expect(worker.getStatus()).toBe('stopped');
    expect(statuses.map((s) => s.status)).toEqual(['running', 'stopped']);
    expect(types).not.toContain('error');
    const { agentRepository } = await import('@/db/repositories/agent-repository');
    await expect.poll(async () => (await agentRepository.findById(worker.getContext().id))?.status).toBe('stopped');
    const row = await agentRepository.findById(worker.getContext().id);
    expect(row?.metadata).not.toHaveProperty('failureReason');
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
