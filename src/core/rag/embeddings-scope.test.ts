import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EmbeddingService } from './embeddings';

/**
 * Tenant scoping of search (Tier 2 review fix). No embedding model is
 * configured, so semantic search degrades to FTS — which is exactly what
 * we want to assert the user_id filter on. Rows are seeded via store()
 * with a dummy vector so content_tsv is populated.
 */
describe('EmbeddingService search tenant scoping', () => {
  let svc: EmbeddingService;
  const userA = randomUUID();
  const userB = randomUUID();
  const vec = [0.1, 0.2, 0.3];

  beforeAll(async () => {
    process.env.STORAGE_MODE = 'embedded';
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-embscope-'));
    const { initializeDb } = await import('@/db/postgres');
    await initializeDb();
    const { runMigrations } = await import('@/db/migrate');
    await runMigrations();
    const mod = await import('./embeddings');
    svc = new mod.EmbeddingService('test-model');
  });

  afterAll(async () => {
    const { closeDb } = await import('@/db/postgres');
    await closeDb();
  });

  beforeEach(async () => {
    const { executeRaw } = await import('@/db/postgres');
    await executeRaw('TRUNCATE TABLE embeddings');
    // Same searchable term, different owners.
    await svc.store('note', `note:${randomUUID()}`, 'pineapple roadmap for alpha', vec, { title: 'A note' }, undefined, userA);
    await svc.store('note', `note:${randomUUID()}`, 'pineapple roadmap for beta', vec, { title: 'B note' }, undefined, userB);
  });

  test('ftsSearch with userId returns only that user’s rows', async () => {
    const a = await svc.ftsSearch('pineapple', 10, 'note', userA);
    expect(a).toHaveLength(1);
    expect(a[0].metadata.title).toBe('A note');
  });

  test('ftsSearch without userId returns all (global KB behaviour preserved)', async () => {
    const all = await svc.ftsSearch('pineapple', 10, 'note');
    expect(all).toHaveLength(2);
  });

  test('hybridSearch falls back to FTS and still scopes by userId', async () => {
    // No embedding model → hybridSearch falls back to ftsSearch(query, limit, purpose, userId).
    const b = await svc.hybridSearch('pineapple', 10, 'note', undefined, 0, userB);
    expect(b).toHaveLength(1);
    expect(b[0].metadata.title).toBe('B note');
  });
});
