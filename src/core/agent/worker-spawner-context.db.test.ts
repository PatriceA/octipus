/**
 * A worker's context-hook record is closed however its start ends
 * (docs/CONTEXT-HOOKS.md). The hooks run while the worker's prompt is
 * assembled; a throw after that and before the worker's own run (here: the
 * caller's `onWorkerSpawned` callback) used to leave the record open for
 * good, its `finished_at` never set.
 *
 * Real database (PGlite) and the real hooks; the model registry, memory and
 * the agent manager's spawn are stand-ins.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

vi.mock('@/models/model-registry', () => ({
  getModelRegistry: () => ({
    getDefaultModel: async () => ({ modelId: 'test-model' }),
    getAllModels: async () => [],
    getModelForTopic: async () => null,
    getUserBinding: async () => null,
    getModelByModelId: async () => null,
    getModel: async () => null,
  }),
}));
vi.mock('@/core/memory', () => ({
  retrieveForContext: async () => [],
  renderMemoriesBlock: () => '',
  updateMemoriesAfterTurn: async () => [],
}));

const userId = randomUUID();
let queryRaw: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-worker-context-'));
  const pg = await import('@/db/postgres');
  await pg.initializeDb();
  queryRaw = pg.queryRaw as typeof queryRaw;
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  await pg.executeRaw(`INSERT INTO users (id, username, is_admin) VALUES ('${userId}', 'worker-owner', false) ON CONFLICT DO NOTHING`);
});

afterAll(async () => {
  vi.restoreAllMocks();
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

test('a throw between the hooks and the worker\'s run still closes the context-hook record', async () => {
  const sessionId = randomUUID();
  await queryRaw(`INSERT INTO sessions (id, user_id, channel_type, channel_id) VALUES ($1, $2, 'webchat', $3)`, [sessionId, userId, `c-${sessionId}`]);
  const { getAgentManager } = await import('@/core/agent-manager');
  const workerId = randomUUID();
  const spawn = vi.spyOn(getAgentManager(), 'spawn').mockResolvedValue({ getContext: () => ({ id: workerId }) } as never);
  const { buildAgentContext, resolveAgentScope } = await import('./context');
  const { sessionRepository } = await import('@/db/repositories/session-repository');
  const scope = await resolveAgentScope({ session: await sessionRepository.findById(sessionId), userId, trigger: 'user' });
  const context = buildAgentContext({ sessionId, userId, scope, topic: 'general', model: 'test-model', role: 'general', root: true, status: 'running' });
  const { spawnWorker } = await import('./worker-spawner');
  const { ModelSelector } = await import('./model-selector');
  try {
    await expect(spawnWorker('research', 'Summarise the pricing notes', '', context, { emit: vi.fn(), modelSelector: new ModelSelector() }, {
      model: 'test-model',
      onWorkerSpawned: () => { throw new Error('caller failed'); },
    })).rejects.toThrow('caller failed');
  } finally {
    spawn.mockRestore();
  }
  // The hooks ran: one record for this worker start, closed as an error.
  await expect.poll(async () => (await queryRaw('SELECT event, outcome, finished_at FROM context_turns WHERE session_id = $1', [sessionId])).rows, { timeout: 5_000 })
    .toEqual([{ event: 'worker_start', outcome: 'error', finished_at: expect.anything() }]);
});


test('an unbound worker model rejects before spawning instead of returning an error object', async () => {
  const sessionId = randomUUID();
  await queryRaw(`INSERT INTO sessions (id, user_id, channel_type, channel_id) VALUES ($1, $2, 'webchat', $3)`, [sessionId, userId, `c-${sessionId}`]);
  const { buildAgentContext, resolveAgentScope } = await import('./context');
  const { sessionRepository } = await import('@/db/repositories/session-repository');
  const scope = await resolveAgentScope({ session: await sessionRepository.findById(sessionId), userId, trigger: 'user' });
  const context = buildAgentContext({ sessionId, userId, scope, topic: 'general', model: 'test-model', role: 'general', root: true, status: 'running' });
  const { spawnWorker } = await import('./worker-spawner');
  const { ModelSelector } = await import('./model-selector');
  const { getAgentManager } = await import('@/core/agent-manager');
  const spawn = vi.spyOn(getAgentManager(), 'spawn');
  try {
    await expect(spawnWorker('research', 'Read a document', '', context, { emit: vi.fn(), modelSelector: new ModelSelector() }))
      .rejects.toThrow(/No model configured.*research/);
    expect(spawn).not.toHaveBeenCalled();
  } finally { spawn.mockRestore(); }
});
