/**
 * The cron runner's database steps, on embedded PGlite with the real
 * migrations: the compare-and-set claim of a due scheduled hook, the
 * log-table retention prune, and the batched agent-history sweep.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const userId = '11111111-1111-4111-8111-111111111111';
const DAY = 24 * 3600_000;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-cron-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: userId, username: 'cron' }]);
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('claimDueHook', () => {
  test('of two ticks that read the same due hook, only one claims it', async () => {
    const { getDb } = await import('@/db/postgres');
    const { hooks } = await import('@/db/schema/hooks');
    const { eq } = await import('drizzle-orm');
    const { claimDueHook } = await import('./cron-runner');
    const due = new Date(Date.now() - 60_000);
    const [hook] = await getDb().insert(hooks).values({
      userId, name: 'nightly', trigger: 'schedule', triggerConfig: { cronExpression: '0 3 * * *' },
      action: 'notify', actionConfig: {}, nextRunAt: due,
    }).returning();
    // Both instances read the row before either writes.
    const [read] = await getDb().select().from(hooks).where(eq(hooks.id, hook.id));
    const now = new Date();
    const next = new Date(now.getTime() + DAY);
    const results = await Promise.all([claimDueHook(read, next, false, now), claimDueHook(read, next, false, now)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const [after] = await getDb().select().from(hooks).where(eq(hooks.id, hook.id));
    expect(after.nextRunAt?.getTime()).toBe(next.getTime());
    // A stale read (nextRunAt moved on since) never claims.
    expect(await claimDueHook(read, next, false, now)).toBe(false);
  });

  test('a one-shot is disabled by its claim; a disabled hook is never claimed', async () => {
    const { getDb } = await import('@/db/postgres');
    const { hooks } = await import('@/db/schema/hooks');
    const { eq } = await import('drizzle-orm');
    const { claimDueHook } = await import('./cron-runner');
    const [hook] = await getDb().insert(hooks).values({
      userId, name: 'once', trigger: 'schedule', triggerConfig: { scheduledAt: new Date().toISOString() },
      action: 'notify', actionConfig: {}, nextRunAt: new Date(Date.now() - 1000),
    }).returning();
    expect(await claimDueHook(hook, null, true, new Date())).toBe(true);
    const [after] = await getDb().select().from(hooks).where(eq(hooks.id, hook.id));
    expect(after.isEnabled).toBe(false);
    expect(after.nextRunAt).toBeNull();
    expect(await claimDueHook(after, null, true, new Date())).toBe(false);
  });
});

describe('pruneLogTables', () => {
  test('removes only old history rows, in batches', async () => {
    const { getDb } = await import('@/db/postgres');
    const { auditLog } = await import('@/db/schema/audit');
    const { hookExecutions } = await import('@/db/schema/hook-executions');
    const { notifications } = await import('@/db/schema/notifications');
    const { permissionRequests } = await import('@/db/schema/permissions');
    const { contextTurns } = await import('@/db/schema/context-hooks');
    const { pruneLogTables } = await import('./log-retention');
    const db = getDb();
    const old = new Date(Date.now() - 120 * DAY);
    const recent = new Date(Date.now() - 10 * DAY);

    await db.insert(auditLog).values([
      ...Array.from({ length: 5 }, () => ({ userId, action: 'api_request' as const, createdAt: old })),
      { userId, action: 'api_request', createdAt: recent },
      { userId, action: 'login', createdAt: old },
    ]);
    await db.insert(hookExecutions).values([
      { userId, source: 'hook', status: 'success', createdAt: old },
      { userId, source: 'hook', status: 'success', createdAt: recent },
    ]);
    await db.insert(notifications).values([
      { userId, type: 't', title: 'read old', read: true, createdAt: old },
      { userId, type: 't', title: 'unread old', read: false, createdAt: old },
      { userId, type: 't', title: 'read recent', read: true, createdAt: recent },
    ]);
    const request = { userId, agentId: 'a', toolId: 'shell', action: 'execute', context: { toolName: 'shell' } as never };
    await db.insert(permissionRequests).values([
      { ...request, status: 'approved', createdAt: old },
      { ...request, status: 'pending', createdAt: old },
    ]);
    await db.insert(contextTurns).values([
      { userId, sessionId: 's', event: 'turn_start', createdAt: old },
      { userId, sessionId: 's', event: 'turn_start', createdAt: recent },
    ]);

    const removed = await pruneLogTables(new Date(), { batchSize: 2 });
    expect(removed).toEqual({
      'audit_log.api_request': 5,
      hook_executions: 1,
      'notifications.read': 1,
      'permission_requests.settled': 1,
      context_turns: 1,
    });
    const actions = (await db.select({ action: auditLog.action }).from(auditLog)).map((r) => r.action).sort();
    expect(actions).toEqual(['api_request', 'login']);
    expect((await db.select().from(notifications)).map((n) => n.title).sort()).toEqual(['read recent', 'unread old']);
    expect((await db.select().from(permissionRequests)).map((r) => r.status)).toEqual(['pending']);
    expect(await db.select().from(contextTurns)).toHaveLength(1);
  });

  test('a retention_policies row overrides the window, and NULL turns pruning off', async () => {
    const { getDb } = await import('@/db/postgres');
    const { retentionPolicies } = await import('@/db/schema/retention-policies');
    const { hookExecutions } = await import('@/db/schema/hook-executions');
    const { eq } = await import('drizzle-orm');
    const { pruneLogTables, LOG_RETENTION_PURPOSE } = await import('./log-retention');
    const db = getDb();
    await db.insert(hookExecutions).values({ userId, source: 'hook', status: 'success', createdAt: new Date(Date.now() - 10 * DAY) });

    await db.insert(retentionPolicies).values({ purpose: LOG_RETENTION_PURPOSE, maxAgeDays: null });
    expect(await pruneLogTables()).toBeNull();

    await db.update(retentionPolicies).set({ maxAgeDays: 5 }).where(eq(retentionPolicies.purpose, LOG_RETENTION_PURPOSE));
    expect((await pruneLogTables())?.hook_executions).toBe(2);
    await db.delete(retentionPolicies).where(eq(retentionPolicies.purpose, LOG_RETENTION_PURPOSE));
  });
});

describe('agentRepository.deleteCompletedBefore', () => {
  test('works through a backlog larger than one batch, keeping running agents', async () => {
    const { getDb } = await import('@/db/postgres');
    const { agents } = await import('@/db/schema/agents');
    const { agentEvents } = await import('@/db/schema/agent-events');
    const { agentRepository } = await import('@/db/repositories/agent-repository');
    const { seedSession } = await import('@/test-helpers/multiuser-fixtures');
    const db = getDb();
    const session = await seedSession({ userId });
    const finished = Array.from({ length: 5 }, () => randomUUID());
    const running = randomUUID();
    await db.insert(agents).values([
      ...finished.map((id) => ({
        id, sessionId: session.id, userId, role: 'general', model: 'm', topic: 't',
        status: 'completed' as const, completedAt: new Date(Date.now() - 30 * DAY),
      })),
      { id: running, sessionId: session.id, userId, role: 'general', model: 'm', topic: 't', status: 'running' as const },
    ]);
    await db.insert(agentEvents).values(finished.map((agentId) => ({ agentId, sessionId: session.id, userId, type: 'complete', data: {} })));

    expect(await agentRepository.deleteCompletedBefore(new Date(Date.now() - 14 * DAY), 2)).toBe(5);
    expect((await db.select({ id: agents.id }).from(agents)).map((a) => a.id)).toEqual([running]);
    expect(await db.select().from(agentEvents)).toHaveLength(0);
  });
});
