import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.STORAGE_MODE = 'embedded';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'environment-session-'));
const { initializeDb, closeDb, getDb } = await import('@/db/postgres');
const { runMigrations } = await import('@/db/migrate');
const { seedUsers, seedSession } = await import('@/test-helpers/multiuser-fixtures');
const { switchSessionEnvironment } = await import('./environment-session');
const { agents } = await import('@/db/schema/agents');
const userId = '11111111-1111-4111-8111-111111111111';
beforeAll(async () => { await initializeDb(); await runMigrations(); await seedUsers([{ id: userId, username: 'environment-owner' }]); });
afterAll(async () => { await closeDb(); rmSync(process.env.DATA_DIR!, { recursive: true, force: true }); });
it('concurrent selections cannot overwrite a newer environment binding', async () => {
  const session = await seedSession({ userId, channelId: 'concurrent-env' });
  const results = await Promise.all(['host-a', 'host-b'].map(id => switchSessionEnvironment(userId, session.id, null, { executionEnvironmentId: id })));
  expect(results.filter(Boolean)).toHaveLength(1);
});
it('durable running agents block selection even without a local worker', async () => {
  const session = await seedSession({ userId, channelId: 'running-env' });
  await getDb().insert(agents).values({ id: 'other-process-agent', userId, sessionId: session.id, status: 'running' });
  expect(await switchSessionEnvironment(userId, session.id, null, { executionEnvironmentId: 'host' })).toBe(false);
});
