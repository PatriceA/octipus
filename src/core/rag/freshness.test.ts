/**
 * Freshness in retrieval.
 *
 * The contract has two halves and both matter. Ranking must prefer the
 * recently verified row when relevance is otherwise equal — that is the whole
 * point. And the reported `similarity` must stay the raw cosine value, because
 * callers compare it against `minSimilarity`; folding age into it would mean an
 * old-but-perfect match silently fell below a caller's bar.
 *
 * Rows are seeded with identical vectors so relevance is genuinely tied and
 * age is the only thing left to order by.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { EmbeddingService } from './embeddings';

let svc: EmbeddingService;
const vec = [0.1, 0.2, 0.3];
const userId = randomUUID();

/** Backdate a row's verification, the way a fact written long ago looks. */
async function backdate(sourceId: string, days: number): Promise<void> {
  const { executeRaw } = await import('@/db/postgres');
  await executeRaw(
    `UPDATE embeddings SET last_verified_at = now() - interval '${days} days' WHERE source_id = '${sourceId}'`,
  );
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-freshness-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const mod = await import('./embeddings');
  svc = new mod.EmbeddingService('test-model');
  // A fixed query vector so `search` and `hybridSearch` run their real SQL
  // instead of degrading to keyword-only.
  vi.spyOn(svc, 'generateEmbedding').mockResolvedValue(vec);
});

afterAll(async () => {
  vi.restoreAllMocks();
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

const FRESH = 'note:fresh-row';
const STALE = 'note:stale-row';

beforeEach(async () => {
  const { executeRaw } = await import('@/db/postgres');
  await executeRaw('TRUNCATE TABLE embeddings');
  await svc.store('note', FRESH, 'pineapple roadmap decision alpha', vec, { title: 'fresh' }, undefined, userId);
  await svc.store('note', STALE, 'pineapple roadmap decision beta', vec, { title: 'stale' }, undefined, userId);
  await backdate(STALE, 730);
});

describe('store', () => {
  test('stamps verification, because writing content is confirming it', async () => {
    const results = await svc.search('pineapple', 10, 'note', 0, userId);
    const fresh = results.find((r) => r.sourceId === FRESH);
    expect(fresh?.lastVerifiedAt).toBeTruthy();
    expect(fresh?.ageDays).toBe(0);
  });
});

describe('vector search', () => {
  test('puts the recently verified row first when relevance is tied', async () => {
    const results = await svc.search('pineapple', 10, 'note', 0, userId);
    expect(results.map((r) => r.sourceId)).toEqual([FRESH, STALE]);
  });

  test('reports the age so a caller can hedge instead of asserting', async () => {
    const results = await svc.search('pineapple', 10, 'note', 0, userId);
    const stale = results.find((r) => r.sourceId === STALE);
    expect(stale?.ageDays).toBeGreaterThan(700);
  });

  test('does not fold age into the reported similarity', async () => {
    // Both rows carry the same vector as the query, so both must still read as
    // a perfect match — otherwise a two-year-old exact answer would fall below
    // a caller's minSimilarity and vanish rather than merely ranking lower.
    const results = await svc.search('pineapple', 10, 'note', 0, userId);
    for (const result of results) {
      expect(result.similarity).toBeGreaterThan(0.99);
    }
    expect(await svc.search('pineapple', 10, 'note', 0.99, userId)).toHaveLength(2);
  });
});

describe('hybrid search', () => {
  test('puts the recently verified row first when relevance is tied', async () => {
    const results = await svc.hybridSearch('pineapple roadmap decision', 10, 'note', 0.6, 0, userId);
    expect(results[0].sourceId).toBe(FRESH);
    expect(results.map((r) => r.sourceId)).toContain(STALE);
  });

  test('still reports raw cosine similarity', async () => {
    const results = await svc.hybridSearch('pineapple roadmap decision', 10, 'note', 0.6, 0, userId);
    for (const result of results) {
      expect(result.similarity).toBeGreaterThan(0.99);
    }
  });
});

describe('markVerified', () => {
  test('brings a stale row back level', async () => {
    const before = await svc.search('pineapple', 10, 'note', 0, userId);
    const staleId = before.find((r) => r.sourceId === STALE)?.id as string;
    expect(await svc.markVerified([staleId])).toBe(1);

    const after = await svc.search('pineapple', 10, 'note', 0, userId);
    expect(after.find((r) => r.sourceId === STALE)?.ageDays).toBe(0);
  });

  test('reports how many ids it did not find', async () => {
    expect(await svc.markVerified([randomUUID()])).toBe(0);
    expect(await svc.markVerified([])).toBe(0);
  });

  test('is separate from reading — a retrieved stale row stays stale', async () => {
    // `recordAccess` bumps last_accessed_at on every hit. If verification rode
    // that path, the most-read wrong answer would also look freshest.
    await svc.search('pineapple', 10, 'note', 0, userId);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const results = await svc.search('pineapple', 10, 'note', 0, userId);
    expect(results.find((r) => r.sourceId === STALE)?.ageDays).toBeGreaterThan(700);
  });

  test('marks by source id too', async () => {
    expect(await svc.markVerifiedBySource('note', STALE)).toBe(1);
    const results = await svc.search('pineapple', 10, 'note', 0, userId);
    expect(results.find((r) => r.sourceId === STALE)?.ageDays).toBe(0);
  });
});
