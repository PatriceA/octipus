import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentContext } from '@/core/types';
import type { ToolHandler } from '@/core/agent-worker';

describe('NotesTool', () => {
  const userId = randomUUID();
  let handlers: Map<string, ToolHandler>;

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
    const { NotesTool } = await import('./index');
    const tool = new NotesTool();
    await tool.initialize();
    handlers = new Map(tool.getToolHandlers().map((h) => [h.name.replace('notes__', ''), h]));
  });

  afterAll(async () => {
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
});
