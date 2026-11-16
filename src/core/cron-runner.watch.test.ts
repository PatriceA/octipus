/**
 * A claimed scheduled hook with `watch` (hooks/schedule-watch.ts), through the
 * cron runner's dispatch on embedded PGlite with the real migrations and the
 * real HookManager: an unchanged run is skipped and logged without reaching
 * the action (no agent turn, no model call), a failed run is never the
 * baseline for a skip and tells the owner, an unreadable source always runs,
 * and a hook without `watch` runs every time.
 *
 * executeAction is mocked: it is the one way from a hook to an agent turn, so
 * its call count is the number of model-backed runs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hook } from '@/db/schema/hooks';

const executed: string[] = [];
let failNext = false;
vi.mock('@/hooks/actions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/actions')>()),
  executeAction: vi.fn(async (hook: Hook) => {
    executed.push(hook.name);
    if (failNext) return { success: false, error: 'The model provider is unreachable' };
    return { success: true, data: { response: 'Nothing new.' } };
  }),
}));

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const userId = '44444444-4444-4444-8444-444444444444';

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-cron-watch-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: userId, username: 'watcher' }]);
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

beforeEach(() => {
  executed.length = 0;
  failNext = false;
});

async function createHook(name: string, triggerConfig: Record<string, unknown>, action: 'spawn_agent' | 'notify' = 'spawn_agent'): Promise<string> {
  const { getDb } = await import('@/db/postgres');
  const { hooks } = await import('@/db/schema/hooks');
  const [row] = await getDb().insert(hooks).values({
    userId, name, trigger: 'schedule', triggerConfig: { cronExpression: '0 * * * *', ...triggerConfig },
    action, actionConfig: { orchestrated: true, agentPrompt: 'Tell me what changed on my board.' }, nextRunAt: new Date(),
  }).returning();
  return row.id;
}

/** Fire the hook as the cron runner does after claiming it: read the row fresh, then dispatch. */
async function fire(hookId: string, overrides: Parameters<typeof import('./cron-runner').fireClaimedScheduleHook>[3] = {}) {
  const { getDb } = await import('@/db/postgres');
  const { hooks } = await import('@/db/schema/hooks');
  const { eq } = await import('drizzle-orm');
  const { fireClaimedScheduleHook } = await import('./cron-runner');
  const [row] = await getDb().select().from(hooks).where(eq(hooks.id, hookId));
  return fireClaimedScheduleHook(row, new Date(), new Date(Date.now() + 3600_000), overrides);
}

async function hookRow(hookId: string) {
  const { getDb } = await import('@/db/postgres');
  const { hooks } = await import('@/db/schema/hooks');
  const { eq } = await import('drizzle-orm');
  const [row] = await getDb().select().from(hooks).where(eq(hooks.id, hookId));
  return row;
}

async function addTask(title: string) {
  const { getDb } = await import('@/db/postgres');
  const { tasks } = await import('@/db/schema/tasks');
  await getDb().insert(tasks).values({ userId, title });
}

describe('fireClaimedScheduleHook with watch', () => {
  test('unchanged after success skips without an agent call; a change runs; a failure notifies and is never the baseline', async () => {
    const hookId = await createHook('Board watch', { watch: [{ kind: 'tasks' }] });

    // First run: nothing to compare against.
    expect(await fire(hookId)).toBe('success');
    expect(executed).toEqual(['Board watch']);
    expect((await hookRow(hookId)).triggerConfig.watchState).toMatchObject({ outcome: 'success', fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) });

    // Nothing changed since a successful run: skipped, recorded, not a failure.
    expect(await fire(hookId)).toBe('skipped');
    expect(executed).toHaveLength(1);
    const { getHookManager } = await import('@/hooks/manager');
    const { executions } = await getHookManager().getExecutions({ hookId });
    expect(executions[0]).toMatchObject({ status: 'skipped', result: { reason: 'unchanged' } });
    expect((await hookRow(hookId)).lastError).toBeNull();

    // The board changed and the run fails: it ran, the owner hears, lastError is set.
    await addTask('Review the quarterly numbers');
    failNext = true;
    expect(await fire(hookId)).toBe('failed');
    expect(executed).toHaveLength(2);
    const failed = await hookRow(hookId);
    expect(failed.lastError).toContain('unreachable');
    expect(failed.triggerConfig.watchState?.outcome).toBe('failed');
    const { getDb } = await import('@/db/postgres');
    const { notifications } = await import('@/db/schema/notifications');
    const { and, eq } = await import('drizzle-orm');
    const notes = await getDb().select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.type, 'schedule_failed')));
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toContain('Board watch');
    expect(notes[0].body).toContain('unreachable');

    // Unchanged, but the last run failed: it runs again.
    failNext = false;
    expect(await fire(hookId)).toBe('success');
    expect(executed).toHaveLength(3);
    expect((await hookRow(hookId)).lastError).toBeNull();

    // And now, unchanged after that success, it skips again.
    expect(await fire(hookId)).toBe('skipped');
    expect(executed).toHaveLength(3);
  });

  test('a source that cannot be read runs, and leaves no baseline to skip the next run against', async () => {
    const hookId = await createHook('Inbox watch', { watch: [{ kind: 'tasks' }] });
    expect(await fire(hookId)).toBe('success');
    const { defaultWatchProbeDeps } = await import('@/hooks/schedule-watch');
    const down = { ...defaultWatchProbeDeps, tasks: async () => { throw new Error('board unavailable'); } };
    expect(await fire(hookId, { watchProbe: down })).toBe('success');
    expect(executed).toHaveLength(2);
    expect((await hookRow(hookId)).triggerConfig.watchState?.fingerprint).toBeNull();
    // Readable again but nothing to compare with: runs.
    expect(await fire(hookId)).toBe('success');
    expect(executed).toHaveLength(3);
  });

  test('a hook without watch runs every time, exactly as before', async () => {
    const hookId = await createHook('Plain schedule', {});
    expect(await fire(hookId)).toBe('success');
    expect(await fire(hookId)).toBe('success');
    expect(executed).toEqual(['Plain schedule', 'Plain schedule']);
    expect((await hookRow(hookId)).triggerConfig.watchState).toBeUndefined();
  });

  test('a reminder carrying a watch written around the API never skips', async () => {
    const hookId = await createHook('Reminder', { watch: [{ kind: 'tasks' }] }, 'notify');
    expect(await fire(hookId)).toBe('success');
    expect(await fire(hookId)).toBe('success');
    expect(executed).toHaveLength(2);
  });
});
