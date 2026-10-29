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
