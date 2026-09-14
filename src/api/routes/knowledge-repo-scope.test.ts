import { beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from '@/api/http';

const fixture = vi.hoisted(() => ({
  user: { id: '11111111-1111-1111-1111-111111111111', username: 'alice', isAdmin: false },
  loadRepoGraph: vi.fn(),
  search: vi.fn(),
  ftsSearch: vi.fn(),
  hybridSearch: vi.fn(),
}));

vi.mock('@/api/context', async () => {
  const { App } = await import('@/api/http');
  return { apiContext: new App().derive(() => ({ user: fixture.user })) };
});

vi.mock('@/core/repos/registry-service', () => ({
  loadRepoGraph: fixture.loadRepoGraph,
}));

vi.mock('@/core/rag/embeddings', () => ({
  getEmbeddingService: () => ({
    search: fixture.search,
    ftsSearch: fixture.ftsSearch,
    hybridSearch: fixture.hybridSearch,
  }),
}));

vi.mock('@/core/rag/health', () => ({
  isKBReady: () => true,
  kbNotReadyResponse: () => ({ error: 'not ready' }),
  runKBSelfCheck: vi.fn(),
}));

vi.mock('@/core/rag/indexer', () => ({ getFileIndexer: vi.fn() }));

vi.mock('@/models/providers/instrumented', () => ({
  withProviderUsageContext: async (_context: unknown, run: () => Promise<unknown>) => run(),
}));

import { knowledgeRoutes } from './knowledge';

const app = new App().group('/api', group => group.use(knowledgeRoutes));

function search(body: Record<string, unknown>): Promise<Response> {
  return app.handle(new Request('http://test/api/knowledge/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'architecture', ...body }),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.loadRepoGraph.mockResolvedValue({
    repos: [{ id: 'repo-a' }, { id: 'repo-b' }],
    nodes: [],
    edges: [],
  });
  fixture.search.mockResolvedValue([]);
  fixture.ftsSearch.mockResolvedValue([]);
  fixture.hybridSearch.mockResolvedValue([]);
});

describe('POST /api/knowledge/search repository visibility', () => {
  test.each([
    ['semantic', fixture.search],
    ['keyword', fixture.ftsSearch],
    ['hybrid', fixture.hybridSearch],
  ] as const)('%s search receives all visible repo ids when repoIds is omitted', async (mode, searchMethod) => {
    const response = await search({ mode });

    expect(response.status).toBe(200);
    expect(fixture.loadRepoGraph).toHaveBeenCalledWith(fixture.user.id);
    expect(searchMethod).toHaveBeenCalledOnce();
    expect(searchMethod.mock.calls[0].at(-1)).toEqual({ allowedRepoIds: ['repo-a', 'repo-b'] });
  });

  test('an explicit unavailable repo id returns 400 before any search executes', async () => {
    const response = await search({ mode: 'hybrid', repoIds: ['repo-a', 'missing'] });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Unknown or unavailable repository id' });
    expect(fixture.search).not.toHaveBeenCalled();
    expect(fixture.ftsSearch).not.toHaveBeenCalled();
    expect(fixture.hybridSearch).not.toHaveBeenCalled();
  });

  test('an empty visibility set is passed through and never broadens the search', async () => {
    fixture.loadRepoGraph.mockResolvedValue({ repos: [], nodes: [], edges: [] });

    const response = await search({ mode: 'keyword' });

    expect(response.status).toBe(200);
    expect(fixture.ftsSearch).toHaveBeenCalledOnce();
    expect(fixture.ftsSearch.mock.calls[0].at(-1)).toEqual({ allowedRepoIds: [] });
  });
});
