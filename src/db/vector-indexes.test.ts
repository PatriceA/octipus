/**
 * The runtime HNSW ensure (src/db/vector-indexes.ts), on embedded PGlite with
 * the real migrations: a fresh install's empty embedding tables, data landing
 * later, and a drifted table.
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

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-vector-idx-'));
  const { initializeStorage } = await import('@/db/storage');
  initializeStorage({ mode: 'embedded' });
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: userId, username: 'vec' }]);
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  const { closeStorage } = await import('@/db/storage');
  await closeDb();
  await closeStorage();
});

async function q(query: string, params?: unknown[]) {
  const { queryRaw } = await import('@/db/postgres');
  return (await queryRaw(query, params)).rows;
}

async function insertEmbedding(vec: string): Promise<void> {
  await q(
    `INSERT INTO embeddings (id, source_id, content, embedding, model, purpose, content_sha256, embedding_version)
     VALUES ($1, $2, 'fixture', $3::vector, 'test', 'document', $4, 'test/3')`,
    [randomUUID(), randomUUID(), vec, randomUUID().replace(/-/g, '')],
  );
}

async function insertMemory(vec: string): Promise<void> {
  await q(
    `INSERT INTO memories (user_id, fact_type, content, embedding, embedding_version)
     VALUES ($1, 'preference', 'fixture', $2::vector, 'test/n')`,
    [userId, vec],
  );
}

async function hnswIndexes(table: string): Promise<string[]> {
  const rows = await q(
    `SELECT c.relname AS name FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_am am ON am.oid = c.relam WHERE i.indrelid = $1::regclass AND am.amname = 'hnsw' AND i.indisvalid`,
    [table],
  );
  return rows.map((r: { name: string }) => r.name);
}

describe('ensureVectorIndexes', () => {
  test('waits on empty tables, then pins and indexes once the rows share a dimension', async () => {
    const { ensureVectorIndexes } = await import('./vector-indexes');
    expect(await ensureVectorIndexes()).toEqual({ embeddings: 'empty', memories: 'empty' });

    await insertEmbedding('[0.1,0.2,0.3]');
    await insertEmbedding('[0.3,0.2,0.1]');
    expect(await ensureVectorIndexes()).toEqual({ embeddings: 'created', memories: 'empty' });
    expect(await hnswIndexes('embeddings')).toEqual(['embeddings_vector_idx']);
    const [col] = await q(`SELECT atttypmod AS dim FROM pg_attribute WHERE attrelid = 'embeddings'::regclass AND attname = 'embedding'`);
    expect(Number(col.dim)).toBe(3);

    // Second pass is a no-op; a row of another dimension is now refused at write.
    expect((await ensureVectorIndexes())?.embeddings).toBe('exists');
    await expect(insertEmbedding('[0.1,0.2]')).rejects.toThrow(/dimensions/);
  });

  test('a drifted column is reported and left alone', async () => {
    const { ensureVectorIndexes } = await import('./vector-indexes');
    await insertMemory('[0.1,0.2,0.3]');
    await insertMemory('[0.1,0.2]');
    expect((await ensureVectorIndexes())?.memories).toBe('drift');
    expect(await hnswIndexes('memories')).toEqual([]);
  });

  test('another instance holding the claim makes it a no-op', async () => {
    const { ensureVectorIndexes } = await import('./vector-indexes');
    const { rawStore } = await import('@/db/cache');
    expect(await rawStore().setIfAbsent('db:vector-index-ensure', 'other', 60)).toBe(true);
    try {
      expect(await ensureVectorIndexes()).toBeNull();
    } finally {
      await rawStore().del('db:vector-index-ensure');
    }
  });

  test('memory search orders by bare distance, which the HNSW index can serve', async () => {
    const { executeRaw } = await import('@/db/postgres');
    await executeRaw('DELETE FROM memories');
    const { ensureVectorIndexes } = await import('./vector-indexes');
    for (let i = 0; i < 20; i++) await insertMemory(`[${Math.random()},${Math.random()},${Math.random()}]`);
    expect((await ensureVectorIndexes())?.memories).toBe('created');
    // The view over the column (migration 0053) survived the pin.
    const [active] = await q('SELECT count(*)::int AS n FROM memories_active');
    expect(active.n).toBe(20);

    const { getMemoryRepository } = await import('@/core/memory/repository');
    const found = await getMemoryRepository().retrieveRelevant([0.5, 0.5, 0.5], { userId, limit: 5 });
    expect(found).toHaveLength(5);
    const sims = found.map((m) => m.similarity);
    expect([...sims].sort((a, b) => b - a)).toEqual(sims);
    expect(found[0]).not.toHaveProperty('embedding');
  });
});
