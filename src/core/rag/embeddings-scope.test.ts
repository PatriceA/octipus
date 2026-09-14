import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EmbeddingService, SearchScope } from './embeddings';

/**
 * Scoping of search against a real (embedded PGlite) DB. No embedding model is
 * configured, so semantic search degrades to FTS — which is exactly what we
 * want to assert the WHERE-clause filters on. Rows are seeded via store() with
 * a dummy vector so content_tsv is populated.
 *
 * NB: one DB lifecycle for the whole file. `initializeDb`/`closeDb` operate on
 * a process-wide singleton, so opening a second init/close cycle in a second
 * describe would tear the connection down under the first when bun interleaves
 * suites across files — leaving `db.execute` returning undefined. Keep a single
 * beforeAll/afterAll and give each group of tests its own beforeEach seed.
 */
let svc: EmbeddingService;
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

beforeEach(() => { vi.spyOn(svc, 'generateEmbedding').mockRejectedValue(new Error('Embedding provider disabled in scope tests')); });
afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('EmbeddingService search tenant scoping', () => {
  const userA = randomUUID();
  const userB = randomUUID();

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

/**
 * `searchGlobalDocs` must return ONLY the GLOBAL product-docs corpus
 * (`user_id IS NULL AND metadata.source = 'octipus-docs'`). This is the
 * multi-user fix: an unscoped `document` search would leak / be crowded out by
 * other tenants' private uploads. No embedding model is configured, so the
 * hybrid path degrades to FTS and we assert the real WHERE clause.
 */
describe('EmbeddingService.searchGlobalDocs scoping', () => {
  const userA = randomUUID();

  beforeEach(async () => {
    const { executeRaw } = await import('@/db/postgres');
    await executeRaw('TRUNCATE TABLE embeddings');
    // (1) The legit global product-docs chunk — the ONLY row /docs may return.
    await svc.store(
      'document',
      '/app/docs/CHANNELS.md',
      'telegram setup steps using BotFather',
      vec,
      { source: 'octipus-docs', filePath: '/app/docs/CHANNELS.md' },
      undefined,
      null, // GLOBAL
    );
    // (2) A DIFFERENT user's PRIVATE document row matching the same query —
    //     same purpose, even the same source tag — must be excluded by user_id.
    await svc.store(
      'document',
      '/uploads/a/telegram-notes.md',
      'my private telegram setup notes',
      vec,
      { source: 'octipus-docs', filePath: '/uploads/a/telegram-notes.md' },
      undefined,
      userA, // PRIVATE — must NOT appear
    );
    // (3) A GLOBAL document row that is NOT the docs corpus (no source tag) —
    //     excluded by the metadata->>'source' predicate.
    await svc.store(
      'document',
      '/uploads/global-misc.md',
      'telegram unrelated global upload',
      vec,
      { filePath: '/uploads/global-misc.md' },
      undefined,
      null,
    );
  });

  test('returns only the GLOBAL octipus-docs row; excludes a private doc and a non-docs global doc', async () => {
    const hits = await svc.searchGlobalDocs('telegram', 10);
    expect(hits).toHaveLength(1);
    expect(hits[0].sourceId).toBe('/app/docs/CHANNELS.md');
    expect(hits[0].metadata.source).toBe('octipus-docs');
    // The private user's row and the untagged global row are gone.
    expect(hits.some((h) => h.sourceId === '/uploads/a/telegram-notes.md')).toBe(false);
    expect(hits.some((h) => h.sourceId === '/uploads/global-misc.md')).toBe(false);
  });

  test('a tenant with MANY private docs cannot crowd the docs corpus out of the window', async () => {
    // Seed far more private rows than the fetch limit. With SQL-side scoping
    // the candidate window only ever holds global docs rows, so the single
    // octipus-docs chunk still surfaces even with limit=1.
    for (let i = 0; i < 60; i++) {
      await svc.store(
        'document',
        `/uploads/a/noise-${i}.md`,
        'telegram telegram telegram private noise document',
        vec,
        { source: 'octipus-docs', filePath: `/uploads/a/noise-${i}.md` },
        undefined,
        userA,
      );
    }
    const hits = await svc.searchGlobalDocs('telegram', 1);
    expect(hits).toHaveLength(1);
    expect(hits[0].sourceId).toBe('/app/docs/CHANNELS.md');
  });
});


describe('EmbeddingService repository visibility', () => {
  const owner = randomUUID();
  const allowed = randomUUID();
  const hidden = randomUUID();
  beforeAll(async () => {
    const { getDb } = await import('@/db/postgres');
    const { workspaceRepos } = await import('@/db/schema/workspace-repos');
    await getDb().insert(workspaceRepos).values([
      { id: allowed, userId: owner, name: 'allowed', rootPath: `/test/${allowed}` },
      { id: hidden, userId: owner, name: 'hidden', rootPath: `/test/${hidden}` },
    ]);
  });
  beforeEach(async () => {
    const { executeRaw } = await import('@/db/postgres');
    await executeRaw('TRUNCATE TABLE embeddings');
    await svc.store('knowledge_artifact', 'ordinary', 'visibilityneedle ordinary shared knowledge', vec, {}, undefined, null, null);
    await svc.store('knowledge_artifact', 'allowed', 'visibilityneedle allowed repository map', vec, {}, undefined, owner, allowed);
    await svc.store('knowledge_artifact', 'hidden', 'visibilityneedle hidden repository map', vec, {}, undefined, owner, hidden);
    vi.spyOn(svc, 'generateEmbedding').mockResolvedValue(vec);
  });
  test.each(['vector', 'fts', 'hybrid', 'fallback'] as const)('%s constrains candidates before ranking and intersects explicit repo selections', async mode => {
    if (mode === 'fallback') vi.mocked(svc.generateEmbedding).mockRejectedValue(new Error('offline fixture'));
    const search = (scope?: SearchScope) => mode === 'vector'
      ? svc.search('visibilityneedle', 10, 'knowledge_artifact', 0, undefined, scope)
      : mode === 'fts' ? svc.ftsSearch('visibilityneedle', 10, 'knowledge_artifact', undefined, scope)
      : svc.hybridSearch('visibilityneedle', 10, 'knowledge_artifact', undefined, 0, undefined, scope);
    const sources = async (scope?: SearchScope) => (await search(scope)).map(hit => hit.sourceId).sort();
    expect(await sources({ allowedRepoIds: [allowed] })).toEqual(['allowed', 'ordinary']);
    expect(await sources({ allowedRepoIds: [] })).toEqual(['ordinary']);
    expect(await sources({ allowedRepoIds: [allowed], repoIds: [hidden] })).toEqual([]);
    expect(await sources({ allowedRepoIds: [allowed], repoIds: [allowed, hidden] })).toEqual(['allowed']);
    expect(await sources({ allowedRepoIds: [], repoIds: [allowed] })).toEqual([]);
    expect(await sources({ allowedRepoIds: [allowed], repoIds: [] })).toEqual(['allowed', 'ordinary']);
    expect(await sources()).toEqual(['allowed', 'hidden', 'ordinary']);
  });
});
