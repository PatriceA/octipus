/**
 * An orchestrated webhook hook at the agent cap, end to end on embedded
 * PGlite: the real AgentService turn, whose root agent spawn throws the real
 * ConcurrencyLimitError, through HookManager and fireWebhookHook. Only the
 * root runner (the spawn) and the model lookup are stubbed. The delivery is
 * released, the reservation handed back and the failure logged.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TriggerEvent } from './triggers';

const spawn = vi.hoisted(() => ({ calls: 0 }));
vi.mock('@/core/agent/root-runner', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/core/agent/root-runner')>(),
  runRootAgent: async () => {
    spawn.calls += 1;
    const { ConcurrencyLimitError } = await import('@/core/errors/concurrency-limit');
    throw new ConcurrencyLimitError(3);
  },
}));
vi.mock('@/models/model-registry', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/models/model-registry')>();
  const registry = real.getModelRegistry();
  return {
    ...real,
    getModelRegistry: () => new Proxy(registry, {
      get: (target, prop, receiver) => (prop === 'getDefaultModel'
        ? async () => ({ modelId: 'test-model' })
        : Reflect.get(target, prop, receiver)),
    }),
  };
});

const userId = '11111111-1111-4111-8111-111111111111';
const hookId = '55555555-5555-4555-8555-555555555555';

let delivery: typeof import('./webhook-delivery');
let executeRaw: (sql: string) => Promise<unknown>;
let rows: <T = Record<string, unknown>>(sql: string) => Promise<T[]>;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-webhook-cap-'));
  const db = await import('@/db/postgres');
  await db.initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { initializeStorage } = await import('@/db/storage');
  initializeStorage({ mode: 'embedded' });
  executeRaw = db.executeRaw as typeof executeRaw;
  rows = async <T,>(sql: string) => (await db.queryRaw(sql)).rows as T[];
  await executeRaw(`INSERT INTO users (id, username, is_admin) VALUES ('${userId}', 'alice', false) ON CONFLICT DO NOTHING`);
  delivery = await import('./webhook-delivery');
}, 120_000);

afterAll(async () => {
  // The failed turn's trajectory is finalized in the background.
  await new Promise((r) => setTimeout(r, 300));
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

const event: TriggerEvent = { type: 'webhook', data: {}, timestamp: new Date() };
const context = { webhook: { path: 'gh', method: 'POST', headers: {}, body: { action: 'opened' } } };

describe('an orchestrated webhook hook at the agent cap', () => {
  test('the real turn reports not started: delivery released, reservation handed back, failure logged', async () => {
    await executeRaw(
      `INSERT INTO hooks (id, user_id, name, trigger, trigger_config, action, action_config, cooldown_ms, max_executions)
       VALUES ('${hookId}', '${userId}', 'Issue triage', 'webhook', '{"webhookPath":"gh"}'::jsonb, 'spawn_agent',
               '{"agentPrompt":"triage","orchestrated":true}'::jsonb, 600000, 5)`,
    );
    expect(await delivery.claimDelivery(hookId, 'd-cap')).not.toBeNull();
    await delivery.fireWebhookHook({
      hook: { id: hookId, name: 'Issue triage', action: 'spawn_agent' }, event, context, deliveryId: 'd-cap', failureContext: {},
    });

    expect(spawn.calls).toBe(1);
    // Released: the sender's redelivery can claim it again.
    expect(await delivery.claimDelivery(hookId, 'd-cap')).not.toBeNull();
    const [hook] = await rows<{ execution_count: number; last_executed_at: Date | null; session_id: string | null }>(
      `SELECT execution_count, last_executed_at, session_id FROM hooks WHERE id = '${hookId}'`);
    expect(hook).toMatchObject({ execution_count: 0, last_executed_at: null });
    const logged = await rows<{ status: string; error: string }>(`SELECT status, error FROM hook_executions WHERE hook_id = '${hookId}'`);
    expect(logged).toHaveLength(1);
    expect(logged[0].status).toBe('error');
    expect(logged[0].error).toContain('Maximum concurrent agents (3) reached');
    // Nothing of the event reached the hook's session.
    const messages = await rows(`SELECT id FROM messages WHERE session_id = '${hook.session_id}'`);
    expect(messages).toHaveLength(0);
  });
});
