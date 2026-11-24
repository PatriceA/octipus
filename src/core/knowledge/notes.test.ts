import { personalNoteScope } from '@/db/repositories/note-repository';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NoteService } from './notes';
import type { KnowledgeLinkRepository } from '@/db/repositories/knowledge-link-repository';

/**
 * NoteService against embedded PGlite. No embedding model is configured
 * in the test env, so re-index degrades to indexed:false — the note and
 * its links must still persist (the design's degradation contract).
 */
describe('NoteService', () => {
  let svc: NoteService;
  let links: KnowledgeLinkRepository;
  const userId = randomUUID();

  beforeAll(async () => {
    process.env.STORAGE_MODE = 'embedded';
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-notes-'));
    const { initializeDb } = await import('@/db/postgres');
    await initializeDb();
    const { runMigrations } = await import('@/db/migrate');
    await runMigrations();
    const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
    await seedUsers([{ id: userId, username: 'notes-user' }]);
    const linksMod = await import('@/db/repositories/knowledge-link-repository');
    links = new linksMod.KnowledgeLinkRepository();
    // Inject a real EmbeddingService (not the getEmbeddingService() singleton),
    // so the DB methods (countBySource/deleteBySource) stay real — but stub the
    // single network seam, generateEmbedding, to fail locally.
    //
    // Without the stub, `new EmbeddingService('test-model')` only "degrades" if
    // NO embedding backend is reachable. When the dev/CI env has a LiteLLM proxy
    // configured (LITELLM_URL/key), the proxy accepts the bogus 'test-model' and
    // the embed call goes out for real → 401. That rejection (and the wrapped
    // "Indexing failed" error) surfaces asynchronously as an unhandled
    // rejection. Failing fast at the accessor (an instance spyOn) reproduces the
    // no-model degradation contract with zero network.
    const { EmbeddingService } = await import('@/core/rag/embeddings');
    const embeddings = new EmbeddingService('test-model');
    const noModel = new Error('No embedding model configured (test) — re-index degrades to indexed:false');
    vi.spyOn(embeddings, 'generateEmbedding').mockRejectedValue(noModel);
    // Indexing embeds in batches, so `embedBatch` is the network seam that
    // matters for the degradation contract — stubbing only generateEmbedding
    // would let indexText reach a configured proxy for real.
    vi.spyOn(embeddings, 'embedBatch').mockImplementation(async (texts: string[]) => texts.map(() => noModel));
    const mod = await import('./notes');
    svc = new mod.NoteService(undefined, undefined, embeddings);
  });

  afterAll(async () => {
    const { closeDb } = await import('@/db/postgres');
    await closeDb();
  });

  beforeEach(async () => {
    const { executeRaw } = await import('@/db/postgres');
    await executeRaw('TRUNCATE TABLE notes CASCADE'); // note_revisions and note_edit_proposals reference notes
    await executeRaw('TRUNCATE TABLE knowledge_links');
  });

  test('a lesson note sorts after ordinary notes by its kind, even without the tag', async () => {
    const { getDb } = await import('@/db/postgres');
    const { notes } = await import('@/db/schema/notes');
    const { createHash } = await import('node:crypto');
    const bodySha256 = createHash('sha256').update('').digest('hex');
    const lesson = randomUUID(), own = randomUUID();
    await getDb().insert(notes).values([
      { userId, id: lesson, slug: 'untagged-lesson', title: 'Lesson', bodySha256, noteKind: 'lesson', tags: [], updatedAt: new Date('2026-10-29') },
      { userId, id: own, slug: 'own', title: 'Own', bodySha256, tags: [], updatedAt: new Date('2000-01-01') },
    ]);
    expect((await svc.list(personalNoteScope(userId))).map(note => note.id)).toEqual([own, lesson]);
  });

  test('automated learnings cannot crowd ordinary or pinned notes out of the first page', async () => {
    const { getDb } = await import('@/db/postgres');
    const { notes } = await import('@/db/schema/notes');
    const { createHash } = await import('node:crypto');
    const bodySha256 = createHash('sha256').update('').digest('hex');
    const manual = randomUUID(), pin = randomUUID();
    await getDb().insert(notes).values([
      ...Array.from({ length: 501 }, (_, i) => ({ userId, id: randomUUID(), slug: `automatic-${i}`, title: `Automatic ${i}`, bodySha256, tags: ['session-learning'], updatedAt: new Date('2026-10-29') })),
      { userId, id: manual, slug: 'my-decision', title: 'My decision', bodySha256, tags: ['project'], updatedAt: new Date('2000-01-01') },
      { userId, id: pin, slug: 'pinned-lesson', title: 'Pinned lesson', bodySha256, tags: ['session-learning'], pinned: true, updatedAt: new Date('1990-01-01') },
    ]);
    const first = await svc.list(personalNoteScope(userId), { limit: 500 });
    expect(first[0].id).toBe(pin);
    expect(first.map(note => note.id)).toContain(manual);
    const explicit = await svc.list(personalNoteScope(userId), { tag: 'session-learning', limit: 500 });
    expect(explicit).toHaveLength(500);
    expect(explicit.every(note => note.tags.includes('session-learning'))).toBe(true);
  });

  test('save creates a note, derives slug, and wires wikilinks + tags', async () => {
    const r = await svc.save({
      scope: personalNoteScope(userId),
      title: 'My First Note',
      body: 'Links to [[Project Plan]] and is #important',
    });
    expect(r.created).toBe(true);
    expect(r.note.slug).toBe('my-first-note');
    expect(r.links.added).toBe(2); // one reference + one tag

    const out = await links.getOutgoing(userId, 'note', r.note.id);
    expect(out.map((e) => `${e.linkType}:${e.toRef}`).sort()).toEqual(['references:project-plan', 'tagged:important']);
  });

  test('re-index degrades to indexed:false without an embedding model but still saves', async () => {
    const r = await svc.save({ scope: personalNoteScope(userId), title: 'No Model', body: 'body text' });
    expect(r.created).toBe(true);
    expect(r.indexed).toBe(false);
    expect(await svc.getById(personalNoteScope(userId), r.note.id)).not.toBeNull();
  });

  test('deferIndex re-indexes once, after the note is quiet, from its latest text; the save does not wait', async () => {
    const { INDEX_DEBOUNCE_MS } = await import('./notes');
    // biome-ignore lint/suspicious/noExplicitAny: spying on the private re-index step
    const reindex = vi.spyOn(svc as any, 'reindex');
    reindex.mockClear();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const scope = personalNoteScope(userId);
      const first = await svc.save({ scope, title: 'Typing', body: 'one', deferIndex: true });
      expect(first).toMatchObject({ indexed: false, indexQueued: true });
      await svc.save({ scope, id: first.note.id, title: 'Typing', body: 'one two', deferIndex: true });
      await svc.save({ scope, id: first.note.id, title: 'Typing', body: 'one two three', deferIndex: true });
      expect(reindex).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(INDEX_DEBOUNCE_MS - 1);
      expect(reindex).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(reindex).toHaveBeenCalledTimes(1), { interval: 5, timeout: 5_000 });
      expect((reindex.mock.calls[0][0] as { body: string }).body).toBe('one two three');
    } finally {
      vi.useRealTimers();
      reindex.mockRestore();
    }
  });

  test('ifSha256 refuses a personal save over text saved since, and writes nothing', async () => {
    const { StaleWriteError } = await import('@/core/docs/hub');
    const scope = personalNoteScope(userId);
    const created = await svc.save({ scope, title: 'Shared draft', body: 'v1' });
    const base = created.note.bodySha256;
    await svc.save({ scope, id: created.note.id, title: 'Shared draft', body: 'v2 from the phone' });
    await expect(svc.save({ scope, id: created.note.id, title: 'Shared draft', body: 'v1 edited', ifSha256: base })).rejects.toBeInstanceOf(StaleWriteError);
    expect((await svc.getById(scope, created.note.id))?.body).toBe('v2 from the phone');
    const ok = await svc.save({ scope, id: created.note.id, title: 'Shared draft', body: 'v3', ifSha256: (await svc.getById(scope, created.note.id))!.bodySha256 });
    expect(ok.note.body).toBe('v3');
  });

  test('restoring a note that is not archived changes nothing', async () => {
    const scope = personalNoteScope(userId);
    const created = await svc.save({ scope, title: 'Active one', body: 'x' });
    const before = (await svc.getById(scope, created.note.id))!;
    expect(await svc.restore(scope, created.note.id)).toBe(true);
    const after = (await svc.getById(scope, created.note.id))!;
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    const { getNoteRepository } = await import('@/db/repositories/note-repository');
    expect(await getNoteRepository().unarchive(userId, created.note.id)).toBe(false);
  });

  test('unchanged body on re-save is a no-op for links', async () => {
    const first = await svc.save({ scope: personalNoteScope(userId), title: 'Stable', body: 'has [[a]] link' });
    expect(first.links.added).toBe(1);
    const second = await svc.save({ scope: personalNoteScope(userId), id: first.note.id, title: 'Stable', body: 'has [[a]] link' });
    expect(second.links).toEqual({ added: 0, removed: 0 });
  });

  test('editing the body diffs the links (add + remove)', async () => {
    const first = await svc.save({ scope: personalNoteScope(userId), title: 'Edited', body: '[[a]] [[b]]' });
    expect(first.links.added).toBe(2);
    const second = await svc.save({ scope: personalNoteScope(userId), id: first.note.id, title: 'Edited', body: '[[a]] [[c]]' });
    expect(second.links.added).toBe(1);
    expect(second.links.removed).toBe(1);
    const refs = (await links.getOutgoing(userId, 'note', first.note.id)).map((e) => e.toRef).sort();
    expect(refs).toEqual(['a', 'c']);
  });

  test('creating a note resolves ghost edges that referenced its slug', async () => {
    // Note B references a not-yet-existing [[Target]].
    const b = await svc.save({ scope: personalNoteScope(userId), title: 'B', body: 'see [[Target]]' });
    const ghost = (await links.getOutgoing(userId, 'note', b.note.id))[0];
    expect(ghost.toId).toBeNull();

    // Create Target — the ghost edge should now resolve to it.
    const target = await svc.save({ scope: personalNoteScope(userId), title: 'Target' });
    const resolved = (await links.getOutgoing(userId, 'note', b.note.id))[0];
    expect(resolved.toId).toBe(target.note.id);
    expect(resolved.toType).toBe('note');
  });

  test('an exact match reclaims an edge a similarity guess had bound', async () => {
    // The ghost-link resolver (link-resolver.ts) may bind [[Target]] to a
    // near-miss note by similarity, marking the binding with a confidence.
    // When a note with the *exact* slug later appears, the exact match must
    // win — a guess is never allowed to outlive the real thing.
    const guessed = await svc.save({ scope: personalNoteScope(userId), title: 'Nearly Target' });
    const b = await svc.save({ scope: personalNoteScope(userId), title: 'Guess Source', body: 'see [[Target]]' });

    await links.resolveTo({ scope: userId, toRef: 'target', toType: 'note', toId: guessed.note.id, confidence: 0.71 });
    let edge = (await links.getOutgoing(userId, 'note', b.note.id)).find((e) => e.linkType === 'references');
    expect(edge?.toId).toBe(guessed.note.id);
    expect(edge?.confidence).toBeCloseTo(0.71, 2);

    // A second guess must not churn an already-guessed edge.
    const other = await svc.save({ scope: personalNoteScope(userId), title: 'Another Near Miss' });
    expect(await links.resolveTo({ scope: userId, toRef: 'target', toType: 'note', toId: other.note.id, confidence: 0.9 })).toBe(0);

    // Creating the real note reclaims the edge and clears the guess score.
    const real = await svc.save({ scope: personalNoteScope(userId), title: 'Target' });
    edge = (await links.getOutgoing(userId, 'note', b.note.id)).find((e) => e.linkType === 'references');
    expect(edge?.toId).toBe(real.note.id);
    expect(edge?.confidence).toBeNull();
  });

  test('linking to an ALREADY-EXISTING note resolves the edge immediately (graph line shows)', async () => {
    // The QA bug: B exists first, then A links to it. The A→B edge used to
    // stay a ghost (to_id NULL) until B was next saved, so the graph (which
    // only draws resolved edges) showed no connection.
    const target = await svc.save({ scope: personalNoteScope(userId), title: 'Existing Target' });
    const a = await svc.save({ scope: personalNoteScope(userId), title: 'A', body: 'see [[Existing Target]]' });
    const edge = (await links.getOutgoing(userId, 'note', a.note.id)).find((e) => e.linkType === 'references');
    expect(edge?.toId).toBe(target.note.id);
    expect(edge?.toType).toBe('note');
  });

  test('moving a note keeps its old slug as an alias: links to it stay bound and new ones bind', async () => {
    const scope = personalNoteScope(userId);
    const plan = await svc.save({ scope, title: 'Plan', body: 'the plan' });
    const before = await svc.save({ scope, title: 'Linker', body: 'see [[Plan]]' });
    const waiting = await svc.save({ scope, title: 'Waiting', body: 'see [[projects/plan]]' });

    const moved = await svc.move(scope, plan.note.id, 'projects/Plan');
    expect(moved?.slug).toBe('projects/plan');
    expect(moved?.title).toBe('Plan');
    expect(moved?.frontmatter.movedFrom).toEqual(['plan']);
    // The link made before the move still points at the note…
    const edge = (id: string) => links.getOutgoing(userId, 'note', id).then((es) => es.find((e) => e.linkType === 'references'));
    expect((await edge(before.note.id))?.toId).toBe(plan.note.id);
    // …so does one saved after it with the old slug, and one that waited for the new slug.
    const after = await svc.save({ scope, title: 'Later', body: 'still [[Plan]]' });
    expect((await edge(after.note.id))?.toId).toBe(plan.note.id);
    expect((await edge(waiting.note.id))?.toId).toBe(plan.note.id);
    expect((await svc.resolveSlug(scope, 'plan'))?.id).toBe(plan.note.id);
    // The plain slug lookup is exact: a new note may take the old slug, and then wins it.
    expect(await svc.getBySlug(scope, 'plan')).toBeNull();
    const fresh = await svc.save({ scope, title: 'Plan', body: 'a new plan', createOnly: true });
    expect((await svc.resolveSlug(scope, 'plan'))?.id).toBe(fresh.note.id);

    // Moving back drops the alias it would shadow, and a taken slug is refused.
    const back = await svc.move(scope, plan.note.id, 'archive/plan');
    expect(back?.frontmatter.movedFrom).toEqual(['plan', 'projects/plan']);
    const { NoteExistsError, InvalidSlugError } = await import('./notes');
    await expect(svc.move(scope, plan.note.id, 'plan')).rejects.toBeInstanceOf(NoteExistsError);
    await expect(svc.move(scope, plan.note.id, '///')).rejects.toBeInstanceOf(InvalidSlugError);
    expect(await svc.move(personalNoteScope(randomUUID()), plan.note.id, 'x')).toBeNull();
  });

  test('one note holds a moved slug, and no save can plant one', async () => {
    const scope = personalNoteScope(userId);
    const a = await svc.save({ scope, title: 'Alpha', body: 'a' });
    const b = await svc.save({ scope, title: 'Beta', body: 'b' });
    await svc.move(scope, a.note.id, 'x/alpha');
    expect((await svc.resolveSlug(scope, 'alpha'))?.id).toBe(a.note.id);
    // Another note moved into the slug Alpha left takes it as its own: the old link means it now.
    await svc.move(scope, b.note.id, 'alpha');
    await svc.move(scope, b.note.id, 'y/beta');
    expect((await svc.getById(scope, a.note.id))?.frontmatter.movedFrom).toEqual([]);
    expect((await svc.resolveSlug(scope, 'alpha'))?.id).toBe(b.note.id);

    // A writer naming `movedFrom` in its frontmatter claims nothing, and keeps nothing it had.
    const c = await svc.save({ scope, title: 'Gamma', body: 'c', frontmatter: { movedFrom: ['y/beta-old', 'alpha'], mood: 'ok' } });
    expect(c.note.frontmatter).toEqual({ mood: 'ok' });
    expect((await svc.resolveSlug(scope, 'alpha'))?.id).toBe(b.note.id);
    const resaved = await svc.save({ scope, id: b.note.id, title: 'Beta', body: 'b2', frontmatter: { mood: 'fine' } });
    expect(resaved.note.frontmatter).toEqual({ mood: 'fine', movedFrom: ['beta', 'alpha'] });
  });

  test('getOrCreateDaily never replaces a daily note written meanwhile, and refuses an impossible day', async () => {
    const scope = personalNoteScope(userId);
    const { normalizeDay } = await import('./notes');
    // Another tab created the day's note between this one's read and its write.
    const realStore = svc.store.bind(svc);
    let raced = false;
    const spy = vi.spyOn(svc, 'store').mockImplementation((sc) => {
      const store = realStore(sc);
      return {
        ...store,
        getById: store.getById.bind(store),
        getBySlug: async (slug: string) => {
          if (!raced && slug === 'daily/2026-03-01') {
            raced = true;
            spy.mockRestore();
            await svc.save({ scope, slug, title: '2026-03-01', body: 'typed in the other tab', noteKind: 'daily' });
            return null;
          }
          return store.getBySlug(slug);
        },
      } as ReturnType<typeof realStore>;
    });
    const daily = await svc.getOrCreateDaily(scope, '2026-03-01');
    expect(daily.body).toBe('typed in the other tab');
    // The template lost the race: its create-only save was refused with the note that won, never written over it.
    expect(raced).toBe(true);
    await expect(svc.save({ scope, slug: 'daily/2026-03-01', title: '2026-03-01', body: 'template', createOnly: true }))
      .rejects.toMatchObject({ name: 'NoteExistsError', noteId: daily.id, slug: 'daily/2026-03-01' });
    expect(() => normalizeDay('2026-02-31')).toThrow(/Invalid date/);
    expect(normalizeDay('2028-02-29')).toBe('2028-02-29');
  });

  test('getOrCreateDaily is idempotent and stamps the date', async () => {
    const d1 = await svc.getOrCreateDaily(personalNoteScope(userId), '2026-06-09T12:00:00Z');
    expect(d1.slug).toBe('daily/2026-06-09');
    expect(d1.noteKind).toBe('daily');
    expect(d1.noteDate).toBe('2026-06-09');
    const d2 = await svc.getOrCreateDaily(personalNoteScope(userId), '2026-06-09');
    expect(d2.id).toBe(d1.id);
  });

  test('capture appends a timestamped bullet to the daily note', async () => {
    const note = await svc.capture(personalNoteScope(userId), 'remember the [[milk]]', '2026-06-09');
    expect(note.body).toContain('remember the [[milk]]');
    expect(note.noteKind).toBe('daily');
    // The captured wikilink is wired.
    const refs = (await links.getOutgoing(userId, 'note', note.id)).map((e) => e.toRef);
    expect(refs).toContain('milk');
  });

  test('remove cleans up edges and deletes the row', async () => {
    const n = await svc.save({ scope: personalNoteScope(userId), title: 'Doomed', body: '[[x]]' });
    expect((await links.getOutgoing(userId, 'note', n.note.id))).toHaveLength(1);
    const removed = await svc.remove(personalNoteScope(userId), n.note.id);
    expect(removed).toBe(true);
    expect(await svc.getById(personalNoteScope(userId), n.note.id)).toBeNull();
    expect(await links.getOutgoing(userId, 'note', n.note.id)).toHaveLength(0);
  });

  test('notes are tenant-scoped', async () => {
    const other = randomUUID();
    const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
    await seedUsers([{ id: other, username: 'notes-other' }]);
    const n = await svc.save({ scope: personalNoteScope(userId), title: 'Mine', body: 'x' });
    expect(await svc.getById(personalNoteScope(other), n.note.id)).toBeNull();
    expect(await svc.list(personalNoteScope(other))).toHaveLength(0);
  });
});
