import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, type Mock, vi } from 'vitest';
import * as embeddings from '@/core/rag/embeddings';
import type { EmbeddingService, SearchResult } from '@/core/rag/embeddings';
import './docs'; // self-registers the /docs command
import { getCommand } from './registry';

/**
 * Tests for the `/docs` command. The command resolves the embedding service via
 * `getEmbeddingService()` and calls `searchGlobalDocs`, which hard-scopes the
 * query to the GLOBAL product-docs corpus IN SQL (`user_id IS NULL AND
 * metadata->>'source' = 'octipus-docs'`). That cross-tenant exclusion is proven
 * end-to-end against a real PGlite DB in `embeddings-scope.test.ts`; here we
 * assert the command delegates to that scoped method (with a sane limit) and
 * renders whatever it returns rather than re-filtering in JS.
 *
 * We own the service at the `getEmbeddingService` layer (a spyOn RESTORED in
 * afterAll), NOT via a prototype spy. Other suites call
 * `vi.mock('@/core/rag/embeddings', …)` — process-wide and persistent in
 * bun — which replaces `getEmbeddingService` with a stub that has no
 * `searchGlobalDocs`. A prototype spy would then never fire (the command's
 * `getEmbeddingService()` returns the leaked stub, not a real instance) and the
 * command would hit its catch path. Injecting our own service here keeps the
 * test hermetic regardless of which suites loaded first.
 */

let docsSpy: Mock<EmbeddingService['searchGlobalDocs']>;
let getServiceSpy: Mock<typeof embeddings.getEmbeddingService>;

beforeAll(() => {
  docsSpy = vi.fn(async () => [] as SearchResult[]);
  getServiceSpy = vi.spyOn(embeddings, 'getEmbeddingService').mockReturnValue({
    searchGlobalDocs: docsSpy,
  } as unknown as EmbeddingService);
});
afterAll(() => getServiceSpy.mockRestore());

function ctx(args: string) {
  return { sessionId: 'sess-1', userId: 'user-1', args };
}

function hit(over: Partial<SearchResult>): SearchResult {
  return {
    id: 'id',
    content: 'content',
    abstract: null,
    purpose: 'document',
    sourceId: '/app/docs/X.md',
    similarity: 0.5,
    metadata: { source: 'octipus-docs' },
    ...over,
  };
}

beforeEach(() => {
  docsSpy.mockReset();
  docsSpy.mockResolvedValue([]);
  // Re-assert the injection each test, in case another suite's process-wide
  // mock.module re-ran and clobbered the binding between tests.
  getServiceSpy.mockReturnValue({ searchGlobalDocs: docsSpy } as unknown as EmbeddingService);
});
afterEach(() => docsSpy.mockReset());

describe('/docs command', () => {
  test('is registered and listed', () => {
    const cmd = getCommand('docs');
    expect(cmd).toBeDefined();
    expect(cmd!.description.toLowerCase()).toContain('documentation');
  });

  test('prompts for usage when called with no query (no search)', async () => {
    const cmd = getCommand('docs')!;
    const res = await cmd.execute(ctx('   '));
    expect(res.response).toContain('Usage');
    expect(docsSpy).not.toHaveBeenCalled();
  });

  test('searches the GLOBAL docs corpus and formats the hits', async () => {
    docsSpy.mockResolvedValue([
      hit({
        sourceId: '/app/docs/CHANNELS.md',
        abstract: 'Set up Telegram by creating a bot with BotFather.',
        sectionPath: ['Channels', 'Telegram'],
        metadata: { source: 'octipus-docs', filePath: '/app/docs/CHANNELS.md' },
      }),
    ]);

    const cmd = getCommand('docs')!;
    const res = await cmd.execute(ctx('how do I set up telegram'));

    expect(docsSpy).toHaveBeenCalledTimes(1);
    // Delegates to the SQL-scoped method with a sane limit (no over-fetch×3).
    const [calledQuery, calledLimit] = docsSpy.mock.calls[0];
    expect(calledQuery).toBe('how do I set up telegram');
    expect(calledLimit).toBe(8);

    expect(res.response).toContain('Channels › Telegram');
    expect(res.response).toContain('BotFather');
    expect(res.response).toContain('CHANNELS.md');
  });

  test('trusts the SQL scope — renders whatever searchGlobalDocs returns without re-filtering', async () => {
    // searchGlobalDocs already excludes private + non-docs rows in SQL (proven
    // in embeddings-scope.test.ts). The command must NOT re-filter on
    // metadata.source: anything the scoped method returns is, by construction,
    // a global octipus-docs row and should render.
    docsSpy.mockResolvedValue([
      hit({
        sourceId: '/app/docs/PROVIDERS.md',
        abstract: 'Add a model provider in the Models page.',
        metadata: { source: 'octipus-docs', filePath: '/app/docs/PROVIDERS.md' },
      }),
    ]);
    const cmd = getCommand('docs')!;
    const res = await cmd.execute(ctx('add a model provider'));
    expect(res.response).toContain('PROVIDERS.md');
    expect(res.response).toContain('model provider');
  });

  test('does not over-fetch then post-filter: passes RESULT_LIMIT straight through', async () => {
    docsSpy.mockResolvedValue([]);
    const cmd = getCommand('docs')!;
    await cmd.execute(ctx('anything'));
    // The old impl asked for RESULT_LIMIT*3 (=24) then sliced; the scoped impl
    // asks for exactly RESULT_LIMIT because the SQL already filters the corpus.
    expect(docsSpy.mock.calls[0][1]).toBe(8);
  });

  test('reports no-match when the scoped search returns nothing', async () => {
    docsSpy.mockResolvedValue([]);
    const cmd = getCommand('docs')!;
    const res = await cmd.execute(ctx('quantum teleportation'));
    expect(res.response.toLowerCase()).toContain('no product documentation matches');
  });

  test('falls back gracefully when the KB throws', async () => {
    docsSpy.mockRejectedValue(new Error('KB not ready'));
    const cmd = getCommand('docs')!;
    const res = await cmd.execute(ctx('anything'));
    expect(res.response.toLowerCase()).toContain('unavailable');
  });
});
