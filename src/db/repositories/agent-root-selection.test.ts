import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { agentRepository } from './agent-repository';

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-root-selection-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
});
afterAll(async () => { const { closeDb } = await import('@/db/postgres'); await closeDb(); });

test('latest root query isolates session and owner, excluding children and explicit non-roots', async () => {
  const sessionId = randomUUID();
  const userId = randomUUID();
  const base = { sessionId, userId, role: 'general', model: 'cli/codex' };
  const create = async (offset: number, patch: Partial<Parameters<typeof agentRepository.create>[0]>) =>
    agentRepository.create({ ...base, id: randomUUID(), createdAt: new Date(1700000000000 + offset), ...patch });
  const legacy = await create(0, { metadata: {} });
  expect((await agentRepository.findLatestRootForSession(sessionId, userId))?.id).toBe(legacy.id);
  const root = await create(1, { metadata: { root: true } });
  await create(2, { parentAgentId: root.id, metadata: {} });
  await create(3, { metadata: { root: false } });
  await create(4, { role: 'testing', metadata: {} });
  await create(5, { userId: randomUUID(), metadata: { root: true } });
  await create(6, { sessionId: randomUUID(), metadata: { root: true } });
  expect((await agentRepository.findLatestRootForSession(sessionId, userId))?.id).toBe(root.id);
  const customRoot = await create(7, { role: 'custom', metadata: { root: true } });
  expect((await agentRepository.findLatestRootForSession(sessionId, userId))?.id).toBe(customRoot.id);
});
