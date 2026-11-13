/**
 * No embedding model (docs/MODULES.md → Capability gates): nothing is read for
 * indexing, nothing is chunked, nothing is embedded, nothing is logged above
 * debug. Each entry point is checked with spies on the work it must not do.
 * Content that would have been indexed is recorded for the catch-up instead.
 */
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

const spies = vi.hoisted(() => ({
  recordSkipped: vi.fn(async () => {}),
  chunkMarkdown: vi.fn(() => []),
  fileAt: vi.fn(),
  extractFacts: vi.fn(async () => []),
}));

vi.mock('@/core/rag/index-backlog', () => ({ recordSkipped: spies.recordSkipped }));
vi.mock('@/core/rag/markdown-chunker', async (orig) => ({
  ...(await orig<typeof import('@/core/rag/markdown-chunker')>()),
  chunkMarkdown: spies.chunkMarkdown,
}));
vi.mock('@/utils/fs-file', async (orig) => ({
  ...(await orig<typeof import('@/utils/fs-file')>()),
  fileAt: spies.fileAt,
}));
vi.mock('@/core/memory/extractor', async (orig) => ({
  ...(await orig<typeof import('@/core/memory/extractor')>()),
  extractFacts: spies.extractFacts,
}));

const { setCapabilitiesForTest } = await import('./gates');
const { coreLogger } = await import('@/utils/logger');

const OWNER = { ownerUserId: '00000000-0000-4000-8000-000000000001', workspaceId: null };

beforeEach(() => {
  setCapabilitiesForTest({ embedding: false });
  vi.clearAllMocks();
});
afterAll(() => setCapabilitiesForTest({ embedding: true }));

describe('embedding not configured', () => {
  test('EmbeddingService: indexText refuses before splitting; embedding calls refuse without logging', async () => {
    const { EmbeddingService } = await import('@/core/rag/embeddings');
    const service = new EmbeddingService();
    const chunkText = vi.spyOn(service, 'chunkText');
    const embedBatch = vi.spyOn(service, 'embedBatch');
    const error = vi.spyOn(coreLogger, 'error');
    await expect(service.indexText(OWNER, 'document', 's1', '# Title\n\nsome markdown body')).rejects.toMatchObject({ code: 'capability_not_configured' });
    await expect(service.indexText(OWNER, 'document', 's2', 'plain text body')).rejects.toMatchObject({ code: 'capability_not_configured' });
    await expect(service.generateEmbedding('q', 'query')).rejects.toMatchObject({ code: 'capability_not_configured' });
    await expect(service.embedBatch(['a'])).rejects.toMatchObject({ code: 'capability_not_configured' });
    expect(chunkText).not.toHaveBeenCalled();
    expect(spies.chunkMarkdown).not.toHaveBeenCalled();
    expect(embedBatch).toHaveBeenCalledTimes(1); // only the direct call above
    expect(error).not.toHaveBeenCalled();
  });

  test('FileIndexer: the file is never opened', async () => {
    const { FileIndexer } = await import('@/core/rag/indexer');
    const indexer = new FileIndexer();
    await expect(indexer.indexFile(OWNER, '/tmp/notes.md')).rejects.toMatchObject({ code: 'capability_not_configured' });
    await expect(indexer.indexDirectory(OWNER, '/tmp')).rejects.toMatchObject({ code: 'capability_not_configured' });
    expect(spies.fileAt).not.toHaveBeenCalled();
  });

  test('document pipeline: recorded for catch-up, nothing chunked, the document is not failed', async () => {
    const { getEmbeddingService } = await import('@/core/rag/embeddings');
    const indexText = vi.spyOn(getEmbeddingService(), 'indexText');
    const { DocumentProcessor } = await import('@/core/documents/processor');
    const processor = new DocumentProcessor() as unknown as {
      indexDocument(owner: { userId: string; workspaceId: string | null }, id: string, text: string, filename: string, category: string, purpose?: 'image_description'): Promise<void>;
    };
    await expect(processor.indexDocument({ userId: OWNER.ownerUserId, workspaceId: null }, 'doc-1', 'text', 'a.pdf', 'misc', 'image_description')).resolves.toBeUndefined();
    expect(indexText).not.toHaveBeenCalled();
    expect(spies.recordSkipped).toHaveBeenCalledWith({
      kind: 'document', sourceId: 'doc-1', ownerUserId: OWNER.ownerUserId, workspaceId: null,
      purpose: 'image_description', metadata: { filePath: 'a.pdf' },
    });
  });

  test('notes: a save records the note for catch-up instead of chunking it', async () => {
    const { NoteService } = await import('@/core/knowledge/notes');
    const embeddings = { deleteBySource: vi.fn(async () => 0), indexText: vi.fn(), countBySource: vi.fn() };
    const service = new NoteService(undefined, undefined, embeddings as never) as unknown as { reindex(note: unknown): Promise<boolean> };
    const note = { id: 'note-1', userId: OWNER.ownerUserId, workspaceId: null, title: 'T', body: 'body text' };
    await expect(service.reindex(note)).resolves.toBe(false);
    expect(embeddings.indexText).not.toHaveBeenCalled();
    // The earlier body's chunks are removed (no model needed), so nothing stale is served.
    expect(embeddings.deleteBySource).toHaveBeenCalledWith(OWNER, 'note', 'note:note-1');
    expect(spies.recordSkipped).toHaveBeenCalledWith({ kind: 'note', sourceId: 'note-1', ownerUserId: OWNER.ownerUserId, workspaceId: null });
  });

  test('repositories: recorded for catch-up, the repo is not read', async () => {
    const { indexRepoKnowledge } = await import('@/core/repos/registry-service');
    const { getEmbeddingService } = await import('@/core/rag/embeddings');
    const indexText = vi.spyOn(getEmbeddingService(), 'indexText');
    await indexRepoKnowledge({ id: 'repo-1', name: 'r', rootPath: '/nonexistent', workspaceId: null, repoMap: 'map' } as never, OWNER.ownerUserId);
    expect(indexText).not.toHaveBeenCalled();
    expect(spies.recordSkipped).toHaveBeenCalledWith({ kind: 'repo', sourceId: 'repo-1', ownerUserId: OWNER.ownerUserId, workspaceId: null });
  });

  test('memory: nothing is extracted, so no background model call is made', async () => {
    const { updateMemoriesAfterTurn } = await import('@/core/memory');
    await expect(updateMemoriesAfterTurn({ userId: OWNER.ownerUserId, userMessage: 'I prefer tabs over spaces in TypeScript' } as never)).resolves.toEqual([]);
    expect(spies.extractFacts).not.toHaveBeenCalled();
  });

  test('recall hook: skipped with its reason, no search', async () => {
    const { KIND_RUNNERS } = await import('@/core/context-hooks/kinds');
    const { getEmbeddingService } = await import('@/core/rag/embeddings');
    const hybrid = vi.spyOn(getEmbeddingService(), 'hybridSearch');
    const result = await KIND_RUNNERS.recall({ userId: OWNER.ownerUserId, workspaceId: null, query: 'what did we decide about pricing' } as never, {});
    expect(result).toMatchObject({ status: 'skipped', reason: 'no_embedding_model' });
    expect(hybrid).not.toHaveBeenCalled();
  });

  test('tool ranking falls back to the full list without trying to embed', async () => {
    const { rankToolsByQuery } = await import('@/tools/tool-search');
    const { getEmbeddingService } = await import('@/core/rag/embeddings');
    const generate = vi.spyOn(getEmbeddingService(), 'generateEmbedding');
    await expect(rankToolsByQuery([{ name: 'a', description: 'b' } as never], 'find files', 3)).resolves.toBeNull();
    expect(generate).not.toHaveBeenCalled();
  });

  test('knowledge base functions are hidden from agents and refuse a stale call; product docs stay', async () => {
    const { KnowledgeTool } = await import('@/tools/knowledge');
    const tool = new KnowledgeTool();
    await tool.initialize();
    const { ToolExecutor } = await import('@/core/tool-executor');
    const { messageRepository } = await import('@/db/repositories/message-repository');
    const { auditRepository } = await import('@/db/repositories/audit-repository');
    vi.spyOn(messageRepository, 'create').mockResolvedValue({} as never);
    vi.spyOn(auditRepository, 'log').mockResolvedValue(undefined as never);
    const executor = new ToolExecutor({ id: 'agent-1', userId: 'u', sessionId: 's', status: 'running' } as never, () => {});
    executor.registerTools(tool.getToolHandlers());
    const visible = [...executor.getTools().keys()];
    expect(visible).toEqual(expect.arrayContaining(['knowledge__search_product_docs', 'knowledge__read_product_doc', 'knowledge__link_knowledge']));
    for (const name of ['search_knowledge', 'index_file', 'index_directory', 'read_knowledge', 'knowledge_stats', 'cleanup_knowledge', 'verify_knowledge']) {
      expect(visible).not.toContain(`knowledge__${name}`);
    }
    const [msg] = await executor.handleToolCalls([{ id: 'c1', name: 'knowledge__index_file', arguments: { path: 'x.md' } }]);
    expect(String(msg?.content)).toMatch(/not configured/);
    expect(spies.fileAt).not.toHaveBeenCalled();
    // Configured again: shown again, without a new spawn.
    setCapabilitiesForTest({ embedding: true });
    expect([...executor.getTools().keys()]).toContain('knowledge__search_knowledge');
  });

  test('a handler held from before refuses its own call', async () => {
    const { KnowledgeTool } = await import('@/tools/knowledge');
    const tool = new KnowledgeTool();
    await tool.initialize();
    const handler = tool.getTool('search_knowledge');
    await expect(handler?.execute({ query: 'q' }, { userId: 'u', id: 'a' } as never)).resolves.toMatchObject({ error: expect.stringMatching(/not configured/) });
  });
});

describe('embedding not configured — discovery and side paths', () => {
  test('list_tools and describe_tool never show a function whose capability is off', async () => {
    const { buildToolDiscoveryHandlers } = await import('@/tools/tool-discovery');
    const gated = { name: 'knowledge__search_knowledge', description: 'kb', parameters: {}, toolId: 'knowledge', requires: ['embedding'] as const, execute: async () => null };
    const plain = { name: 'notes__write_note', description: 'note', parameters: {}, toolId: 'notes', execute: async () => null };
    const [list, describeTool] = buildToolDiscoveryHandlers([gated, plain]);
    const listed = (await list.execute({}, {} as never)) as Array<{ name: string }>;
    expect(listed.map((t) => t.name)).toEqual(['notes__write_note']);
    await expect(describeTool.execute({ name: 'knowledge__search_knowledge' }, {} as never)).rejects.toThrow(/Unknown tool/);
    setCapabilitiesForTest({ embedding: true });
    expect(((await list.execute({}, {} as never)) as Array<{ name: string }>).map((t) => t.name)).toContain('knowledge__search_knowledge');
  });

  test('link suggestions and ghost-link resolution do not search (no model call either)', async () => {
    const { SuggestionService } = await import('@/core/knowledge/suggestions');
    const embeddings = { hybridSearch: vi.fn() };
    const notes = { getById: vi.fn(async () => ({ id: 'n', title: 'T', body: 'b' })) };
    const links = { getOutgoing: vi.fn(async () => []) };
    const suggestions = new SuggestionService(notes as never, links as never, embeddings as never);
    await expect(suggestions.suggestForNote({ kind: 'personal', userId: OWNER.ownerUserId, workspaceId: null } as never, 'n', 5)).resolves.toEqual([]);
    expect(embeddings.hybridSearch).not.toHaveBeenCalled();
  });

  test('a script that never initialised the gates gets the real answer, computed on first use', async () => {
    const gates = await import('./gates');
    gates.resetCapabilitiesForTest();
    for (const cap of ['see', 'ocr', 'draw', 'hear', 'speak'] as const) gates.setCapabilityResolver(cap, async () => ({ on: false }));
    gates.setCapabilityResolver('embedding', async () => ({ on: true }));
    expect(gates.isCapabilityOn('embedding')).toBe(false); // not checked yet
    await expect(gates.capabilityConfigured('embedding')).resolves.toBe(true);
    await expect(gates.requireCapability('embedding')).resolves.toBeUndefined();
    setCapabilitiesForTest({ embedding: false });
  });
});
