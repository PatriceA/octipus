import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
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
    // Inject a real EmbeddingService (not getEmbeddingService(), which other
    // test files mock.module into a partial stub that leaks across the suite),
    // so the DB methods (countBySource/deleteBySource) stay real — but stub the
    // single network seam, generateEmbedding, to fail locally.
    //
    // Without the stub, `new EmbeddingService('test-model')` only "degrades" if
    // NO embedding backend is reachable. When the dev/CI env has a LiteLLM proxy
    // configured (LITELLM_URL/key), the proxy accepts the bogus 'test-model' and
    // the embed call goes out for real → 401. That rejection (and the wrapped
    // "Indexing failed" error) surfaces asynchronously and bun attributes it to
    // whichever unrelated test happens to be running — most visibly flaking
    // `LiteLLMProvider > checkHealth` in the full-suite run. Failing fast at the
    // accessor (instance spyOn, not a prototype/mock.module that leaks
    // process-wide) reproduces the no-model degradation contract with zero
    // network and zero cross-file leakage.
    const { EmbeddingService } = await import('@/core/rag/embeddings');
    const embeddings = new EmbeddingService('test-model');
    spyOn(embeddings, 'generateEmbedding').mockRejectedValue(
      new Error('No embedding model configured (test) — re-index degrades to indexed:false'),
    );
    const mod = await import('./notes');
    svc = new mod.NoteService(undefined, undefined, embeddings);
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

  test('save creates a note, derives slug, and wires wikilinks + tags', async () => {
    const r = await svc.save({
      userId,
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
    const r = await svc.save({ userId, title: 'No Model', body: 'body text' });
    expect(r.created).toBe(true);
    expect(r.indexed).toBe(false);
    expect(await svc.getById(userId, r.note.id)).not.toBeNull();
  });

  test('unchanged body on re-save is a no-op for links', async () => {
    const first = await svc.save({ userId, title: 'Stable', body: 'has [[a]] link' });
    expect(first.links.added).toBe(1);
    const second = await svc.save({ userId, id: first.note.id, title: 'Stable', body: 'has [[a]] link' });
    expect(second.links).toEqual({ added: 0, removed: 0 });
  });

  test('editing the body diffs the links (add + remove)', async () => {
    const first = await svc.save({ userId, title: 'Edited', body: '[[a]] [[b]]' });
    expect(first.links.added).toBe(2);
    const second = await svc.save({ userId, id: first.note.id, title: 'Edited', body: '[[a]] [[c]]' });
    expect(second.links.added).toBe(1);
    expect(second.links.removed).toBe(1);
    const refs = (await links.getOutgoing(userId, 'note', first.note.id)).map((e) => e.toRef).sort();
    expect(refs).toEqual(['a', 'c']);
  });

  test('creating a note resolves ghost edges that referenced its slug', async () => {
    // Note B references a not-yet-existing [[Target]].
    const b = await svc.save({ userId, title: 'B', body: 'see [[Target]]' });
    const ghost = (await links.getOutgoing(userId, 'note', b.note.id))[0];
    expect(ghost.toId).toBeNull();

    // Create Target — the ghost edge should now resolve to it.
    const target = await svc.save({ userId, title: 'Target' });
    const resolved = (await links.getOutgoing(userId, 'note', b.note.id))[0];
    expect(resolved.toId).toBe(target.note.id);
    expect(resolved.toType).toBe('note');
  });

  test('linking to an ALREADY-EXISTING note resolves the edge immediately (graph line shows)', async () => {
    // The QA bug: B exists first, then A links to it. The A→B edge used to
    // stay a ghost (to_id NULL) until B was next saved, so the graph (which
    // only draws resolved edges) showed no connection.
    const target = await svc.save({ userId, title: 'Existing Target' });
    const a = await svc.save({ userId, title: 'A', body: 'see [[Existing Target]]' });
    const edge = (await links.getOutgoing(userId, 'note', a.note.id)).find((e) => e.linkType === 'references');
    expect(edge?.toId).toBe(target.note.id);
    expect(edge?.toType).toBe('note');
  });

  test('getOrCreateDaily is idempotent and stamps the date', async () => {
    const d1 = await svc.getOrCreateDaily(userId, null, '2026-06-09T12:00:00Z');
    expect(d1.slug).toBe('daily/2026-06-09');
    expect(d1.noteKind).toBe('daily');
    expect(d1.noteDate).toBe('2026-06-09');
    const d2 = await svc.getOrCreateDaily(userId, null, '2026-06-09');
    expect(d2.id).toBe(d1.id);
  });

  test('capture appends a timestamped bullet to the daily note', async () => {
    const note = await svc.capture(userId, null, 'remember the [[milk]]', '2026-06-09');
    expect(note.body).toContain('remember the [[milk]]');
    expect(note.noteKind).toBe('daily');
    // The captured wikilink is wired.
    const refs = (await links.getOutgoing(userId, 'note', note.id)).map((e) => e.toRef);
    expect(refs).toContain('milk');
  });

  test('remove cleans up edges and deletes the row', async () => {
    const n = await svc.save({ userId, title: 'Doomed', body: '[[x]]' });
    expect((await links.getOutgoing(userId, 'note', n.note.id))).toHaveLength(1);
    const removed = await svc.remove(userId, n.note.id);
    expect(removed).toBe(true);
    expect(await svc.getById(userId, n.note.id)).toBeNull();
    expect(await links.getOutgoing(userId, 'note', n.note.id)).toHaveLength(0);
  });

  test('notes are tenant-scoped', async () => {
    const other = randomUUID();
    const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
    await seedUsers([{ id: other, username: 'notes-other' }]);
    const n = await svc.save({ userId, title: 'Mine', body: 'x' });
    expect(await svc.getById(other, n.note.id)).toBeNull();
    expect(await svc.list(other)).toHaveLength(0);
  });
});
