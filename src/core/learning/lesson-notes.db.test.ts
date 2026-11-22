/**
 * Lesson notes against embedded PGlite (docs/plans/learning-notes-and-skill-discovery.md):
 * filing (extends, exact content, by meaning, the related band, an archived
 * duplicate, scope), the purpose of their embedding rows, migration 0200, and
 * the two lesson-note steps of consolidation. The merge model and the
 * embedding provider are stubbed; NoteService, the embeddings table and the
 * SQL are real.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Config } from '@/config';

const userId = '77777777-7777-4777-8777-777777777777';
const otherId = '88888888-8888-4888-8888-888888888888';
const ws = randomUUID();
const sideWs = randomUUID();
const otherWs = randomUUID();

/** Pool texts are one lesson; "replica" is related to it (cosine ≈ 0.75); anything else is unrelated. */
function vectorFor(text: string): number[] {
  if (/replica/i.test(text)) return [1, 0.1, 0.5, 0];
  if (/pool/i.test(text)) return [1, 0.9, 0.1, 0];
  // Unrelated to the pool and to each other.
  if (/deploy/i.test(text)) return [0, 1, 0, 0];
  if (/node/i.test(text)) return [0, 0, 1, 0];
  if (/logs/i.test(text)) return [0, 0, 0, 1];
  if (/tests/i.test(text)) return [0, -1, 0, 0];
  if (/tickets/i.test(text)) return [0, 0, -1, 0];
  return [0, 0, 0, -1];
}

const complete = vi.fn();
const reply = (verdict: 'merged' | 'unchanged' | 'distinct', title = '', content = '') =>
  ({ content: JSON.stringify({ verdict, title, content }), finishReason: 'stop' });

let lessons: typeof import('./lesson-notes');
let consolidation: typeof import('./consolidation');
let learning: Config['learning'];
let saved: Config['learning'];

// biome-ignore lint/suspicious/noExplicitAny: raw rows
async function rows(text: string, params: unknown[] = []): Promise<any[]> {
  const { queryRaw } = await import('@/db/postgres');
  return (await queryRaw(text, params)).rows;
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-lesson-notes-'));
  process.env.MASTER_KEY ??= randomUUID(); process.env.JWT_SECRET ??= randomUUID(); process.env.SESSION_SECRET ??= randomUUID();
  process.env.LOG_LEVEL ??= 'error';
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: userId, username: 'lessons-a' }, { id: otherId, username: 'lessons-b' }]);
  await rows(`INSERT INTO workspaces (id, user_id, slug, name, is_default, files_dir) VALUES
    ($1, $4, 'default', 'Default', true, 'lessons-a'), ($2, $4, 'side', 'Side', false, 'lessons-side'), ($3, $5, 'default', 'Default', true, 'lessons-b')`,
  [ws, sideWs, otherWs, userId, otherId]);

  // A real EmbeddingService (its table methods are what is tested), with the
  // provider seams stubbed.
  const embeddingsModule = await import('@/core/rag/embeddings');
  const service = new embeddingsModule.EmbeddingService('test-model');
  vi.spyOn(service, 'generateEmbedding').mockImplementation(async (text: string) => vectorFor(text));
  vi.spyOn(service, 'embedBatch').mockImplementation(async (texts: string[]) => texts.map(vectorFor));
  vi.spyOn(embeddingsModule, 'getEmbeddingService').mockReturnValue(service);
  const registry = await import('@/models/model-registry');
  vi.spyOn(registry, 'getModelRegistry').mockReturnValue({
    getModelForTopic: async (topic: string) => (topic === 'background' ? { modelId: 'test-background', name: 'background-test' } : null),
  } as never);
  const client = await import('@/models/litellm-client');
  vi.spyOn(client, 'getLiteLLMClient').mockReturnValue({ complete } as never);
  const { setCapabilitiesForTest } = await import('@/core/capabilities/gates');
  setCapabilitiesForTest({ embedding: true });

  lessons = await import('./lesson-notes');
  consolidation = await import('./consolidation');
  const { getConfig } = await import('@/config');
  learning = getConfig().learning;
  saved = { ...learning };
});

afterAll(async () => {
  vi.restoreAllMocks();
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

beforeEach(async () => {
  await rows('TRUNCATE TABLE notes CASCADE');
  await rows(`DELETE FROM embeddings WHERE source_id LIKE 'note:%'`);
  complete.mockReset();
});
afterEach(() => { Object.assign(learning, saved); });

const ctx = (extra: Partial<import('./lesson-notes').LessonContext> = {}) =>
  ({ userId, workspaceId: ws, sessionId: `s-${randomUUID()}`, jobId: `j-${randomUUID()}`, ...extra });
const item = (content: string, extra: Partial<import('./lesson-notes').LessonItem> = {}) =>
  ({ title: 'Connection pool', content, kind: 'decision' as const, sources: ['event:1'], ...extra });

async function note(id: string) {
  const [row] = await rows('SELECT * FROM notes WHERE id = $1', [id]);
  return row;
}
async function purposes(id: string): Promise<string[]> {
  return (await rows(`SELECT purpose FROM embeddings WHERE source_id = $1`, [`note:${id}`])).map(r => r.purpose);
}

describe('fileLessonNote', () => {
  test('a new lesson is a lesson note indexed as lesson; an ordinary note stays note, and a kind change moves the rows', async () => {
    const result = await lessons.fileLessonNote(item('The pool is capped at 10: the proxy refuses more.'), ctx());
    expect(result.status).toBe('saved');
    const row = await note(result.id);
    expect(row).toMatchObject({ note_kind: 'lesson', workspace_id: ws, tags: ['session-learning'] });
    expect(row.frontmatter).toMatchObject({ lessonKind: 'decision', sightings: 1, sources: ['event:1'] });
    expect(row.body).not.toContain('Evidence:');
    expect(await purposes(result.id)).toEqual(['lesson']);

    const { getNoteService } = await import('@/core/knowledge/notes');
    const { personalNoteScope } = await import('@/db/repositories/note-repository');
    const own = await getNoteService().save({ scope: personalNoteScope(userId, ws), title: 'My note', body: 'Groceries' });
    expect(await purposes(own.note.id)).toEqual(['note']);
    // The same body, another kind: no row is left under the old purpose.
    await getNoteService().save({ scope: personalNoteScope(userId, ws), id: own.note.id, title: 'My note', body: 'Groceries', noteKind: 'lesson' });
    expect(await purposes(own.note.id)).toEqual(['lesson']);
    await getNoteService().save({ scope: personalNoteScope(userId, ws), id: own.note.id, title: 'My note', body: 'Groceries', noteKind: 'note' });
    expect(await purposes(own.note.id)).toEqual(['note']);
    // Deleting a lesson removes its rows.
    await getNoteService().remove(personalNoteScope(userId, ws), result.id);
    expect(await purposes(result.id)).toEqual([]);
  });

  test('extends merges into the named lesson note of this user and workspace', async () => {
    const first = await lessons.fileLessonNote(item('The pool is capped at 10.'), ctx());
    complete.mockResolvedValue(reply('merged', 'Connection pool cap', 'The pool is capped at 10 because the proxy refuses more; raising it was rejected.'));
    const second = await lessons.fileLessonNote(item('Unrelated wording', { extends: `note:${first.id}` }), ctx());
    expect(second).toMatchObject({ status: 'merged', id: first.id, merged: true });
    const row = await note(first.id);
    expect(row.title).toBe('Connection pool cap');
    expect(row.frontmatter.sightings).toBe(2);
    expect(JSON.parse(complete.mock.calls[0][0].messages[1].content).allowDistinct).toBe(false);
  });

  test('a lesson in another workspace or of another user is never a merge target', async () => {
    const side = await lessons.fileLessonNote(item('The pool is capped at 10.'), ctx({ workspaceId: sideWs }));
    const theirs = await lessons.fileLessonNote(item('The pool is capped at 10.'), ctx({ userId: otherId, workspaceId: otherWs }));
    // Even named by extends, and even with identical content.
    const mine = await lessons.fileLessonNote(item('The pool is capped at 10.', { extends: `note:${theirs.id}` }), ctx());
    expect(mine.status).toBe('saved');
    expect(new Set([side.id, theirs.id, mine.id]).size).toBe(3);
    expect(complete).not.toHaveBeenCalled();
    for (const id of [side.id, theirs.id]) expect((await note(id)).frontmatter.sightings).toBe(1);
  });

  test('the related band merges only when the model says it is one lesson; distinct files a second note', async () => {
    const first = await lessons.fileLessonNote(item('The pool is capped at 10.'), ctx());
    complete.mockResolvedValue(reply('distinct'));
    const second = await lessons.fileLessonNote(item('Reads go to the replica.'), ctx());
    expect(second.status).toBe('saved');
    expect(second.id).not.toBe(first.id);
    expect(JSON.parse(complete.mock.calls[0][0].messages[1].content).allowDistinct).toBe(true);
  });

  test('a failing merge model counts a duplicate only, and keeps a related lesson apart', async () => {
    const first = await lessons.fileLessonNote(item('The pool is capped at 10.'), ctx());
    const before = await note(first.id);
    complete.mockRejectedValue(new Error('provider down'));
    const duplicate = await lessons.fileLessonNote(item('Pool: at most 10 connections.'), ctx());
    expect(duplicate).toMatchObject({ status: 'merged', id: first.id, mergeDegraded: true });
    const after = await note(first.id);
    expect(after.body).toBe(before.body);
    expect(after.frontmatter.sightings).toBe(2);
    const related = await lessons.fileLessonNote(item('Reads go to the replica.'), ctx());
    expect(related.status).toBe('saved');
    expect(related.id).not.toBe(first.id);
  });

  test('a duplicate of an archived lesson is dropped, by meaning and by exact content', async () => {
    const first = await lessons.fileLessonNote(item('The pool is capped at 10.'), ctx());
    await rows('UPDATE notes SET archived_at = now() WHERE id = $1', [first.id]);
    expect(await lessons.fileLessonNote(item('The pool is capped at 10.'), ctx())).toMatchObject({ status: 'duplicate', id: first.id });
    expect(await lessons.fileLessonNote(item('Pool limited to ten.'), ctx())).toMatchObject({ status: 'duplicate', id: first.id });
    expect((await note(first.id)).archived_at).not.toBeNull();
    expect(complete).not.toHaveBeenCalled();
  });

  test('without an embedding model: extends and exact content still merge, nothing else does', async () => {
    const { setCapabilitiesForTest } = await import('@/core/capabilities/gates');
    setCapabilitiesForTest({ embedding: false });
    try {
      const first = await lessons.fileLessonNote(item('The pool is capped at 10.'), ctx());
      expect(first.status).toBe('saved_unindexed');
      expect(await lessons.fileLessonNote(item('The pool is capped at 10.'), ctx())).toMatchObject({ id: first.id, merged: true });
      expect((await lessons.fileLessonNote(item('Pool limited to ten.'), ctx())).id).not.toBe(first.id);
    } finally {
      setCapabilitiesForTest({ embedding: true });
    }
  });
});

describe('migration 0200', () => {
  test('converts a legacy tagged note and its rows, skips a row its twin already covers, and runs twice', async () => {
    const legacy = randomUUID();
    const plain = randomUUID();
    await rows(`INSERT INTO notes (id, user_id, workspace_id, slug, title, body, body_sha256, tags, note_kind) VALUES
      ($1, $3, $4, 'learning-abc', 'Old lesson', 'Pool cap.\n\nEvidence: session s1; event:1. Learning check j1.', 'x', ARRAY['session-learning'], 'note'),
      ($2, $3, $4, 'mine', 'Mine', 'Groceries', 'y', ARRAY['home'], 'note')`, [legacy, plain, userId, ws]);
    const row = (source: string, sha: string, purpose = 'note') => rows(`INSERT INTO embeddings (source_id, user_id, workspace_id, content, embedding, model, purpose, content_sha256, embedding_version)
      VALUES ($1, $2, $3, 'c', '[1,0,0,0]', 'm', $4, $5, 'm/4')`, [source, userId, ws, purpose, sha]);
    await row(`note:${legacy}`, 'a');
    await row(`note:${legacy}`, 'b');
    await row(`note:${legacy}`, 'b', 'lesson'); // the twin of the second row
    await row(`note:${plain}`, 'c');

    const sql = readFileSync(join(process.cwd(), 'src/db/migrations/0200_lesson_notes.sql'), 'utf8');
    for (let run = 0; run < 2; run++) {
      for (const statement of sql.split('--> statement-breakpoint')) await rows(statement);
    }

    expect((await note(legacy)).note_kind).toBe('lesson');
    expect((await note(legacy)).body).toContain('Evidence: session');
    expect((await note(plain)).note_kind).toBe('note');
    expect((await purposes(legacy)).sort()).toEqual(['lesson', 'lesson']);
    expect(await purposes(plain)).toEqual(['note']);
  });
});

describe('consolidation of lesson notes', () => {
  async function seedLesson(fields: { body: string; workspaceId?: string; owner?: string; pinned?: boolean; createdDaysAgo?: number; sightings?: number }) {
    const { getNoteService } = await import('@/core/knowledge/notes');
    const { personalNoteScope } = await import('@/db/repositories/note-repository');
    const result = await getNoteService().save({
      scope: personalNoteScope(fields.owner ?? userId, fields.workspaceId ?? ws), slug: `learning-${randomUUID()}`, title: 'Lesson', body: fields.body,
      noteKind: 'lesson', tags: ['session-learning'],
      frontmatter: { sessionId: `s-${randomUUID()}`, learningJobId: 'j-legacy', sources: ['event:1'], ...(fields.sightings ? { sightings: fields.sightings } : {}) },
    });
    const days = fields.createdDaysAgo ?? 0;
    await rows(`UPDATE notes SET pinned = $2, created_at = now() - ($3 || ' days')::interval WHERE id = $1`, [result.note.id, fields.pinned ?? false, String(days)]);
    return result.note.id;
  }

  test('near-duplicates merge into the pinned, then more-seen note; the absorbed one is archived and the footer is gone', async () => {
    const legacyFooter = '\n\nEvidence: session s1; event:1. Learning check j1.';
    const seen = await seedLesson({ body: `The pool is capped at 10.${legacyFooter}`, sightings: 3 });
    const pinned = await seedLesson({ body: 'Pool size is ten.', pinned: true });
    const elsewhere = await seedLesson({ body: 'The pool is capped at 10.', workspaceId: sideWs });
    const theirs = await seedLesson({ body: 'The pool is capped at 10.', owner: otherId, workspaceId: otherWs });
    complete.mockResolvedValue(reply('unchanged'));

    const report = await consolidation.consolidateProposals(userId);

    expect(report).toMatchObject({ notesMerged: 1, notesArchived: 0, degraded: 0 });
    const target = await note(pinned);
    expect(target.archived_at).toBeNull();
    expect(target.frontmatter.sightings).toBe(4);
    expect(target.frontmatter.sessions).toHaveLength(2);
    const absorbed = await note(seen);
    expect(absorbed.archived_at).not.toBeNull();
    expect(absorbed.frontmatter.mergedInto).toBe(pinned);
    for (const id of [elsewhere, theirs]) expect((await note(id)).archived_at).toBeNull();
  });

  test('a rewritten note loses its legacy evidence footer', async () => {
    const a = await seedLesson({ body: 'The pool is capped at 10.\n\nEvidence: session s1; event:1. Learning check j1.', sightings: 2 });
    await seedLesson({ body: 'Pool size is ten.' });
    complete.mockResolvedValue(reply('merged', 'Pool cap', 'The pool is capped at 10 connections.\n\nEvidence: session s9; event:2. Learning check j9.'));
    expect((await consolidation.consolidateProposals(userId)).notesMerged).toBe(1);
    const row = await note(a);
    expect(row.body).toBe('The pool is capped at 10 connections.');
    expect(await purposes(a)).toEqual(['lesson']);
  });

  test('maxMerges is shared with proposal merges', async () => {
    await seedLesson({ body: 'The pool is capped at 10.' });
    await seedLesson({ body: 'Pool size is ten.' });
    complete.mockResolvedValue(reply('unchanged'));
    expect((await consolidation.consolidateProposals(userId, { maxMerges: 0 })).notesMerged).toBe(0);
    expect(complete).not.toHaveBeenCalled();
  });

  test('expiry archives only unpinned, old, unaccessed lessons; lessonTtlDays 0 archives none', async () => {
    learning.lessonTtlDays = 90;
    const stale = await seedLesson({ body: 'Deploys go out on Tuesdays.', createdDaysAgo: 120 });
    const pinned = await seedLesson({ body: 'Builds use node 24.', createdDaysAgo: 120, pinned: true });
    const young = await seedLesson({ body: 'Logs are kept a week.', createdDaysAgo: 10 });
    const recalled = await seedLesson({ body: 'Tests run on CI only.', createdDaysAgo: 120 });
    await rows(`UPDATE embeddings SET last_accessed_at = now() - interval '5 days' WHERE source_id = $1`, [`note:${recalled}`]);
    const ignoredLongAgo = await seedLesson({ body: 'Tickets live in the tracker.', createdDaysAgo: 200 });
    await rows(`UPDATE embeddings SET last_accessed_at = now() - interval '150 days' WHERE source_id = $1`, [`note:${ignoredLongAgo}`]);

    learning.lessonTtlDays = 0;
    expect((await consolidation.consolidateProposals(userId)).notesArchived).toBe(0);

    learning.lessonTtlDays = 90;
    expect((await consolidation.consolidateProposals(userId)).notesArchived).toBe(2);
    expect((await note(stale)).archived_at).not.toBeNull();
    expect((await note(ignoredLongAgo)).archived_at).not.toBeNull();
    for (const id of [pinned, young, recalled]) expect((await note(id)).archived_at).toBeNull();
  });
});
