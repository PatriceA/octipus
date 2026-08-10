import { afterAll, beforeAll, beforeEach, describe, expect, type Mock, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentContext } from '@/core/types';
import type { ToolHandler } from '@/core/agent-worker';

describe('NotesTool', () => {
  const userId = randomUUID();
  let handlers: Map<string, ToolHandler>;
  let embeddingSpy: Mock<(text: string) => Promise<number[]>> | undefined;

  const ctx = (): AgentContext => ({
    id: randomUUID(), sessionId: randomUUID(), userId, workspaceId: null,
    topic: 'test', model: 'test', role: 'research', status: 'running',
    createdAt: new Date(), updatedAt: new Date(), metadata: {},
  });
  const call = (name: string, args: Record<string, unknown>) => {
    const h = handlers.get(name);
    if (!h) throw new Error(`handler ${name} not found`);
    return h.execute(args, ctx());
  };

  beforeAll(async () => {
    process.env.STORAGE_MODE = 'embedded';
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-notestool-'));
    const { initializeDb } = await import('@/db/postgres');
    await initializeDb();
    const { runMigrations } = await import('@/db/migrate');
    await runMigrations();
    const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
    await seedUsers([{ id: userId, username: 'nt-user' }]);
    // The tool resolves the getEmbeddingService() singleton internally, so stub
    // its network seam (generateEmbedding) here rather than injecting — without
    // it, note saves/searches hit the absent LiteLLM proxy and retry ~6s,
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
    const { NotesTool } = await import('./index');
    const tool = new NotesTool();
    await tool.initialize();
    handlers = new Map(tool.getToolHandlers().map((h) => [h.name.replace('notes__', ''), h]));
  });

  afterAll(async () => {
    embeddingSpy?.mockRestore();
    const { closeDb } = await import('@/db/postgres');
    await closeDb();
  });

  beforeEach(async () => {
    const { executeRaw } = await import('@/db/postgres');
    await executeRaw('TRUNCATE TABLE notes');
    await executeRaw('TRUNCATE TABLE knowledge_links');
  });

  test('write_note then read_note round-trips with backlinks', async () => {
    const a = (await call('write_note', { title: 'Note A', body: 'points to [[Note B]]' })) as { id: string; slug: string };
    const b = (await call('write_note', { title: 'Note B', body: 'hello' })) as { id: string };

    const read = (await call('read_note', { id: b.id })) as { title: string; backlinks: Array<{ from: { id: string } }> };
    expect(read.title).toBe('Note B');
    // A's [[Note B]] resolved to B → B has a backlink from A.
    expect(read.backlinks.some((bl) => bl.from.id === a.id)).toBe(true);
  });

  test('list_notes filters by kind', async () => {
    await call('write_note', { title: 'Plain' });
    await call('capture_note', { text: 'a journal line', date: '2026-06-09' });
    const daily = (await call('list_notes', { kind: 'daily' })) as { notes: unknown[] };
    expect(daily.notes).toHaveLength(1);
    const all = (await call('list_notes', {})) as { notes: unknown[] };
    expect(all.notes.length).toBe(2);
  });

  test('archive_note hides it from default listing', async () => {
    const n = (await call('write_note', { title: 'Temp' })) as { id: string };
    expect(((await call('list_notes', {})) as { notes: unknown[] }).notes).toHaveLength(1);
    const res = (await call('archive_note', { id: n.id })) as { archived: boolean };
    expect(res.archived).toBe(true);
    expect(((await call('list_notes', {})) as { notes: unknown[] }).notes).toHaveLength(0);
  });

  test('suggest_links degrades to empty without an embedding model', async () => {
    const n = (await call('write_note', { title: 'Lonely' })) as { id: string };
    const res = (await call('suggest_links', { note_id: n.id })) as { suggestions: unknown[] };
    expect(res.suggestions).toEqual([]);
  });

  test('read_note requires id or slug', async () => {
    await expect(call('read_note', {})).rejects.toThrow(/requires id or slug/);
  });

  test('query_notes filters by tag', async () => {
    await call('write_note', { title: 'Tagged', body: 'has #project tag' });
    await call('write_note', { title: 'Untagged', body: 'nothing here' });
    const res = (await call('query_notes', { tag: 'project' })) as { notes: Array<{ title: string }> };
    expect(res.notes).toHaveLength(1);
    expect(res.notes[0].title).toBe('Tagged');
  });

  test('export_canvas returns a JSON Canvas for a note', async () => {
    const a = (await call('write_note', { title: 'Center', body: 'see [[Edge]]' })) as { id: string };
    await call('write_note', { title: 'Edge' });
    const canvas = (await call('export_canvas', { entry_type: 'note', entry_id: a.id, hops: 1 })) as { nodes: unknown[]; edges: unknown[] };
    expect(Array.isArray(canvas.nodes)).toBe(true);
    expect(canvas.nodes.length).toBeGreaterThanOrEqual(1);
  });

  test('query_notes filters by frontmatter and rejects an invalid sort', async () => {
    await call('write_note', { title: 'FM' });
    // No frontmatter set via write_note, so an equality filter returns nothing.
    const none = (await call('query_notes', { frontmatter: { status: 'active' } })) as { notes: unknown[] };
    expect(none.notes).toHaveLength(0);
    await expect(call('query_notes', { sort: 'bogus' })).rejects.toThrow(/Unknown sort/);
  });

  test('sync_vault fails loud when vault sync is disabled', async () => {
    await expect(call('sync_vault', { direction: 'export' })).rejects.toThrow(/disabled/i);
  });
});
