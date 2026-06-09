import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KnowledgeLinkRepository } from './knowledge-link-repository';

/**
 * Runs against embedded PGlite (no Docker) — the same bootstrap the
 * `*.isolation.test.ts` files use. Exercises the polymorphic edge CRUD,
 * wikilink sync, ghost-node resolution, and referential cleanup.
 */
describe('KnowledgeLinkRepository', () => {
  let repo: KnowledgeLinkRepository;
  const userId = randomUUID();
  const otherUserId = randomUUID();

  beforeAll(async () => {
    process.env.STORAGE_MODE = 'embedded';
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-klink-'));
    const { initializeDb } = await import('@/db/postgres');
    await initializeDb();
    const { runMigrations } = await import('@/db/migrate');
    await runMigrations();
    const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
    await seedUsers([
      { id: userId, username: 'kl-user' },
      { id: otherUserId, username: 'kl-other' },
    ]);
    const mod = await import('./knowledge-link-repository');
    repo = new mod.KnowledgeLinkRepository();
  });

  afterAll(async () => {
    const { closeDb } = await import('@/db/postgres');
    await closeDb();
  });

  beforeEach(async () => {
    const { executeRaw } = await import('@/db/postgres');
    await executeRaw('TRUNCATE TABLE knowledge_links');
  });

  test('create inserts an explicit edge', async () => {
    const fromId = randomUUID();
    const toId = randomUUID();
    const link = await repo.create({
      userId,
      fromType: 'note',
      fromId,
      toType: 'document',
      toId,
      toRef: 'spec',
      linkType: 'references',
      origin: 'user',
    });
    expect(link.id).toBeDefined();
    expect(link.origin).toBe('user');
    const out = await repo.getOutgoing('note', fromId);
    expect(out).toHaveLength(1);
    expect(out[0].toId).toBe(toId);
  });

  test('create dedups on the authored target and refreshes label/origin', async () => {
    const fromId = randomUUID();
    await repo.create({
      userId, fromType: 'note', fromId, toRef: 'plan', linkType: 'references',
      origin: 'wikilink', label: 'old',
    });
    const second = await repo.create({
      userId, fromType: 'note', fromId, toRef: 'plan', linkType: 'references',
      origin: 'user', label: 'new',
    });
    const out = await repo.getOutgoing('note', fromId);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(second.id);
    expect(out[0].label).toBe('new');
    expect(out[0].origin).toBe('user');
  });

  test('getBacklinks returns resolved inbound edges; getBacklinksByRef catches ghosts', async () => {
    const targetId = randomUUID();
    await repo.create({
      userId, fromType: 'note', fromId: randomUUID(),
      toType: 'note', toId: targetId, toRef: 'target', linkType: 'references', origin: 'user',
    });
    // Ghost edge to the same ref (unresolved).
    await repo.create({
      userId, fromType: 'note', fromId: randomUUID(),
      toRef: 'target', linkType: 'references', origin: 'wikilink',
    });
    expect(await repo.getBacklinks('note', targetId)).toHaveLength(1);
    expect(await repo.getBacklinksByRef(userId, 'target')).toHaveLength(2);
  });

  test('syncWikilinks adds new edges, removes dropped ones, is idempotent', async () => {
    const fromId = randomUUID();
    const base = {
      userId, fromType: 'note', fromId,
      wikilinks: [
        { target: 'A', ref: 'a' },
        { target: 'B', ref: 'b', alias: 'bee' },
      ],
      tags: ['important'],
    };
    const first = await repo.syncWikilinks(base);
    expect(first.added).toBe(3);
    expect(first.removed).toBe(0);

    // Same body — no churn.
    const again = await repo.syncWikilinks(base);
    expect(again.added).toBe(0);
    expect(again.removed).toBe(0);

    // Drop B and the tag, add C.
    const changed = await repo.syncWikilinks({
      ...base,
      wikilinks: [{ target: 'A', ref: 'a' }, { target: 'C', ref: 'c' }],
      tags: [],
    });
    expect(changed.added).toBe(1);
    expect(changed.removed).toBe(2);

    const out = await repo.getOutgoing('note', fromId);
    expect(out.map((e) => e.toRef).sort()).toEqual(['a', 'c']);
  });

  test('resolveTo binds ghost reference edges but never tag edges', async () => {
    const fromId = randomUUID();
    await repo.syncWikilinks({
      userId, fromType: 'note', fromId,
      wikilinks: [{ target: 'Target Note', ref: 'target-note' }],
      tags: ['target-note'], // same ref as the wikilink, but a tag
    });
    const noteId = randomUUID();
    const resolved = await repo.resolveTo({ userId, toRef: 'target-note', toType: 'note', toId: noteId });
    expect(resolved).toBe(1); // only the reference edge, not the tag edge

    const out = await repo.getOutgoing('note', fromId);
    const ref = out.find((e) => e.linkType === 'references');
    const tag = out.find((e) => e.linkType === 'tagged');
    expect(ref?.toId).toBe(noteId);
    expect(tag?.toId).toBeNull();
  });

  test('deleteForEntity drops outbound and reverts inbound to ghost', async () => {
    const entityId = randomUUID();
    // entity as source (outbound)
    await repo.create({
      userId, fromType: 'note', fromId: entityId,
      toType: 'note', toId: randomUUID(), toRef: 'x', linkType: 'references', origin: 'user',
    });
    // entity as target (inbound)
    const sourceId = randomUUID();
    await repo.create({
      userId, fromType: 'note', fromId: sourceId,
      toType: 'note', toId: entityId, toRef: 'the-entity', linkType: 'references', origin: 'user',
    });

    const { dropped, unbound } = await repo.deleteForEntity('note', entityId);
    expect(dropped).toBe(1);
    expect(unbound).toBe(1);

    // Outbound gone, inbound reverted to ghost (still present, to_id null).
    expect(await repo.getOutgoing('note', entityId)).toHaveLength(0);
    const inbound = await repo.getOutgoing('note', sourceId);
    expect(inbound).toHaveLength(1);
    expect(inbound[0].toId).toBeNull();
  });

  test('outgoingForIds / backlinksForIds batch the BFS step', async () => {
    const a = randomUUID();
    const b = randomUUID();
    const target = randomUUID();
    await repo.create({ userId, fromType: 'note', fromId: a, toType: 'note', toId: target, toRef: 't', linkType: 'references', origin: 'user' });
    await repo.create({ userId, fromType: 'note', fromId: b, toType: 'note', toId: target, toRef: 't', linkType: 'references', origin: 'user' });

    expect(await repo.outgoingForIds('note', [a, b])).toHaveLength(2);
    expect(await repo.backlinksForIds('note', [target])).toHaveLength(2);
    expect(await repo.outgoingForIds('note', [])).toHaveLength(0);
  });

  test('reapUnacceptedSuggestions only drops old suggestion edges', async () => {
    const { executeRaw } = await import('@/db/postgres');
    await repo.create({ userId, fromType: 'note', fromId: randomUUID(), toRef: 's1', linkType: 'references', origin: 'suggestion', confidence: 0.8 });
    const keep = await repo.create({ userId, fromType: 'note', fromId: randomUUID(), toRef: 's2', linkType: 'references', origin: 'user' });
    await executeRaw(`UPDATE knowledge_links SET created_at = now() - interval '60 days' WHERE origin = 'suggestion'`);
    const removed = await repo.reapUnacceptedSuggestions(new Date(Date.now() - 30 * 86400000));
    expect(removed).toBe(1);
    expect(await repo.getById(keep.id)).not.toBeNull();
  });

  test('edges are scoped per user', async () => {
    const fromId = randomUUID();
    await repo.create({ userId, fromType: 'note', fromId, toRef: 'shared', linkType: 'references', origin: 'user' });
    // Same authored coordinates under a different user must be a distinct row.
    await repo.create({ userId: otherUserId, fromType: 'note', fromId, toRef: 'shared', linkType: 'references', origin: 'user' });
    expect(await repo.getBacklinksByRef(userId, 'shared')).toHaveLength(1);
    expect(await repo.getBacklinksByRef(otherUserId, 'shared')).toHaveLength(1);
  });
});
