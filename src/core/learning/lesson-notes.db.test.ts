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

/**
 * "Rule <n>" texts: 8 dimensions, each pair related (cosine 0.75), none a
 * duplicate: √3 on a shared axis and 1 on an axis of its own.
 */
function ruleVector(n: number): number[] {
  const v = [Math.sqrt(3), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  v[n] = 1;
  return v;
}

/** Pool texts are one lesson; "replica" is related to it (cosine ≈ 0.75); anything else is unrelated. */
function vectorFor(text: string): number[] {
  const rule = /^Rule (\d+)/.exec(text);
  if (rule) return ruleVector(Number(rule[1]));
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
/** The inputs of the merge-model calls (not, say, a chunk abstract's). */
const mergeInputs = () => complete.mock.calls.filter(call => call[0].requestType === 'lesson-note-merge').map(call => JSON.parse(call[0].messages[1].content));

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

  test('a lesson seen again after expiry archived it revives that note, counted and searchable again', async () => {
    learning.lessonTtlDays = 90;
    const first = await lessons.fileLessonNote(item('The pool is capped at 10.'), ctx());
    await rows(`UPDATE notes SET updated_at = now() - interval '120 days' WHERE id = $1`, [first.id]);
    expect(await consolidation.expireLessonNotes(userId)).toBe(1);
    expect((await note(first.id)).frontmatter.archivedBy).toBe('expiry');

    complete.mockResolvedValue(reply('unchanged'));
    const again = await lessons.fileLessonNote(item('Pool: at most 10 connections.'), ctx());
    expect(again).toMatchObject({ status: 'merged', id: first.id });
    const row = await note(first.id);
    expect(row.archived_at).toBeNull();
    expect(row.frontmatter.sightings).toBe(2);
    expect(row.frontmatter.archivedBy).toBeUndefined();
    const { getEmbeddingService } = await import('@/core/rag/embeddings');
    const hits = await getEmbeddingService().hybridSearch({ kind: 'personal', userId, workspaceId: ws }, 'pool', 5, ['lesson'], 0.6, 0, { skipAccess: true });
    expect(hits.map(h => h.sourceId)).toContain(`note:${first.id}`);
    // The same text (by slug) revives it too.
    await rows(`UPDATE notes SET archived_at = now(), frontmatter = frontmatter || '{"archivedBy":"expiry"}'::jsonb WHERE id = $1`, [first.id]);
    expect(await lessons.fileLessonNote(item('The pool is capped at 10.'), ctx())).toMatchObject({ status: 'merged', id: first.id });
    expect((await note(first.id)).archived_at).toBeNull();
  });

  test('a lesson seen again after it was merged into another counts on the live note, through a chain of merges', async () => {
    const { getNoteService } = await import('@/core/knowledge/notes');
    const { personalNoteScope } = await import('@/db/repositories/note-repository');
    const save = async (body: string) => (await getNoteService().save({ scope: personalNoteScope(userId, ws), slug: `learning-${randomUUID()}`, title: 'Lesson', body,
      noteKind: 'lesson', tags: ['session-learning'], frontmatter: { lessonKind: 'fact', sightings: 1, sessions: [], learningJobIds: [], sources: [] } })).note.id;
    const live = await save('The pool is capped at 10.');
    const middle = await save('Pool and replica: the replica takes reads.');
    const absorbed = await save('Reads go to the replica.');
    // `absorbed` was merged into `middle`, which was merged into `live`.
    await rows(`UPDATE notes SET archived_at = now(), frontmatter = frontmatter || jsonb_build_object('mergedInto', $2::text) WHERE id = $1`, [absorbed, middle]);
    await rows(`UPDATE notes SET archived_at = now(), frontmatter = frontmatter || jsonb_build_object('mergedInto', $2::text) WHERE id = $1`, [middle, live]);
    complete.mockResolvedValue(reply('unchanged'));

    const result = await lessons.fileLessonNote(item('Reads go to the replica, always.'), ctx());

    expect(result).toMatchObject({ status: 'merged', id: live });
    expect((await note(live)).frontmatter.sightings).toBe(2);
    for (const id of [middle, absorbed]) expect((await note(id)).archived_at).not.toBeNull();
    expect(JSON.parse(complete.mock.calls[0][0].messages[1].content).allowDistinct).toBe(false);
  });

  test('archiving through the notes service drops the system marks: a lesson the user archived stays archived', async () => {
    const first = await lessons.fileLessonNote(item('The pool is capped at 10.'), ctx());
    // Left over on a live note (it was revived once): the user's archive must clear it.
    await rows(`UPDATE notes SET frontmatter = frontmatter || '{"archivedBy":"expiry"}'::jsonb WHERE id = $1`, [first.id]);
    const { getNoteService } = await import('@/core/knowledge/notes');
    const { personalNoteScope } = await import('@/db/repositories/note-repository');
    expect(await getNoteService().archive(personalNoteScope(userId, ws), first.id)).toBe(true);
    expect((await note(first.id)).frontmatter.archivedBy).toBeUndefined();

    expect(await lessons.fileLessonNote(item('Pool limited to ten.'), ctx())).toMatchObject({ status: 'duplicate', id: first.id });
    expect((await note(first.id)).archived_at).not.toBeNull();
  });

  test('two reviews merging into one note at once both count, with both sessions', async () => {
    const first = await lessons.fileLessonNote(item('The pool is capped at 10.'), ctx());
    complete.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      return reply('unchanged');
    });
    const a = ctx();
    const b = ctx();
    const results = await Promise.all([
      lessons.fileLessonNote(item('Pool: at most 10 connections.', { sources: ['event:a'] }), a),
      lessons.fileLessonNote(item('Ten connections in the pool, no more.', { sources: ['event:b'] }), b),
    ]);
    for (const result of results) expect(result).toMatchObject({ status: 'merged', id: first.id });
    const row = await note(first.id);
    expect(row.frontmatter.sightings).toBe(3);
    expect(row.frontmatter.sessions).toEqual(expect.arrayContaining([a.sessionId, b.sessionId]));
    expect(row.frontmatter.sources).toEqual(expect.arrayContaining(['event:a', 'event:b']));
  });

  test('a lesson that shares one paragraph with a longer note is related, not a duplicate', async () => {
    const shared = `The pool is capped at ten connections. ${'The proxy refuses more and the cap stays. '.repeat(14)}`;
    const own = `Deploys run from the main branch. ${'Each deploy waits for the checks to pass first. '.repeat(13)}`;
    const other = `Node 24 is the runtime. ${'Every service builds on that one version only. '.repeat(13)}`;
    const first = await lessons.fileLessonNote(item(`${shared}\n\n${own}`), ctx());
    expect((await rows(`SELECT count(*)::int AS n FROM embeddings WHERE source_id = $1`, [`note:${first.id}`]))[0].n).toBe(2);
    complete.mockResolvedValue(reply('distinct'));

    const second = await lessons.fileLessonNote(item(`${shared}\n\n${other}`), ctx());

    expect(second.status).toBe('saved');
    expect(second.id).not.toBe(first.id);
    expect(mergeInputs().map(input => input.allowDistinct)).toEqual([true]);
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
  test('converts a note a learning review wrote and its rows, skips a row its twin already covers, and runs twice', async () => {
    const legacy = randomUUID();
    const plain = randomUUID();
    const tagged = randomUUID();
    const inSpace = randomUUID();
    const space = randomUUID();
    await rows(`INSERT INTO workspaces (id, user_id, slug, name, is_default, files_dir, kind) VALUES ($1, NULL, $2, 'Space', false, $2, 'shared')`, [space, `space-${space}`]);
    const reviewFrontmatter = JSON.stringify({ sessionId: 's1', learningJobId: 'j1', sources: ['event:1'] });
    await rows(`INSERT INTO notes (id, user_id, workspace_id, slug, title, body, body_sha256, tags, note_kind, frontmatter) VALUES
      ($1, $3, $4, 'learning-abc', 'Old lesson', 'Pool cap.\n\nEvidence: session s1; event:1. Learning check j1.', 'x', ARRAY['session-learning'], 'note', $5::jsonb),
      ($2, $3, $4, 'mine', 'Mine', 'Groceries', 'y', ARRAY['home'], 'note', '{}'::jsonb)`, [legacy, plain, userId, ws, reviewFrontmatter]);
    // The user's own note tagged #session-learning: no review slug, no review key.
    await rows(`INSERT INTO notes (id, user_id, workspace_id, slug, title, body, body_sha256, tags, note_kind) VALUES
      ($1, $2, $3, 'what-i-learned', 'What I learned', 'Notes on the #session-learning talk', 'z', ARRAY['session-learning'], 'note')`, [tagged, userId, ws]);
    // A note of a shared space that looks like a review's: never converted.
    await rows(`INSERT INTO notes (id, user_id, workspace_id, slug, title, body, body_sha256, tags, note_kind, frontmatter) VALUES
      ($1, $2, $3, 'learning-def', 'Space lesson', 'Space pool cap.', 'w', ARRAY['session-learning'], 'note', $4::jsonb)`, [inSpace, userId, space, reviewFrontmatter]);
    const row = (source: string, sha: string, purpose = 'note', workspace: string = ws) => rows(`INSERT INTO embeddings (source_id, user_id, workspace_id, content, embedding, model, purpose, content_sha256, embedding_version)
      VALUES ($1, $2, $3, 'c', '[1,0,0,0]', 'm', $4, $5, 'm/4')`, [source, userId, workspace, purpose, sha]);
    await row(`note:${legacy}`, 'a');
    await row(`note:${legacy}`, 'b');
    await row(`note:${legacy}`, 'b', 'lesson'); // the twin of the second row
    await row(`note:${plain}`, 'c');
    await row(`note:${tagged}`, 'd');
    await row(`note:${inSpace}`, 'e', 'note', space);

    // An old review note: converted, it must start a full expiry window.
    await rows(`UPDATE notes SET updated_at = now() - interval '400 days' WHERE id IN ($1, $2)`, [legacy, plain]);
    const sql = readFileSync(join(process.cwd(), 'src/db/migrations/0200_lesson_notes.sql'), 'utf8');
    for (let run = 0; run < 2; run++) {
      for (const statement of sql.split('--> statement-breakpoint')) await rows(statement);
    }

    expect((await note(legacy)).note_kind).toBe('lesson');
    expect((await note(legacy)).body).toContain('Evidence: session');
    const [{ fresh }] = await rows(`SELECT updated_at > now() - interval '1 day' AS fresh FROM notes WHERE id = $1`, [legacy]) as Array<{ fresh: boolean }>;
    expect(fresh).toBe(true);
    const [{ old }] = await rows(`SELECT updated_at < now() - interval '300 days' AS old FROM notes WHERE id = $1`, [plain]) as Array<{ old: boolean }>;
    expect(old).toBe(true);
    expect((await purposes(legacy)).sort()).toEqual(['lesson', 'lesson']);
    for (const id of [plain, tagged, inSpace]) {
      expect((await note(id)).note_kind).toBe('note');
      expect(await purposes(id)).toEqual(['note']);
    }
    await rows('DELETE FROM notes WHERE workspace_id = $1', [space]);
    await rows('DELETE FROM workspaces WHERE id = $1', [space]);
  });
});

describe('consolidation of lesson notes', () => {
  /** A lesson note; its creation and last update both `createdDaysAgo` days back unless `updatedDaysAgo` says otherwise. */
  async function seedLesson(fields: { body: string; workspaceId?: string; owner?: string; pinned?: boolean; createdDaysAgo?: number; updatedDaysAgo?: number; sightings?: number }) {
    const { getNoteService } = await import('@/core/knowledge/notes');
    const { personalNoteScope } = await import('@/db/repositories/note-repository');
    const result = await getNoteService().save({
      scope: personalNoteScope(fields.owner ?? userId, fields.workspaceId ?? ws), slug: `learning-${randomUUID()}`, title: 'Lesson', body: fields.body,
      noteKind: 'lesson', tags: ['session-learning'],
      frontmatter: { sessionId: `s-${randomUUID()}`, learningJobId: 'j-legacy', sources: ['event:1'], ...(fields.sightings ? { sightings: fields.sightings } : {}) },
    });
    const days = fields.createdDaysAgo ?? 0;
    await rows(`UPDATE notes SET pinned = $2, created_at = now() - ($3 || ' days')::interval, updated_at = now() - ($4 || ' days')::interval WHERE id = $1`,
      [result.note.id, fields.pinned ?? false, String(days), String(fields.updatedDaysAgo ?? days)]);
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

  test('expiry archives only unpinned lessons neither updated nor shown within the TTL; lessonTtlDays 0 archives none', async () => {
    learning.lessonTtlDays = 90;
    const stale = await seedLesson({ body: 'Deploys go out on Tuesdays.', createdDaysAgo: 120 });
    // Old, never shown, but edited (or merged into) within the TTL: kept.
    const edited = await seedLesson({ body: 'Releases are signed with the release key.', createdDaysAgo: 120, updatedDaysAgo: 20 });
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
    for (const id of [pinned, young, recalled, edited]) expect((await note(id)).archived_at).toBeNull();
  });

  test('two pinned near-duplicates are both kept: a pin is never absorbed', async () => {
    const a = await seedLesson({ body: 'The pool is capped at 10.', pinned: true, sightings: 3 });
    const b = await seedLesson({ body: 'Pool size is ten.', pinned: true });
    complete.mockResolvedValue(reply('unchanged'));
    expect((await consolidation.consolidateProposals(userId)).notesMerged).toBe(0);
    for (const id of [a, b]) expect((await note(id)).archived_at).toBeNull();
    expect(complete).not.toHaveBeenCalled();
  });

  test('the absorbed note is archived only after the target holds it: a failed write leaves it live and uncounted', async () => {
    const target = await seedLesson({ body: 'The pool is capped at 10.', sightings: 3 });
    const absorbed = await seedLesson({ body: 'Pool size is ten.' });
    complete.mockResolvedValue(reply('merged', 'Pool cap', 'The pool is capped at 10 connections.'));
    const { getNoteService } = await import('@/core/knowledge/notes');
    const spy = vi.spyOn(getNoteService(), 'save').mockRejectedValueOnce(new Error('disk full'));
    try {
      await expect(consolidation.consolidateProposals(userId)).rejects.toThrow('disk full');
    } finally {
      spy.mockRestore();
    }
    expect((await note(absorbed)).archived_at).toBeNull();
    expect((await note(target)).frontmatter.sightings).toBe(3);
    // The next run merges them.
    expect((await consolidation.consolidateProposals(userId)).notesMerged).toBe(1);
    expect((await note(absorbed)).frontmatter.mergedInto).toBe(target);
    expect((await note(target)).frontmatter.sightings).toBe(4);
  });

  test('a target edited while the model answered: nothing is written, the absorbed note stays live', async () => {
    const target = await seedLesson({ body: 'The pool is capped at 10.', sightings: 3 });
    const absorbed = await seedLesson({ body: 'Pool size is ten.' });
    complete.mockImplementation(async () => {
      await rows(`UPDATE notes SET body = 'The pool is capped at 12.', body_sha256 = 'edited' WHERE id = $1`, [target]);
      return reply('merged', 'Pool cap', 'The pool is capped at 10 connections.');
    });
    expect((await consolidation.consolidateProposals(userId)).notesMerged).toBe(0);
    expect((await note(absorbed)).archived_at).toBeNull();
    expect(await note(target)).toMatchObject({ body: 'The pool is capped at 12.' });
    expect((await note(target)).frontmatter.sightings).toBe(3);
  });

  test('without a usable merge model two different texts are not archived into each other; identical ones are', async () => {
    const a = await seedLesson({ body: 'The pool is capped at 10.', sightings: 2 });
    const b = await seedLesson({ body: 'Pool size is ten.' });
    complete.mockRejectedValue(new Error('provider down'));
    expect((await consolidation.consolidateProposals(userId)).notesMerged).toBe(0);
    for (const id of [a, b]) expect((await note(id)).archived_at).toBeNull();

    const twin = await seedLesson({ body: 'The   pool is capped at 10.' });
    complete.mockClear();
    expect((await consolidation.consolidateProposals(userId)).notesMerged).toBe(1);
    expect((await note(twin)).frontmatter.mergedInto).toBe(a);
    expect((await note(a)).frontmatter.sightings).toBe(3);
  });

  test('two long notes sharing one paragraph are a related pair: the model may keep them apart', async () => {
    const shared = `The pool is capped at ten connections. ${'The proxy refuses more and the cap stays. '.repeat(14)}`;
    const x = await seedLesson({ body: `${shared}\n\nDeploys run from main. ${'Each deploy waits for the checks to pass first. '.repeat(13)}` });
    const y = await seedLesson({ body: `${shared}\n\nNode 24 is the runtime. ${'Every service builds on that one version only. '.repeat(13)}` });
    complete.mockResolvedValue(reply('distinct'));
    expect((await consolidation.consolidateProposals(userId)).notesMerged).toBe(0);
    for (const id of [x, y]) expect((await note(id)).archived_at).toBeNull();
    expect(mergeInputs().map(input => input.allowDistinct)).toEqual([true]);
  });

  test('a distinct verdict is remembered on both notes, and a run makes at most MAX_LESSON_MERGE_CALLS model calls', async () => {
    // Seven related notes: 21 pairs, all judged distinct.
    const ids: string[] = [];
    for (let n = 1; n <= 7; n++) ids.push(await seedLesson({ body: `Rule ${n} of the house.` }));
    complete.mockResolvedValue(reply('distinct'));

    expect((await consolidation.consolidateProposals(userId)).notesMerged).toBe(0);
    expect(complete).toHaveBeenCalledTimes(consolidation.MAX_LESSON_MERGE_CALLS);
    const listed = (await Promise.all(ids.map(note))).reduce((sum, row) => sum + (row.frontmatter.distinctFrom?.length ?? 0), 0);
    expect(listed).toBe(2 * consolidation.MAX_LESSON_MERGE_CALLS);

    // The next run asks only about the pair not judged yet; the one after asks nothing.
    complete.mockClear();
    await consolidation.consolidateProposals(userId);
    expect(complete).toHaveBeenCalledTimes(1);
    complete.mockClear();
    await consolidation.consolidateProposals(userId);
    expect(complete).not.toHaveBeenCalled();
  });

  test('a merge that rewrites a note clears its distinct verdicts', async () => {
    const a = await seedLesson({ body: 'The pool is capped at 10.', sightings: 2 });
    await seedLesson({ body: 'Pool size is ten.' });
    await rows(`UPDATE notes SET frontmatter = frontmatter || '{"distinctFrom":["x"]}'::jsonb WHERE id = $1`, [a]);
    complete.mockResolvedValue(reply('merged', 'Pool cap', 'The pool is capped at 10 connections.'));
    expect((await consolidation.consolidateProposals(userId)).notesMerged).toBe(1);
    expect((await note(a)).frontmatter.distinctFrom).toBeUndefined();
  });

  test('a lesson re-sighted recently but never shown to an agent is kept', async () => {
    learning.lessonTtlDays = 90;
    const old = await seedLesson({ body: 'Deploys go out on Tuesdays.', createdDaysAgo: 120 });
    expect((await rows(`SELECT count(*)::int AS n FROM embeddings WHERE source_id = $1 AND last_accessed_at IS NOT NULL`, [`note:${old}`]))[0].n).toBe(0);
    // Seen again in yesterday's review: merged into, one more sighting.
    complete.mockResolvedValue(reply('unchanged'));
    const filed = await lessons.fileLessonNote(item('Deploys go out on Tuesdays.', { extends: `note:${old}` }), ctx());
    expect(filed).toMatchObject({ status: 'merged', id: old });
    expect((await note(old)).frontmatter.sightings).toBe(2);
    // Indexing the merged text stamps no access: it was still never shown.
    expect((await rows(`SELECT count(*)::int AS n FROM embeddings WHERE source_id = $1 AND last_accessed_at IS NOT NULL`, [`note:${old}`]))[0].n).toBe(0);

    expect((await consolidation.consolidateProposals(userId)).notesArchived).toBe(0);
    expect((await note(old)).archived_at).toBeNull();
  });
});
