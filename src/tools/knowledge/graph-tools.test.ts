import { afterAll, beforeAll, beforeEach, describe, expect, type Mock, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentContext } from '@/core/types';
import type { ToolHandler } from '@/core/agent-worker';

/**
 * Exercises the Tier 1 graph tools (link_knowledge, get_backlinks,
 * traverse_knowledge) through the real BaseTool dispatch against embedded
 * PGlite. Uses role='research' so the autonomous-worker path skips the
 * interactive permission prompt (mirrors production worker dispatch).
 */
describe('KnowledgeTool graph tools', () => {
  const userId = randomUUID();
  let handlers: Map<string, ToolHandler>;
  let embeddingSpy: Mock<(text: string) => Promise<number[]>> | undefined;

  const ctx = (): AgentContext => ({
    id: randomUUID(),
    sessionId: randomUUID(),
    userId,
    workspaceId: null,
    topic: 'test',
    model: 'test',
    role: 'research',
    status: 'running',
    createdAt: new Date(),
    updatedAt: new Date(),
    metadata: {},
  });

  const call = (name: string, args: Record<string, unknown>) => {
    const h = handlers.get(name);
    if (!h) throw new Error(`handler ${name} not found`);
    return h.execute(args, ctx());
  };

  beforeAll(async () => {
    process.env.STORAGE_MODE = 'embedded';
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-ktool-'));
    const { initializeDb } = await import('@/db/postgres');
    await initializeDb();
    const { runMigrations } = await import('@/db/migrate');
    await runMigrations();
    const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
    await seedUsers([{ id: userId, username: 'ktool-user' }]);

    // The tool resolves the getEmbeddingService() singleton internally, so stub
    // its network seam (generateEmbedding) here rather than injecting — without
    // it, entity/note indexing hits the absent LiteLLM proxy and retries ~6s,
    // timing out the suite (flaky in CI). Restored in afterAll so the stub does
    // not leak to later test files sharing the singleton.
    const { getEmbeddingService } = await import('@/core/rag/embeddings');
    embeddingSpy = spyOn(getEmbeddingService(), 'generateEmbedding').mockRejectedValue(
      new Error('No embedding model configured (test) — re-index degrades to indexed:false'),
    );
    // indexText embeds in batches, so `embedBatch` is the seam that must fail
    // locally too — otherwise indexing reaches a configured proxy for real.
    spyOn(getEmbeddingService(), 'embedBatch').mockImplementation(async (texts: string[]) =>
      texts.map(() => new Error('No embedding model configured (test) — re-index degrades to indexed:false')),
    );
    const { KnowledgeTool } = await import('./index');
    const tool = new KnowledgeTool();
    await tool.initialize();
    handlers = new Map(tool.getToolHandlers().map((h) => [h.name.replace('knowledge__', ''), h]));
  });

  afterAll(async () => {
    embeddingSpy?.mockRestore();
    const { closeDb } = await import('@/db/postgres');
    await closeDb();
  });

  beforeEach(async () => {
    const { executeRaw } = await import('@/db/postgres');
    await executeRaw('TRUNCATE TABLE knowledge_links');
  });

  test('link_knowledge creates a resolved edge and get_backlinks finds it', async () => {
    const noteA = randomUUID();
    const noteB = randomUUID();
    const linked = (await call('link_knowledge', {
      from_type: 'note', from_id: noteA,
      to_type: 'note', to_id: noteB, to_ref: 'note-b',
      link_type: 'references',
    })) as { linked: boolean; resolved: boolean };
    expect(linked.linked).toBe(true);
    expect(linked.resolved).toBe(true);

    const back = (await call('get_backlinks', { entity_type: 'note', entity_id: noteB })) as {
      backlinks: Array<{ from: { id: string } }>;
    };
    expect(back.backlinks).toHaveLength(1);
    expect(back.backlinks[0].from.id).toBe(noteA);
  });

  test('link_knowledge with only to_ref creates a ghost edge', async () => {
    const noteA = randomUUID();
    const res = (await call('link_knowledge', {
      from_type: 'note', from_id: noteA, to_ref: 'Future Note',
    })) as { resolved: boolean };
    expect(res.resolved).toBe(false);
    // Found by ref (slugified), not by id.
    const back = (await call('get_backlinks', { ref: 'future-note' })) as { backlinks: unknown[] };
    expect(back.backlinks).toHaveLength(1);
  });

  test('link_knowledge requires a target', async () => {
    await expect(call('link_knowledge', { from_type: 'note', from_id: randomUUID() })).rejects.toThrow(/to_id or to_ref/);
  });

  test('traverse_knowledge walks authored edges', async () => {
    const a = randomUUID();
    const b = randomUUID();
    const c = randomUUID();
    await call('link_knowledge', { from_type: 'note', from_id: a, to_type: 'note', to_id: b, to_ref: 'b', link_type: 'references' });
    await call('link_knowledge', { from_type: 'note', from_id: b, to_type: 'note', to_id: c, to_ref: 'c', link_type: 'references' });

    const r = (await call('traverse_knowledge', { entry_type: 'note', entry_id: a, hops: 2, direction: 'out' })) as {
      reached: Array<{ id: string; depth: number }>;
      count: number;
    };
    expect(r.count).toBe(2);
    expect(r.reached.find((n) => n.id === b)?.depth).toBe(1);
    expect(r.reached.find((n) => n.id === c)?.depth).toBe(2);
  });

  test('get_backlinks validates its arguments', async () => {
    await expect(call('get_backlinks', {})).rejects.toThrow(/requires/);
  });
});
