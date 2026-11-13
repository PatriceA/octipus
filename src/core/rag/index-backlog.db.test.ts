/**
 * The catch-up of content saved while no embedding model was configured
 * (docs/MODULES.md → Capability gates), on the database: recording is an
 * upsert, the run does nothing while embedding is off, indexes and deletes
 * each row once it is on, drops rows whose source is gone, and keeps a failing
 * row with its error without blocking the others.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;

const userId = randomUUID();

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-index-backlog-'));
  const { initializeStorage } = await import('@/db/storage');
  initializeStorage({ mode: 'embedded' });
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { queryRaw } = await import('@/db/postgres');
  await queryRaw(`INSERT INTO users (id, username) VALUES ('${userId}', 'backlog-test')`);
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  const { closeStorage } = await import('@/db/storage');
  await closeDb();
  await closeStorage();
});

async function rows() {
  const { queryRaw } = await import('@/db/postgres');
  const { rows } = await queryRaw('SELECT kind, source_id, purpose, attempts, last_error FROM index_backlog ORDER BY source_id');
  return rows as Array<{ kind: string; source_id: string; purpose: string | null; attempts: number; last_error: string | null }>;
}

describe('index backlog', () => {
  beforeEach(async () => {
    const { queryRaw } = await import('@/db/postgres');
    await queryRaw('DELETE FROM index_backlog');
    const { setCapabilitiesForTest } = await import('@/core/capabilities/gates');
    setCapabilitiesForTest({ embedding: false });
  });

  test('recording the same item twice keeps one row with the latest purpose', async () => {
    const { recordSkipped, countBacklog } = await import('./index-backlog');
    await recordSkipped({ kind: 'document', sourceId: 'd1', ownerUserId: userId, purpose: 'document' });
    await recordSkipped({ kind: 'document', sourceId: 'd1', ownerUserId: userId, purpose: 'image_description' });
    expect(await countBacklog()).toBe(1);
    expect((await rows())[0]).toMatchObject({ kind: 'document', source_id: 'd1', purpose: 'image_description', attempts: 0 });
  });

  test('nothing runs while embedding is off; once on, each row is indexed and deleted', async () => {
    const { recordSkipped, runIndexBacklog, setBacklogIndexerForTest } = await import('./index-backlog');
    const { setCapabilitiesForTest } = await import('@/core/capabilities/gates');
    const indexed = vi.fn(async () => true);
    setBacklogIndexerForTest('note', indexed);
    setBacklogIndexerForTest('repo', indexed);
    await recordSkipped({ kind: 'note', sourceId: 'n1', ownerUserId: userId });
    await recordSkipped({ kind: 'repo', sourceId: 'r1', ownerUserId: userId });

    expect(await runIndexBacklog()).toEqual({ indexed: 0, dropped: 0, failed: 0 });
    expect(indexed).not.toHaveBeenCalled();
    expect(await rows()).toHaveLength(2);

    setCapabilitiesForTest({ embedding: true });
    expect(await runIndexBacklog()).toEqual({ indexed: 2, dropped: 0, failed: 0 });
    expect(indexed).toHaveBeenCalledTimes(2);
    expect(await rows()).toHaveLength(0);
  });

  test('a source that is gone is dropped; a failure keeps its row and does not block the rest', async () => {
    const { recordSkipped, runIndexBacklog, setBacklogIndexerForTest } = await import('./index-backlog');
    const { setCapabilitiesForTest } = await import('@/core/capabilities/gates');
    setBacklogIndexerForTest('document', async (row) => {
      if (row.sourceId === 'gone') return false;
      if (row.sourceId === 'bad') throw new Error('provider said no');
      return true;
    });
    await recordSkipped({ kind: 'document', sourceId: 'bad', ownerUserId: userId });
    await recordSkipped({ kind: 'document', sourceId: 'gone', ownerUserId: userId });
    await recordSkipped({ kind: 'document', sourceId: 'ok', ownerUserId: userId });
    setCapabilitiesForTest({ embedding: true });
    expect(await runIndexBacklog(1)).toEqual({ indexed: 1, dropped: 1, failed: 1 });
    expect(await rows()).toEqual([{ kind: 'document', source_id: 'bad', purpose: null, attempts: 1, last_error: 'provider said no' }]);
  });

  test('a row that keeps failing is given up after the attempt limit and stays for a person to see', async () => {
    const { recordSkipped, runIndexBacklog, setBacklogIndexerForTest, MAX_BACKLOG_ATTEMPTS } = await import('./index-backlog');
    const { setCapabilitiesForTest } = await import('@/core/capabilities/gates');
    const failing = vi.fn(async () => { throw new Error('still broken'); });
    setBacklogIndexerForTest('note', failing);
    await recordSkipped({ kind: 'note', sourceId: 'n-bad', ownerUserId: userId });
    setCapabilitiesForTest({ embedding: true });
    for (let i = 0; i < MAX_BACKLOG_ATTEMPTS + 2; i++) await runIndexBacklog();
    expect(failing).toHaveBeenCalledTimes(MAX_BACKLOG_ATTEMPTS);
    expect((await rows())[0]).toMatchObject({ source_id: 'n-bad', attempts: MAX_BACKLOG_ATTEMPTS, last_error: 'still broken' });
  });
});
