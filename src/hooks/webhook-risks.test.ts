/**
 * Webhook delivery risks, on embedded PGlite: a run refused at capacity
 * releases its delivery claim and hands its reservation back; cooldown and
 * maxExecutions skips are logged; two first runs share one minted session.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TriggerEvent } from './triggers';
import { ConcurrencyLimitError } from '@/core/errors/concurrency-limit';

const spawner = vi.hoisted(() => ({ error: null as Error | null, spawns: 0, beforeThrow: null as null | (() => Promise<void>) }));
vi.mock('@/core/agent-manager', () => ({
  getAgentManager: () => ({
    spawn: async () => {
      if (spawner.error) {
        await spawner.beforeThrow?.();
        throw spawner.error;
      }
      spawner.spawns += 1;
      return { run: async () => '', getContext: () => ({ id: 'agent-1' }) };
    },
  }),
}));
// The direct spawn's run waits its turn in the session: observe which session.
const turns = vi.hoisted(() => ({ sessions: [] as string[] }));
vi.mock('@/core/session-turn-lock', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/core/session-turn-lock')>(),
  withSessionTurn: async (sessionId: string) => { turns.sessions.push(sessionId); return undefined; },
}));
// An orchestrated run's root turn: a test makes a user's /stop drop it.
const rootTurn = vi.hoisted(() => ({ handleMessage: async (): Promise<unknown> => ({ response: 'ok' }) }));
vi.mock('@/core/agent', () => ({ getAgentService: () => ({ handleMessage: () => rootTurn.handleMessage() }) }));

const userId = '11111111-1111-4111-8111-111111111111';
const hookId = '44444444-4444-4444-8444-444444444444';

let manager: import('./manager').HookManager;
let delivery: typeof import('./webhook-delivery');
let actions: typeof import('./actions');
let executeRaw: (sql: string) => Promise<unknown>;
let rows: <T = Record<string, unknown>>(sql: string) => Promise<T[]>;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-webhook-risks-'));
  const db = await import('@/db/postgres');
  await db.initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { initializeStorage } = await import('@/db/storage');
  initializeStorage({ mode: 'embedded' });
  executeRaw = db.executeRaw as typeof executeRaw;
  rows = async <T,>(sql: string) => (await db.queryRaw(sql)).rows as T[];
  await executeRaw(`INSERT INTO users (id, username, is_admin) VALUES ('${userId}', 'alice', false) ON CONFLICT DO NOTHING`);
  manager = (await import('./manager')).getHookManager();
  delivery = await import('./webhook-delivery');
  actions = await import('./actions');
}, 120_000);

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

async function insertHook({ cooldownMs = 0, maxExecutions = 0, executionCount = 0, lastExecutedAt = 'NULL', orchestrated = false } = {}) {
  await executeRaw(
    `INSERT INTO hooks (id, user_id, name, trigger, trigger_config, action, action_config, cooldown_ms, max_executions, execution_count, last_executed_at)
     VALUES ('${hookId}', '${userId}', 'Issue triage', 'webhook', '{"webhookPath":"gh"}'::jsonb, 'spawn_agent',
             '{"agentPrompt":"triage","orchestrated":${orchestrated}}'::jsonb, ${cooldownMs}, ${maxExecutions}, ${executionCount}, ${lastExecutedAt})`,
  );
}

beforeEach(async () => {
  spawner.error = null;
  spawner.beforeThrow = null;
  spawner.spawns = 0;
  turns.sessions = [];
  delivery._resetDeliveryCache();
  await executeRaw('DELETE FROM hooks');
});

const event: TriggerEvent = { type: 'webhook', data: {}, timestamp: new Date() };
const context = { webhook: { path: 'gh', method: 'POST', headers: {}, body: { action: 'opened' } } };
const createAs = (id: string) => async () => (await import('@/core/agent/session-resolver')).resolveSession(id, userId, 'hook');
const run = (deliveryId: string) => ({
  hook: { id: hookId, name: 'Issue triage', action: 'spawn_agent' as const },
  event, context, deliveryId, failureContext: {},
});
const hookRow = async () => (await rows<{ execution_count: number; last_executed_at: Date | null; session_id: string | null }>(
  `SELECT execution_count, last_executed_at, session_id FROM hooks WHERE id = '${hookId}'`))[0];
const executions = () => rows<{ status: string; error: string | null; result: Record<string, unknown> | null }>(
  `SELECT status, error, result FROM hook_executions WHERE hook_id = '${hookId}' ORDER BY created_at`);

describe('a run refused before it started', () => {
  test('at the agent cap: the delivery is released, the reservation handed back, the failure logged', async () => {
    await insertHook({ cooldownMs: 600_000, maxExecutions: 5 });
    spawner.error = new ConcurrencyLimitError(3);
    expect(await delivery.claimDelivery(hookId, 'd-1')).not.toBeNull();

    await delivery.fireWebhookHook(run('d-1'));

    // Released: the sender's redelivery can claim it again.
    expect(await delivery.claimDelivery(hookId, 'd-1')).not.toBeNull();
    expect(await hookRow()).toMatchObject({ execution_count: 0, last_executed_at: null });
    expect((await executions()).map((e) => [e.status, e.error])).toEqual([['error', 'Maximum concurrent agents (3) reached']]);

    // The retry is not then skipped by the cooldown this run never used.
    spawner.error = null;
    await delivery.fireWebhookHook(run('d-1'));
    expect(spawner.spawns).toBe(1);
    expect(await delivery.claimDelivery(hookId, 'd-1')).toBeNull(); // done
    expect((await hookRow()).execution_count).toBe(1);
  });

  test('a reservation that landed meanwhile keeps its stamp; the refused run still gives its count back', async () => {
    await insertHook({ cooldownMs: 600_000, maxExecutions: 5 });
    spawner.error = new ConcurrencyLimitError(3);
    // Another process reserves its own run while this one is being refused.
    spawner.beforeThrow = async () => {
      await executeRaw(`UPDATE hooks SET execution_count = execution_count + 1, last_executed_at = now() + interval '1 second' WHERE id = '${hookId}'`);
    };
    await manager.triggerHook(hookId, event, context);
    const row = await hookRow();
    expect(row.execution_count).toBe(1);
    expect(row.last_executed_at).not.toBeNull();
  });

  test('over a user quota: also released', async () => {
    await insertHook();
    const { QuotaExceededError } = await import('@/security/quota-error');
    spawner.error = new QuotaExceededError({ kind: 'concurrentAgents', current: 2, max: 2, userId });
    await delivery.claimDelivery(hookId, 'd-2');
    await delivery.fireWebhookHook(run('d-2'));
    expect(await delivery.claimDelivery(hookId, 'd-2')).not.toBeNull();
  });

  test('an orchestrated run a user /stop dropped: released, reservation handed back, logged as skipped', async () => {
    await insertHook({ cooldownMs: 600_000, maxExecutions: 5, orchestrated: true });
    const { SessionTurnCancelledError } = await import('@/core/session-turn-lock');
    rootTurn.handleMessage = async () => { throw new SessionTurnCancelledError('s'); };
    try {
      expect(await delivery.claimDelivery(hookId, 'd-stop')).not.toBeNull();
      await delivery.fireWebhookHook(run('d-stop'));
      expect(await delivery.claimDelivery(hookId, 'd-stop')).not.toBeNull();
      expect(await hookRow()).toMatchObject({ execution_count: 0, last_executed_at: null });
      expect((await executions()).map((e) => [e.status, e.error])).toEqual([['skipped', 'Dropped by /stop before it ran']]);
    } finally {
      rootTurn.handleMessage = async () => ({ response: 'ok' });
    }
  });

  test('any other spawn failure still completes the delivery', async () => {
    await insertHook();
    spawner.error = new Error('model provider unreachable');
    await delivery.claimDelivery(hookId, 'd-3');
    await delivery.fireWebhookHook(run('d-3'));
    expect(await delivery.claimDelivery(hookId, 'd-3')).toBeNull();
    expect((await hookRow()).execution_count).toBe(1);
  });
});

describe('skips are recorded', () => {
  test('a delivery inside the cooldown writes a skipped row and is released', async () => {
    await insertHook({ cooldownMs: 600_000, executionCount: 1, lastExecutedAt: 'now()' });
    await delivery.claimDelivery(hookId, 'd-4');
    await delivery.fireWebhookHook(run('d-4'));
    const logged = await executions();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ status: 'skipped', error: 'cooldown', result: { skipped: 'cooldown' } });
    expect(spawner.spawns).toBe(0);
    expect(await delivery.claimDelivery(hookId, 'd-4')).not.toBeNull();
  });

  test('an exhausted hook writes a skipped row', async () => {
    await insertHook({ maxExecutions: 2, executionCount: 2 });
    await manager.triggerHook(hookId, event, context);
    const logged = await executions();
    expect(logged).toEqual([expect.objectContaining({ status: 'skipped', error: 'max_executions' })]);
    expect(logged[0].result).toMatchObject({ executionCount: 2, maxExecutions: 2 });
  });
});

describe('repeated skips of a schedule', () => {
  test('a schedule tick past maxExecutions logs its skip once, not every tick', async () => {
    await insertHook({ maxExecutions: 1, executionCount: 1 });
    await executeRaw(`UPDATE hooks SET trigger = 'schedule', trigger_config = '{"cronExpression":"* * * * *"}'::jsonb WHERE id = '${hookId}'`);
    const tick: TriggerEvent = { type: 'schedule', data: { hookId }, timestamp: new Date() };
    for (let i = 0; i < 3; i++) await manager.triggerHook(hookId, tick, {});
    expect((await executions()).map((e) => e.error)).toEqual(['max_executions']);
  });

  test('each webhook delivery skipped still gets its own row', async () => {
    await insertHook({ maxExecutions: 1, executionCount: 1 });
    for (let i = 0; i < 2; i++) await manager.triggerHook(hookId, event, context);
    expect(await executions()).toHaveLength(2);
  });
});

describe('a scheduled one-shot refused before it started', () => {
  const insertOneShot = async (scheduledAt: Date) => {
    await executeRaw(
      `INSERT INTO hooks (id, user_id, name, trigger, trigger_config, action, action_config, is_enabled, next_run_at, max_executions)
       VALUES ('${hookId}', '${userId}', 'Reminder', 'schedule', '{"scheduledAt":"${scheduledAt.toISOString()}"}'::jsonb, 'spawn_agent',
               '{"agentPrompt":"remind","orchestrated":false}'::jsonb, false, NULL, 1)`,
    );
    return (await rows<import('@/db/schema/hooks').Hook>(`SELECT id, name FROM hooks WHERE id = '${hookId}'`))[0];
  };
  const state = async () => (await rows<{ is_enabled: boolean; next_run_at: Date | null; last_error: string | null }>(
    `SELECT is_enabled, next_run_at, last_error FROM hooks WHERE id = '${hookId}'`))[0];

  test('is re-enabled with a backed-off retry and the error recorded', async () => {
    const now = new Date();
    const hook = await insertOneShot(new Date(now.getTime() - 10 * 60_000));
    const { retryNotStartedHook } = await import('@/core/cron-runner');
    const retryAt = await retryNotStartedHook(hook, true, new Date(now.getTime() - 10 * 60_000).toISOString(), 'Maximum concurrent agents (3) reached', now);
    expect(retryAt!.getTime() - now.getTime()).toBe(10 * 60_000);
    const s = await state();
    expect(s.is_enabled).toBe(true);
    expect(new Date(s.next_run_at!).getTime()).toBe(retryAt!.getTime());
    expect(s.last_error).toMatch(/^Not started: Maximum concurrent agents \(3\) reached\. Retrying at/);
  });

  test('gives up after the retry window, leaving the error visible', async () => {
    const now = new Date();
    const due = new Date(now.getTime() - 25 * 60 * 60_000);
    const hook = await insertOneShot(due);
    const { retryNotStartedHook } = await import('@/core/cron-runner');
    expect(await retryNotStartedHook(hook, true, due.toISOString(), 'over quota', now)).toBeNull();
    expect(await state()).toMatchObject({ is_enabled: false, next_run_at: null, last_error: 'Not started: over quota' });
  });
});

describe('the first-run session mint', () => {
  test('two racing first runs keep one saved id; the loser uses it and drops its own session', async () => {
    await insertHook();
    const a = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const [first, second] = await Promise.all([
      actions.persistHookSessionId(hookId, a, createAs(a)),
      actions.persistHookSessionId(hookId, b, createAs(b)),
    ]);
    const stored = (await hookRow()).session_id;
    expect([a, b]).toContain(stored);
    expect(first).toBe(stored);
    expect(second).toBe(stored);
    const sessions = await rows<{ id: string }>(`SELECT id FROM sessions WHERE id IN ('${a}', '${b}')`);
    expect(sessions.map((r) => r.id)).toEqual([stored]);
  });

  test('a later run reuses the stored id without creating a session', async () => {
    await insertHook();
    const a = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    expect(await actions.persistHookSessionId(hookId, a, createAs(a))).toBe(a);
    const d = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    expect(await actions.persistHookSessionId(hookId, d, createAs(d))).toBe(a);
    expect(await rows(`SELECT id FROM sessions WHERE id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'`)).toHaveLength(0);
  });

  test('a hook deleted before its first run: null, and no session is left behind', async () => {
    await insertHook();
    const e = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const created = createAs(e);
    const result = await actions.persistHookSessionId(hookId, e, async () => {
      await created();
      await executeRaw(`DELETE FROM hooks WHERE id = '${hookId}'`);
    });
    expect(result).toBeNull();
    expect(await rows(`SELECT id FROM sessions WHERE id = '${e}'`)).toHaveLength(0);
    expect(await actions.persistHookSessionId(hookId, e, createAs(e))).toBeNull();
  });

  test('concurrent first deliveries run in one session', async () => {
    await insertHook();
    await Promise.all([manager.triggerHook(hookId, event, context), manager.triggerHook(hookId, event, context)]);
    expect(turns.sessions).toHaveLength(2);
    expect(turns.sessions[0]).toBe(turns.sessions[1]);
    expect(turns.sessions[0]).toBe((await hookRow()).session_id);
  });
});
