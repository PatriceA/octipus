/**
 * An archived note is out of every search: its chunks stay in `embeddings`
 * (so unarchiving needs no re-index, and the lesson filer can still see an
 * archived lesson), but `search`, `ftsSearch`, `hybridSearch`,
 * `hybridSearchAnyTerm` and `hasReadableRows` leave them out in SQL, and so
 * do recall, `search_notes` and `search_knowledge`, which are built on them.
 * Embedded PGlite, real NoteService and SQL, a deterministic embedding stand-in.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ToolHandler } from '@/core/agent-worker';
import type { AgentContext } from '@/core/types';
import { fakeEmbedder, vectorLiteral } from '@/test-helpers/fake-embedding';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const userId = '7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a';
const scope = { kind: 'personal' as const, userId, workspaceId: null };
const embed = fakeEmbedder();
let executeRaw: (sql: string) => Promise<unknown>;
let queryRaw: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
let handlers: Map<string, ToolHandler>;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-archived-notes-'));
  const pg = await import('@/db/postgres');
  await pg.initializeDb();
  executeRaw = pg.executeRaw as typeof executeRaw;
  queryRaw = pg.queryRaw as typeof queryRaw;
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  await executeRaw(`INSERT INTO users (id, username, is_admin) VALUES ('${userId}', 'archie', false) ON CONFLICT DO NOTHING`);
  const { setCapabilitiesForTest } = await import('@/core/capabilities/gates');
  setCapabilitiesForTest({ embedding: true });
  const { NotesTool } = await import('@/tools/notes');
  const { KnowledgeTool } = await import('@/tools/knowledge');
  handlers = new Map();
  for (const tool of [new NotesTool(), new KnowledgeTool()]) {
    await tool.initialize();
    for (const h of tool.getToolHandlers()) handlers.set(h.name.replace(/^[a-z_]+__/, ''), h);
  }
});

afterAll(async () => {
  vi.restoreAllMocks();
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

beforeEach(async () => {
  await executeRaw('TRUNCATE TABLE notes CASCADE; DELETE FROM context_hooks; DELETE FROM context_turns; DELETE FROM embeddings;');
  const { resetNotesIndexCache } = await import('@/core/context-hooks/kinds');
  resetNotesIndexCache();
  const { getEmbeddingService } = await import('@/core/rag/embeddings');
  vi.spyOn(getEmbeddingService(), 'generateEmbedding').mockImplementation(async (text: string) => embed(text));
  vi.spyOn(getEmbeddingService(), 'embedBatch').mockImplementation(async (texts: string[]) => texts.map((t) => embed(t)));
  const { updateContextHook } = await import('@/core/context-hooks');
  await updateContextHook(userId, 'builtin:notes-index', { enabled: false });
});

afterEach(async () => {
  vi.restoreAllMocks();
  // recordAccess is fire-and-forget: let it land before the next test clears the table.
  await new Promise<void>((resolve) => setImmediate(resolve));
});

const ctx = (): AgentContext => ({
  space: null, trigger: 'user', funding: 'own',
  id: randomUUID(), sessionId: randomUUID(), userId, workspaceId: null,
  topic: 'test', model: 'test', role: 'research', status: 'running',
  createdAt: new Date(), updatedAt: new Date(), metadata: {},
});
const call = async (name: string, args: Record<string, unknown>) => {
  const h = handlers.get(name);
  if (!h) throw new Error(`handler ${name} not found`);
  return h.execute(args, ctx()) as Promise<{ results: Array<{ sourceId: string }> }>;
};

/** A note saved through NoteService (indexed for real); its kind decides note or lesson rows. */
async function saveNote(title: string, body: string, noteKind: 'note' | 'lesson' = 'note'): Promise<string> {
  const { getNoteService } = await import('@/core/knowledge/notes');
  const { personalNoteScope } = await import('@/db/repositories/note-repository');
  const saved = await getNoteService().save({ scope: personalNoteScope(userId, null), title, body, noteKind });
  expect(saved.indexed).toBe(true);
  return saved.note.id;
}

async function archive(id: string): Promise<void> {
  const { getNoteService } = await import('@/core/knowledge/notes');
  const { personalNoteScope } = await import('@/db/repositories/note-repository');
  expect(await getNoteService().archive(personalNoteScope(userId, null), id)).toBe(true);
}

/** A row with no note behind it: an uploaded document's chunk, or a note chunk whose note row is gone. */
async function rowWithoutNote(content: string, purpose: 'document' | 'note' = 'document'): Promise<string> {
  const id = randomUUID();
  await queryRaw(
    `INSERT INTO embeddings (id, source_id, content, model, embedding, purpose, content_sha256, embedding_version, user_id, metadata)
     VALUES ($1, $2, $3, 'fake', $4, $5, $6, 'fake/512', $7, $8)`,
    [id, purpose === 'note' ? `note:${randomUUID()}` : randomUUID(), content, vectorLiteral(embed(content)), purpose, randomUUID(), userId, JSON.stringify({ title: 'Upload' })],
  );
  return id;
}

async function recallText(query: string): Promise<string> {
  const { runContextHooks } = await import('@/core/context-hooks');
  const { text } = await runContextHooks({ event: 'turn_start', userId, workspaceId: null, sessionId: `sess-${randomUUID()}`, query, role: 'general', channel: 'web' });
  return text;
}

const sources = (results: Array<{ sourceId: string }>) => results.map((r) => r.sourceId).sort();

describe('the chunks of an archived note', () => {
  test('are left out of every search method, keep their rows, and come back on unarchive', async () => {
    const { getEmbeddingService } = await import('@/core/rag/embeddings');
    const service = getEmbeddingService();
    const noteId = await saveNote('Kiln schedule', 'The kiln firing schedule runs on Thursdays at cone six.');
    const lessonId = await saveNote('Kiln lesson', 'Kiln firing must cool overnight before unloading the glaze.', 'lesson');
    const query = 'kiln firing';
    const both = [`note:${lessonId}`, `note:${noteId}`].sort();
    const skip = { skipAccess: true };
    expect(sources(await service.hybridSearch(scope, query, 10, ['note', 'lesson'], 0.6, 0, skip))).toEqual(both);

    await archive(noteId);
    await archive(lessonId);
    // The rows are kept: unarchiving needs no re-index.
    const { rows } = await queryRaw(`SELECT count(*)::int AS n FROM embeddings WHERE source_id IN ($1, $2)`, [`note:${noteId}`, `note:${lessonId}`]);
    expect(Number(rows[0].n)).toBeGreaterThanOrEqual(2);

    expect(await service.hybridSearch(scope, query, 10, ['note', 'lesson'], 0.6, 0, skip)).toEqual([]);
    expect(await service.ftsSearch(scope, query, 10, ['note', 'lesson'], skip)).toEqual([]);
    expect(await service.search(scope, query, 10, ['note', 'lesson'], 0)).toEqual([]);
    expect((await service.hybridSearchAnyTerm(scope, query, 10, { purposes: ['note', 'lesson'] })).candidates).toEqual([]);
    expect((await service.hybridSearchAnyTerm(scope, query, 10, { purposes: ['note', 'lesson'], perSource: 3 })).candidates).toEqual([]);
    // Browsing the knowledge base does not list them either.
    expect((await service.listAll(scope, 50, 0)).entries.map((e) => e.sourceId).filter((id) => id === `note:${noteId}` || id === `note:${lessonId}`)).toEqual([]);
    // The Recall page's "has rows to recall" check does not count them either.
    expect(await service.hasReadableRows(scope, { purposes: ['note', 'lesson'], excludeProductDocs: true })).toBe(false);

    const { getNoteRepository } = await import('@/db/repositories/note-repository');
    expect(await getNoteRepository().unarchive(userId, noteId)).toBe(true);
    expect(sources(await service.hybridSearch(scope, query, 10, ['note', 'lesson'], 0.6, 0, skip))).toEqual([`note:${noteId}`]);
    expect(sources((await service.hybridSearchAnyTerm(scope, query, 10, { purposes: ['note', 'lesson'] })).candidates)).toEqual([`note:${noteId}`]);
    expect((await service.listAll(scope, 50, 0)).entries.some((e) => e.sourceId === `note:${noteId}`)).toBe(true);
    expect(await service.hasReadableRows(scope, { purposes: ['note', 'lesson'], excludeProductDocs: true })).toBe(true);
  });

  test('an ordinary document row, and a note chunk with no note row, are unaffected', async () => {
    const { getEmbeddingService } = await import('@/core/rag/embeddings');
    const service = getEmbeddingService();
    const doc = await rowWithoutNote('Invoice numbering restarts every fiscal year.');
    const orphan = await rowWithoutNote('Invoice numbering uses the year as prefix.', 'note');
    const archivedId = await saveNote('Invoices', 'Invoice numbering was continuous until we changed it.');
    await archive(archivedId);
    const hits = await service.hybridSearch(scope, 'invoice numbering', 10, undefined, 0.6, 0, { skipAccess: true });
    expect(hits.map((h) => h.id).sort()).toEqual([doc, orphan].sort());
    expect((await service.ftsSearch(scope, 'invoice numbering', 10, undefined, { skipAccess: true })).map((h) => h.id).sort()).toEqual([doc, orphan].sort());
    expect(await service.hasReadableRows(scope, { purposes: ['document'], excludeProductDocs: true })).toBe(true);
  });
});

describe('recall and the search tools', () => {
  test('recall does not show an archived note or lesson, and shows it again once unarchived', async () => {
    const noteId = await saveNote('Glaze recipe', 'The celadon glaze recipe uses two percent iron oxide.');
    const lessonId = await saveNote('Glaze lesson', 'Celadon glaze crawls when the bisque is dusty, so wipe it first.', 'lesson');
    const before = await recallText('What is in the celadon glaze recipe?');
    expect(before).toContain('iron oxide');

    await archive(noteId);
    await archive(lessonId);
    const after = await recallText('What is in the celadon glaze recipe?');
    expect(after).not.toContain('iron oxide');
    expect(after).not.toContain('bisque');

    const { getNoteRepository } = await import('@/db/repositories/note-repository');
    await getNoteRepository().unarchive(userId, noteId);
    expect(await recallText('What is in the celadon glaze recipe?')).toContain('iron oxide');
  });

  test('search_notes and search_knowledge do not return an archived note', async () => {
    const noteId = await saveNote('Studio alarm', 'The studio alarm code rotates monthly; ask Marta for it.');
    expect(sources((await call('search_notes', { query: 'studio alarm code' })).results)).toEqual([`note:${noteId}`]);
    expect(sources((await call('search_knowledge', { query: 'studio alarm code' })).results)).toEqual([`note:${noteId}`]);

    await archive(noteId);
    expect((await call('search_notes', { query: 'studio alarm code' })).results).toEqual([]);
    expect((await call('search_knowledge', { query: 'studio alarm code' })).results).toEqual([]);
    expect((await call('search_knowledge', { query: 'studio alarm code', mode: 'keyword' })).results).toEqual([]);
    expect((await call('search_knowledge', { query: 'studio alarm code', mode: 'semantic', min_similarity: 0 })).results).toEqual([]);
  });
});
