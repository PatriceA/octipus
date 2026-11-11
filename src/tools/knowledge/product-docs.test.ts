import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import type { AgentContext } from '@/core/types';
import { productDocs } from '@/core/product-docs';
import { KnowledgeTool } from './index';

const userId = randomUUID();
beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-help-tools-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: userId, username: 'product-help-test' }]);
  const { getEmbeddingService } = await import('@/core/rag/embeddings');
  vi.spyOn(getEmbeddingService(), 'generateEmbedding').mockRejectedValue(new Error('No embedding model'));
});
afterAll(async () => {
  vi.restoreAllMocks();
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

test('bundled help tools are registered and dispatch independently of the embedding service', async () => {
  const tool = new KnowledgeTool();
  await tool.initialize();
  const context: AgentContext = { space: null, trigger: 'user', funding: 'own', id: randomUUID(), sessionId: randomUUID(), userId, workspaceId: null, topic: 'test', model: 'test', role: 'research', status: 'running', createdAt: new Date(), updatedAt: new Date(), metadata: {} };
  const search = vi.spyOn(productDocs, 'search').mockResolvedValue([{ file: 'CHANNELS.md', title: 'Channels', heading: 'Telegram', line: 2, excerpt: 'BotFather' }]);
  const read = vi.spyOn(productDocs, 'read').mockResolvedValue({ file: 'CHANNELS.md', line: 2, totalLines: 3, content: '2: Telegram', truncated: false });
  try {
    const handlers = new Map(tool.getToolHandlers().map(h => [h.name, h]));
    expect(await handlers.get('knowledge__search_product_docs')!.execute({ query: 'Telegram' }, context)).toHaveLength(1);
    expect(search).toHaveBeenCalledWith('Telegram', undefined);
    expect(await handlers.get('knowledge__read_product_doc')!.execute({ path: 'CHANNELS.md' }, context)).toMatchObject({ content: '2: Telegram' });
    expect(read).toHaveBeenCalledWith('CHANNELS.md', undefined, undefined);
  } finally { vi.restoreAllMocks(); }
});
