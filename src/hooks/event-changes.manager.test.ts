/**
 * onlyOnChange through HookManager, on embedded PGlite: a skipped check
 * delivery uses neither the cooldown nor the execution count, and the merged
 * turn goes back through triggerHook (re-read, re-checked, logged).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TriggerContext, TriggerEvent } from './triggers';

const turns = vi.hoisted(() => ({ messages: [] as string[] }));
vi.mock('@/core/agent', () => ({
  getAgentService: () => ({
    handleMessage: async (_s: string, _u: string, message: string) => {
      turns.messages.push(message);
      return { agentId: 'agent-1', response: '' };
    },
  }),
}));

const userId = '11111111-1111-4111-8111-111111111111';
const hookId = '33333333-3333-4333-8333-333333333333';

let manager: import('./manager').HookManager;
let changes: typeof import('./event-changes');
let executeRaw: (sql: string) => Promise<unknown>;
let rows: <T = Record<string, unknown>>(sql: string) => Promise<T[]>;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-event-changes-'));
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
  changes = await import('./event-changes');
}, 120_000);

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

beforeEach(async () => {
  turns.messages = [];
  changes.resetPendingCheckChanges();
  await executeRaw('DELETE FROM hooks');
  await executeRaw(
    `INSERT INTO hooks (id, user_id, name, trigger, trigger_config, action, action_config, cooldown_ms, max_executions)
     VALUES ('${hookId}', '${userId}', 'CI watcher', 'webhook', '{"webhookPath":"gh"}'::jsonb, 'spawn_agent',
             '{"agentPrompt":"Why did CI fail?","orchestrated":true,"onlyOnChange":true,"changeMergeWindowSeconds":1}'::jsonb, 600000, 5)`,
  );
});

const event: TriggerEvent = { type: 'webhook', data: {}, timestamp: new Date() };
function checkRun(name: string, conclusion: string, pr: number): TriggerContext {
  return {
    webhook: {
      path: 'gh', method: 'POST', headers: { 'x-github-event': 'check_run' },
      body: { action: 'completed', repository: { full_name: 'acme/app' }, check_run: { name, conclusion, pull_requests: [{ number: pr }] } },
    },
  };
}
const hookRow = async () => (await rows<{ execution_count: number; last_executed_at: Date | null }>(`SELECT execution_count, last_executed_at FROM hooks WHERE id = '${hookId}'`))[0];

describe('onlyOnChange in HookManager', () => {
  test('skipped deliveries are logged but use neither cooldown nor the execution count', async () => {
    for (const name of ['lint', 'test', 'build']) await manager.triggerHook(hookId, event, checkRun(name, 'success', 1));
    expect(await hookRow()).toEqual({ execution_count: 0, last_executed_at: null });
    const logged = await rows<{ result: { skipped: string } }>(`SELECT result FROM hook_executions WHERE hook_id = '${hookId}'`);
    expect(logged.map((r) => r.result.skipped)).toEqual(['no change', 'no change', 'no change']);
    expect(turns.messages).toHaveLength(0);
  });

  test('the merged turn runs through triggerHook: reserved once, logged, cooldown honoured after', async () => {
    await manager.triggerHook(hookId, event, checkRun('lint', 'failure', 2));
    await manager.triggerHook(hookId, event, checkRun('test', 'failure', 2));
    await vi.waitFor(() => expect(turns.messages).toHaveLength(1), { timeout: 5_000 });
    expect(turns.messages[0]).toContain('- lint: failure\n- test: failure');
    await vi.waitFor(async () => expect((await hookRow()).execution_count).toBe(1));
    // The cooldown (10 min) now holds the next red check of another PR back.
    await manager.triggerHook(hookId, event, checkRun('lint', 'failure', 3));
    await new Promise((r) => setTimeout(r, 1_500));
    expect(turns.messages).toHaveLength(1);
  });

  test('a hook disabled during the window does not run its merged turn', async () => {
    await manager.triggerHook(hookId, event, checkRun('lint', 'failure', 4));
    await executeRaw(`UPDATE hooks SET is_enabled = false WHERE id = '${hookId}'`);
    await new Promise((r) => setTimeout(r, 1_500));
    expect(turns.messages).toHaveLength(0);
    expect((await hookRow()).execution_count).toBe(0);
  });
});
