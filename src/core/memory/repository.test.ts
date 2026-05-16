import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { memories } from '@/db/schema/memories';
import { workspaces } from '@/db/schema/organizations';
import { users } from '@/db/schema/users';
import {
  isIntegration,
  setupIntegrationDb,
  teardownIntegration,
  truncateTables,
} from '@/test-helpers/integration';
import { MemoryRepository } from './repository';

/**
 * Memory repository — DB-touching tests. The pure parsers
 * (extractor, judge, retrieval rendering) live in extractor.test.ts.
 * These tests exercise the CRUD + supersession + LFU paths that
 * actually hit Postgres.
 */
describe.skipIf(!isIntegration)('MemoryRepository (Integration)', () => {
  let repo: MemoryRepository;
  let userId: string;
  let otherUserId: string;
  let workspaceId: string;

  // 8-dim "embedding" — keeps tests cheap. pgvector accepts any
  // dimension since migration 0047.
  const VEC = (seed: number): number[] =>
    [seed, seed + 0.1, seed + 0.2, seed + 0.3, seed + 0.4, seed + 0.5, seed + 0.6, seed + 0.7];

  beforeAll(async () => {
    await setupIntegrationDb();
    repo = new MemoryRepository();
  });

  afterAll(async () => {
    await teardownIntegration();
  });

  beforeEach(async () => {
    await truncateTables(['memories', 'workspaces', 'users']);
    const db = getDb();
    const u = await db.insert(users).values({ username: `u_${randomUUID().slice(0, 8)}` }).returning();
    userId = u[0].id;
    const u2 = await db.insert(users).values({ username: `u_${randomUUID().slice(0, 8)}` }).returning();
    otherUserId = u2[0].id;
    const w = await db.insert(workspaces).values({ userId, slug: 'default', name: 'Default' }).returning();
    workspaceId = w[0].id;
  });

  test('addNew persists a row with defaults', async () => {
    const row = await repo.addNew({
      userId,
      workspaceId,
      agentScope: null,
      factType: 'preference',
      content: 'User prefers tabs',
      embedding: VEC(0.1),
      embeddingVersion: 'test-model/8',
      sourceMessageId: null,
      confidence: 1.0,
    });
    expect(row.content).toBe('User prefers tabs');
    expect(row.supersededBy).toBeNull();
    expect(row.accessCount).toBe(0);
    expect(row.validUntil).toBeNull();
  });

  test('supersede atomically inserts new and links old', async () => {
    const old = await repo.addNew({
      userId,
      workspaceId,
      agentScope: null,
      factType: 'preference',
      content: 'User prefers tabs',
      embedding: VEC(0.1),
      embeddingVersion: 'test-model/8',
      sourceMessageId: null,
      confidence: 0.9,
    });
    const fresh = await repo.supersede(old.id, {
      userId,
      workspaceId,
      agentScope: null,
      factType: 'preference',
      content: 'User prefers spaces',
      embedding: VEC(0.2),
      embeddingVersion: 'test-model/8',
      sourceMessageId: null,
      confidence: 1.0,
    });
    expect(fresh.supersededBy).toBeNull();

    // Old row points at the new row.
    const linked = await repo.getById(old.id);
    expect(linked?.supersededBy).toBe(fresh.id);

    // Active retrieval surfaces only the fresh fact.
    const active = await repo.retrieveTop({ userId });
    expect(active.length).toBe(1);
    expect(active[0].id).toBe(fresh.id);
  });

  test('softDelete sets valid_until so retrieval drops the row', async () => {
    const row = await repo.addNew({
      userId,
      workspaceId,
      agentScope: null,
      factType: 'profile',
      content: 'User works at Acme',
      embedding: VEC(0.3),
      embeddingVersion: 'test-model/8',
      sourceMessageId: null,
      confidence: 1.0,
    });
    await repo.softDelete(row.id);
    const still = await repo.getById(row.id);
    expect(still?.validUntil).not.toBeNull();

    const active = await repo.retrieveTop({ userId });
    expect(active.length).toBe(0);
  });

  test('searchSimilar respects user isolation', async () => {
    await repo.addNew({
      userId,
      workspaceId,
      agentScope: null,
      factType: 'preference',
      content: 'mine',
      embedding: VEC(0.5),
      embeddingVersion: 'test-model/8',
      sourceMessageId: null,
      confidence: 1.0,
    });
    await repo.addNew({
      userId: otherUserId,
      workspaceId: null,
      agentScope: null,
      factType: 'preference',
      content: 'theirs',
      embedding: VEC(0.5),
      embeddingVersion: 'test-model/8',
      sourceMessageId: null,
      confidence: 1.0,
    });
    const hits = await repo.searchSimilar(VEC(0.5), { userId, factType: 'preference' });
    expect(hits.length).toBe(1);
    expect(hits[0].content).toBe('mine');
  });

  test('searchSimilar OR(NULL, scope) filter includes both global and role-scoped', async () => {
    await repo.addNew({
      userId,
      workspaceId,
      agentScope: null,
      factType: 'preference',
      content: 'global',
      embedding: VEC(0.5),
      embeddingVersion: 'test-model/8',
      sourceMessageId: null,
      confidence: 1.0,
    });
    await repo.addNew({
      userId,
      workspaceId,
      agentScope: 'coding',
      factType: 'preference',
      content: 'coding-scoped',
      embedding: VEC(0.51),
      embeddingVersion: 'test-model/8',
      sourceMessageId: null,
      confidence: 1.0,
    });
    await repo.addNew({
      userId,
      workspaceId,
      agentScope: 'finance',
      factType: 'preference',
      content: 'finance-scoped',
      embedding: VEC(0.5),
      embeddingVersion: 'test-model/8',
      sourceMessageId: null,
      confidence: 1.0,
    });

    // Coding scope → sees global + coding, NOT finance.
    const hits = await repo.searchSimilar(VEC(0.5), {
      userId,
      agentScope: 'coding',
      factType: 'preference',
      limit: 10,
    });
    const contents = hits.map((h) => h.content).sort();
    expect(contents).toEqual(['coding-scoped', 'global']);
  });

  test('retrieveTop orders by access_count desc then updated_at desc', async () => {
    const a = await repo.addNew({
      userId, workspaceId, agentScope: null, factType: 'preference',
      content: 'A', embedding: VEC(0.1), embeddingVersion: 'test/8', sourceMessageId: null, confidence: 1,
    });
    await repo.addNew({
      userId, workspaceId, agentScope: null, factType: 'preference',
      content: 'B', embedding: VEC(0.2), embeddingVersion: 'test/8', sourceMessageId: null, confidence: 1,
    });
    // Bump A's counter so it wins on access_count.
    repo.recordAccess([a.id]);
    // recordAccess is fire-and-forget; settle.
    await new Promise((r) => setTimeout(r, 50));

    const top = await repo.retrieveTop({ userId });
    expect(top[0].content).toBe('A');
  });

  test('searchSimilar rejects non-finite vector elements (fail-loud)', async () => {
    await expect(
      repo.searchSimilar([1, NaN, 0.3], { userId, factType: 'preference' }),
    ).rejects.toThrow(/finite number/);
  });

  test('searchSimilar empty vector returns []', async () => {
    const result = await repo.searchSimilar([], { userId, factType: 'preference' });
    expect(result).toEqual([]);
  });

  test('supersession chain leaves only the newest row active', async () => {
    const v1 = await repo.addNew({
      userId, workspaceId, agentScope: null, factType: 'profile',
      content: 'v1', embedding: VEC(0.1), embeddingVersion: 'test/8', sourceMessageId: null, confidence: 1,
    });
    const v2 = await repo.supersede(v1.id, {
      userId, workspaceId, agentScope: null, factType: 'profile',
      content: 'v2', embedding: VEC(0.2), embeddingVersion: 'test/8', sourceMessageId: null, confidence: 1,
    });
    const v3 = await repo.supersede(v2.id, {
      userId, workspaceId, agentScope: null, factType: 'profile',
      content: 'v3', embedding: VEC(0.3), embeddingVersion: 'test/8', sourceMessageId: null, confidence: 1,
    });
    const active = await repo.retrieveTop({ userId });
    expect(active.length).toBe(1);
    expect(active[0].id).toBe(v3.id);

    // Audit trail intact: all three rows exist in the table.
    const db = getDb();
    const all = await db.select().from(memories).where(eq(memories.userId, userId));
    expect(all.length).toBe(3);
  });
});
