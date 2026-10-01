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

  test('workspace scope attributes via the agent’s workspace, else the session’s', async () => {
    const { checkSpend, upsertBudget } = await import('@/security/spend-budgets');
    const { getOrgWorkspaceManager } = await import('@/security/orgs');
    const { seedSession } = await import('@/test-helpers/multiuser-fixtures');
    const { getDb } = await import('@/db/postgres');
    const { agents } = await import('@/db/schema/agents');
    const { sessions } = await import('@/db/schema/sessions');
    const userId = await newUser();
    const ws = await getOrgWorkspaceManager().ensureDefaultWorkspace(userId);
    const plain = await seedSession({ userId });
    const scoped = await seedSession({ userId });
    await getDb().update(sessions).set({ workspaceId: ws.id }).where(eq(sessions.id, scoped.id));
    const inWs = `ws-${rand(4)}`;
    const outside = `out-${rand(4)}`;
    await getDb().insert(agents).values([
      { id: inWs, sessionId: plain.id, userId, workspaceId: ws.id, role: 'general', model: 'test', topic: 'test', status: 'completed' },
      { id: outside, sessionId: plain.id, userId, role: 'general', model: 'test', topic: 'test', status: 'completed' },
    ]);
    await upsertBudget({ userId, scopeKind: 'workspace', scopeRef: ws.id.toUpperCase(), period: 'day', limitUsd: 10 });
    await logCost(userId, 2, { agentId: inWs });
    await logCost(userId, 50, { agentId: outside });
    const { costLog } = await import('@/db/schema/models');
    await getDb().insert(costLog).values({
      userId, sessionId: scoped.id, modelName: 'test', inputTokens: 1, outputTokens: 1, totalCost: 3, createdAt: EARLIER,
    });

    const [status] = await checkSpend({ userId, workspaceId: ws.id }, NOON);
    expect(status.budget.scopeRef).toBe(ws.id.toLowerCase());
    expect(status.spentUsd).toBeCloseTo(5);
  });

  test('the spend cache does not grow across periods', async () => {
    const { checkSpend, upsertBudget, _spendCacheSizeForTests } = await import('@/security/spend-budgets');
    const userId = await newUser();
    await upsertBudget({ userId, scopeKind: 'user', period: 'day', limitUsd: 10 });
    for (const day of ['2026-07-12', '2026-07-13', '2026-07-14']) {
      await checkSpend({ userId }, new Date(`${day}T12:00:00Z`));
    }
    expect(_spendCacheSizeForTests()).toBe(1);
  });

  test('a user with no budgets is served from the budget cache', async () => {
    const { checkSpend, _resetSpendBudgetsForTests } = await import('@/security/spend-budgets');
    const { SpendBudgetExceededError } = await import('@/security/spend-budget-error');
    const userId = await newUser();
    expect(await checkSpend({ userId }, NOON)).toEqual([]);

    // Written behind the module's back: the cached empty list keeps answering
    // for the TTL, so the budget table is not re-read on each check.
    const { getDb } = await import('@/db/postgres');
    const { spendBudgets } = await import('@/db/schema/spend-budgets');
    await getDb().insert(spendBudgets).values({ userId, scopeKind: 'user', period: 'day', limitUsd: '1' });
    await logCost(userId, 5);
    for (let i = 0; i < 3; i++) expect(await checkSpend({ userId }, NOON)).toEqual([]);

    _resetSpendBudgetsForTests();
    await expect(checkSpend({ userId }, NOON)).rejects.toBeInstanceOf(SpendBudgetExceededError);
  });

  test('concurrent upserts of one scope leave one row; role names are trimmed', async () => {
    const { upsertBudget, listBudgets } = await import('@/security/spend-budgets');
    const userId = await newUser();
    await Promise.all([1, 2, 3, 4, 5].map(n => upsertBudget({ userId, scopeKind: 'user', period: 'day', limitUsd: n })));
    await Promise.all([1, 2, 3].map(n => upsertBudget({ userId, scopeKind: 'role', scopeRef: ' coder ', period: 'day', limitUsd: n })));
    const rows = await listBudgets(userId);
    expect(rows.filter(r => r.scopeKind === 'user')).toHaveLength(1);
    const roles = rows.filter(r => r.scopeKind === 'role');
    expect(roles).toHaveLength(1);
    expect(roles[0].scopeRef).toBe('coder');
  });

  test('system / local principals have no budgets', async () => {
    const { checkSpend } = await import('@/security/spend-budgets');
    expect(await checkSpend({ userId: 'system' })).toEqual([]);
  });
});

describe('group channel budgets', () => {
  async function newGroup(ownerUserId: string) {
    const { getDb } = await import('@/db/postgres');
    const { groupChannels } = await import('@/db/schema/group-channels');
    const [g] = await getDb().insert(groupChannels)
      .values({ channelType: 'slack', channelId: `C${rand(4)}`, label: '#release', ownerUserId })
      .returning();
    return g;
  }
  /** A member's session for one thread of the channel. */
  async function groupSession(userId: string, groupChannelId: string): Promise<string> {
    const { seedSession } = await import('@/test-helpers/multiuser-fixtures');
    const { getDb } = await import('@/db/postgres');
    const { sessions } = await import('@/db/schema/sessions');
    const { id } = await seedSession({ userId, channelType: 'slack', channelId: 'C1' });
    await getDb().update(sessions).set({ groupChannelId, threadId: `t-${rand(3)}` }).where(eq(sessions.id, id));
    return id;
  }
  async function logInSession(userId: string, sessionId: string, totalCost: number) {
    const { getDb } = await import('@/db/postgres');
    const { costLog } = await import('@/db/schema/models');
    await getDb().insert(costLog).values({
      userId, sessionId, modelName: 'test', inputTokens: 1, outputTokens: 1, totalCost, createdAt: EARLIER,
    });
  }

  test("counts every member's spend in the channel and refuses any member's run there once used up", async () => {
    const { checkSpend, groupChannelPause, upsertBudget, _resetSpendBudgetsForTests } = await import('@/security/spend-budgets');
    const { SpendBudgetExceededError } = await import('@/security/spend-budget-error');
    const { seedSession } = await import('@/test-helpers/multiuser-fixtures');
    const owner = await newUser();
    const member = await newUser();
    const g = await newGroup(owner);
    const ownerThread = await groupSession(owner, g.id);
    const memberThread = await groupSession(member, g.id);
    const memberDm = (await seedSession({ userId: member })).id;
    await upsertBudget({ userId: owner, scopeKind: 'group_channel', scopeRef: g.id, period: 'day', limitUsd: 10 });
    await logInSession(owner, ownerThread, 4);
    await logInSession(member, memberThread, 3);
    await logInSession(member, memberDm, 50); // the member's own chat is not the channel's

    const [status] = await checkSpend({ userId: member, sessionId: memberThread }, NOON);
    expect(status.budget.scopeKind).toBe('group_channel');
    expect(status.spentUsd).toBeCloseTo(7);
    expect(await checkSpend({ userId: member, sessionId: memberDm }, NOON)).toEqual([]);
    expect(await groupChannelPause(g.id, NOON)).toBeNull();

    await logInSession(member, memberThread, 5);
    _resetSpendBudgetsForTests();
    await expect(checkSpend({ userId: member, sessionId: memberThread }, NOON)).rejects.toBeInstanceOf(SpendBudgetExceededError);
    // The owner is told, not the member whose run crossed it.
    expect(await notificationsOf(owner, 'spend_budget_paused')).toHaveLength(1);
    expect(await notificationsOf(member, 'spend_budget_paused')).toHaveLength(0);
    expect(await groupChannelPause(g.id, NOON)).toEqual({ resetsAt: '2026-07-13T00:00:00.000Z' });
    // The owner's own runs elsewhere are not capped by it.
    expect(await checkSpend({ userId: owner }, NOON)).toEqual([]);
  });

  test('one budget per channel and period; it follows the owner and goes with the enrolment', async () => {
    const { deleteGroupChannelBudgets, listBudgets, moveGroupChannelBudgets, upsertBudget } = await import('@/security/spend-budgets');
    const owner = await newUser();
    const next = await newUser();
    const g = await newGroup(owner);
    const first = await upsertBudget({ userId: owner, scopeKind: 'group_channel', scopeRef: g.id, period: 'month', limitUsd: 10 });
    const second = await upsertBudget({ userId: next, scopeKind: 'group_channel', scopeRef: g.id, period: 'month', limitUsd: 20 });
    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({ userId: next, limitUsd: '20' });

    await moveGroupChannelBudgets(g.id, owner);
    expect((await listBudgets(owner)).map((b) => b.id)).toEqual([first.id]);
    await deleteGroupChannelBudgets(g.id);
    expect(await listBudgets(owner)).toEqual([]);
  });

  test('its status names the channel', async () => {
    const { groupChannelBudgetStatuses, upsertBudget } = await import('@/security/spend-budgets');
    const owner = await newUser();
    const g = await newGroup(owner);
    await upsertBudget({ userId: owner, scopeKind: 'group_channel', scopeRef: g.id, period: 'day', limitUsd: 10 });
    const [view] = await groupChannelBudgetStatuses(g.id, NOON);
    expect(view).toMatchObject({ scopeKind: 'group_channel', scopeRef: g.id, scopeName: '#release', state: 'ok' });
  });
});
