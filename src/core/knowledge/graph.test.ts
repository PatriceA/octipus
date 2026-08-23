import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { entityRefFromSourceId, type KnowledgeGraph } from './graph';
import type { KnowledgeLinkRepository } from '@/db/repositories/knowledge-link-repository';

describe('entityRefFromSourceId', () => {
  test('parses the <type>:<uuid> convention', () => {
    const id = randomUUID();
    expect(entityRefFromSourceId(`note:${id}`)).toEqual({ type: 'note', id });
    expect(entityRefFromSourceId(`document:${id}`)).toEqual({ type: 'document', id });
  });

  test('returns null for legacy/non-entity source ids', () => {
    expect(entityRefFromSourceId('/path/to/file.md')).toBeNull();
    expect(entityRefFromSourceId('note:not-a-uuid')).toBeNull();
    expect(entityRefFromSourceId('skill:abc')).toBeNull();
  });
});

describe('KnowledgeGraph.traverse', () => {
  let graph: KnowledgeGraph;
  let repo: KnowledgeLinkRepository;
  const userId = randomUUID();

  // Build a small graph:  A -> B -> C ,  A -> D ,  E -> A (backlink)
  const A = randomUUID();
  const B = randomUUID();
  const C = randomUUID();
  const D = randomUUID();
  const E = randomUUID();

  beforeAll(async () => {
    process.env.STORAGE_MODE = 'embedded';
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-graph-'));
    const { initializeDb } = await import('@/db/postgres');
    await initializeDb();
    const { runMigrations } = await import('@/db/migrate');
    await runMigrations();
    const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
    await seedUsers([{ id: userId, username: 'graph-user' }]);
    const linksMod = await import('@/db/repositories/knowledge-link-repository');
    repo = new linksMod.KnowledgeLinkRepository();
    const graphMod = await import('./graph');
    graph = new graphMod.KnowledgeGraph(repo);
  });

  afterAll(async () => {
    const { closeDb } = await import('@/db/postgres');
    await closeDb();
  });

  beforeEach(async () => {
    const { executeRaw } = await import('@/db/postgres');
    await executeRaw('TRUNCATE TABLE knowledge_links');
    const edge = (from: string, to: string, linkType = 'references') =>
      repo.create({ userId, fromType: 'note', fromId: from, toType: 'note', toId: to, toRef: to, linkType, origin: 'user' });
    await edge(A, B);
    await edge(B, C);
    await edge(A, D, 'child_of');
    await edge(E, A);
  });

  test('1-hop outgoing finds direct neighbours only', async () => {
    const r = await graph.traverse(userId, [{ type: 'note', id: A }], { hops: 1, direction: 'out' });
    expect(r.nodes.map((n) => n.id).sort()).toEqual([B, D].sort());
    expect(r.nodes.every((n) => n.depth === 1)).toBe(true);
  });

  test('2-hop outgoing reaches transitive neighbours with increasing depth', async () => {
    const r = await graph.traverse(userId, [{ type: 'note', id: A }], { hops: 2, direction: 'out' });
    const byId = new Map(r.nodes.map((n) => [n.id, n.depth]));
    expect(byId.get(B)).toBe(1);
    expect(byId.get(D)).toBe(1);
    expect(byId.get(C)).toBe(2);
  });

  test('direction=in follows backlinks', async () => {
    const r = await graph.traverse(userId, [{ type: 'note', id: A }], { hops: 1, direction: 'in' });
    expect(r.nodes.map((n) => n.id)).toEqual([E]);
    expect(r.nodes[0].viaDirection).toBe('in');
  });

  test('direction=both follows edges either way', async () => {
    const r = await graph.traverse(userId, [{ type: 'note', id: A }], { hops: 1, direction: 'both' });
    expect(r.nodes.map((n) => n.id).sort()).toEqual([B, D, E].sort());
  });

  test('linkTypes filter restricts traversal', async () => {
    const r = await graph.traverse(userId, [{ type: 'note', id: A }], { hops: 1, direction: 'out', linkTypes: ['child_of'] });
    expect(r.nodes.map((n) => n.id)).toEqual([D]);
  });

  test('does not traverse ghost (unresolved) edges', async () => {
    const F = randomUUID();
    await repo.create({ userId, fromType: 'note', fromId: F, toRef: 'nowhere', linkType: 'references', origin: 'wikilink' });
    const r = await graph.traverse(userId, [{ type: 'note', id: F }], { hops: 2, direction: 'out' });
    expect(r.nodes).toHaveLength(0);
  });

  test('seed nodes are excluded and cycles terminate', async () => {
    // Add a cycle C -> A.
    await repo.create({ userId, fromType: 'note', fromId: C, toType: 'note', toId: A, toRef: A, linkType: 'references', origin: 'user' });
    const r = await graph.traverse(userId, [{ type: 'note', id: A }], { hops: 5, direction: 'out' });
    // Reaches B, C, D — but not A again (seed, already visited).
    expect(r.nodes.map((n) => n.id).sort()).toEqual([B, C, D].sort());
  });

  test('throws when traversal exceeds maxNodes (fail loud)', async () => {
    await expect(
      graph.traverse(userId, [{ type: 'note', id: A }], { hops: 2, direction: 'both', maxNodes: 1 }),
    ).rejects.toThrow(/exceeded maxNodes/);
  });

  test('traversal is tenant-scoped — another user reaches nothing', async () => {
    const intruder = randomUUID();
    const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
    await seedUsers([{ id: intruder, username: 'intruder' }]);
    // intruder traverses from A (which belongs to `userId`) → no edges visible.
    const r = await graph.traverse(intruder, [{ type: 'note', id: A }], { hops: 3, direction: 'both' });
    expect(r.nodes).toHaveLength(0);
  });
});
