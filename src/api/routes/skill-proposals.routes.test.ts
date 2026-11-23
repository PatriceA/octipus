/**
 * `/api/skills/proposals` over Elysia against embedded PGlite: the served
 * view (no embedding, `candidateCount`, `?include=candidates`), bulk reject,
 * manual merge, surface and consolidate, each scoped to the caller — Bob
 * cannot touch Alice's proposals, and consolidate never runs install-wide,
 * not even for an admin (docs/plans/self-learning-consolidation.md, "API").
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { Elysia } from '@/api/http';

type ElysiaLike = { handle: (req: Request) => Promise<Response> };

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const aliceId = 'aaaaaaaa-1111-4111-8111-111111111111';
const bobId = 'bbbbbbbb-2222-4222-8222-222222222222';
const adminId = 'cccccccc-3333-4333-8333-333333333333';

const apps: Record<string, ElysiaLike> = {};
let embeddingsModule: typeof import('@/core/rag/embeddings');
let registryModule: typeof import('@/models/model-registry');
let clientModule: typeof import('@/models/litellm-client');
const complete = vi.fn();
const reply = (verdict: 'merged' | 'unchanged' | 'distinct') =>
  ({ content: JSON.stringify({ verdict, description: '', content: '' }), finishReason: 'stop' });

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-skill-proposal-routes-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([
    { id: aliceId, username: 'alice' },
    { id: bobId, username: 'bob' },
    { id: adminId, username: 'root', isAdmin: true },
  ]);
  embeddingsModule = await import('@/core/rag/embeddings');
  registryModule = await import('@/models/model-registry');
  clientModule = await import('@/models/litellm-client');

  const { skillProposalRoutes } = await import('./skill-proposals');
  const { principalFromUser } = await import('@/security/principal');
  for (const [id, username, isAdmin] of [[aliceId, 'alice', false], [bobId, 'bob', false], [adminId, 'root', true]] as const) {
    apps[id] = new Elysia()
      .derive(() => {
        const user = { id, username, isAdmin };
        return { user, session: null, principal: principalFromUser(user) };
      })
      .group('/api', (a) => a.use(skillProposalRoutes)) as unknown as ElysiaLike;
  }
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

beforeEach(async () => {
  const { getDb } = await import('@/db/postgres');
  const { skillProposals } = await import('@/db/schema/skill-proposals');
  await getDb().delete(skillProposals);
  complete.mockReset();
  complete.mockResolvedValue(reply('unchanged'));
  vi.spyOn(embeddingsModule, 'getEmbeddingService').mockReturnValue({
    generateEmbedding: async () => [1, 0.9, 0.1, 0],
  } as never);
  vi.spyOn(registryModule, 'getModelRegistry').mockReturnValue({
    getModelForTopic: async (topic: string) => (topic === 'background' ? { modelId: 'test-background', name: 'background-test' } : null),
  } as never);
  vi.spyOn(clientModule, 'getLiteLLMClient').mockReturnValue({ complete } as never);
});

afterEach(() => { vi.restoreAllMocks(); });

let seq = 0;
async function seed(fields: Record<string, unknown> & { name: string; userId: string }): Promise<string> {
  const { getDb } = await import('@/db/postgres');
  const { skillProposals } = await import('@/db/schema/skill-proposals');
  seq++;
  const [row] = await getDb().insert(skillProposals).values({
    fingerprint: randomUUID(),
    description: `${fields.name} description`,
    draftPromptTemplate: `${fields.name} steps`,
    kind: 'skill',
    status: 'pending',
    exemplarCount: 1,
    sourceRefs: [`session:s${seq}`],
    lastExemplarAt: new Date(),
    createdAt: new Date(Date.now() - 1000 * 60 * (1000 - seq)),
    ...fields,
  }).returning();
  return row.id;
}

async function read(id: string) {
  const { eq } = await import('drizzle-orm');
  const { getDb } = await import('@/db/postgres');
  const { skillProposals } = await import('@/db/schema/skill-proposals');
  const [row] = await getDb().select().from(skillProposals).where(eq(skillProposals.id, id));
  return row;
}

async function call(as: string, method: 'GET' | 'POST', path: string, body?: unknown) {
  const res = await apps[as].handle(new Request(`http://localhost/api/skills/proposals${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  }));
  const text = await res.text();
  return { status: res.status, text, body: text ? JSON.parse(text) : null };
}

describe('GET /api/skills/proposals', () => {
  test('pending only by default, sorted, with candidateCount; ?include=candidates adds candidates; never the embedding', async () => {
    const plain = await seed({ name: 'plain', userId: aliceId, embedding: [1, 0, 0, 0] });
    const busy = await seed({ name: 'busy', userId: aliceId, exemplarCount: 3, signal: 'correction' });
    const candidate = await seed({ name: 'waiting', userId: aliceId, status: 'candidate', embedding: [0, 1, 0, 0] });
    await seed({ name: 'bobs', userId: bobId });

    const list = await call(aliceId, 'GET', '/');
    expect(list.status).toBe(200);
    expect(list.body.candidateCount).toBe(1);
    expect(list.body.proposals.map((p: { id: string }) => p.id)).toEqual([busy, plain]);
    expect(list.body.proposals[0]).toMatchObject({
      name: 'busy', status: 'pending', exemplarCount: 3, sessionCount: 1, signal: 'correction',
      sourceRefs: [expect.stringMatching(/^session:/)], previousDraft: null, mergedIntoId: null, similarSkill: null,
    });
    expect(list.text).not.toContain('"embedding"');
    expect(list.text).not.toContain('rejectedUntil');

    const all = await call(aliceId, 'GET', '/?include=candidates');
    expect(all.body.proposals.map((p: { id: string }) => p.id)).toEqual([busy, plain, candidate]);
    expect(all.body.proposals[2].status).toBe('candidate');
    expect(all.text).not.toContain('"embedding"');

    expect((await call(aliceId, 'GET', '/?include=everything')).status).toBeGreaterThanOrEqual(400);
  });
});

describe('POST /api/skills/proposals/bulk-reject', () => {
  test('rejects the caller\'s own and reports another user\'s as not found', async () => {
    const a = await seed({ name: 'a', userId: aliceId });
    const b = await seed({ name: 'b', userId: aliceId, status: 'candidate' });
    const bobs = await seed({ name: 'bobs', userId: bobId });

    const res = await call(bobId, 'POST', '/bulk-reject', { ids: [a, bobs] });
    expect(res).toMatchObject({ status: 200, body: { rejected: [bobs], notFound: [a] } });
    expect((await read(a)).status).toBe('pending');

    expect((await call(aliceId, 'POST', '/bulk-reject', { ids: [a, b] })).body).toEqual({ rejected: [a, b], notFound: [] });
  });

  test('validates the body: 1 to 100 ids', async () => {
    expect((await call(aliceId, 'POST', '/bulk-reject', { ids: [] })).status).toBe(422);
    expect((await call(aliceId, 'POST', '/bulk-reject', { ids: Array.from({ length: 101 }, () => randomUUID()) })).status).toBe(422);
    expect((await call(aliceId, 'POST', '/bulk-reject', {})).status).toBe(422);
  });
});

describe('POST /api/skills/proposals/:id/merge', () => {
  test('merges the caller\'s proposals and serves the target as a view', async () => {
    const into = await seed({ name: 'into', userId: aliceId, exemplarCount: 2 });
    const from = await seed({ name: 'from', userId: aliceId });
    const res = await call(aliceId, 'POST', `/${from}/merge`, { intoId: into });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ merged: true, verdict: 'unchanged', mergeDegraded: false, proposal: { id: into, exemplarCount: 3, sessionCount: 2 } });
    expect(res.text).not.toContain('"embedding"');
    expect(await read(from)).toMatchObject({ status: 'merged', mergedIntoId: into });
  });

  test('404 for another user\'s proposal, 409 when not open, 400 into itself', async () => {
    const alices = await seed({ name: 'alices', userId: aliceId });
    const alicesOther = await seed({ name: 'alices-other', userId: aliceId });
    const bobs = await seed({ name: 'bobs', userId: bobId });
    const rejected = await seed({ name: 'gone', userId: aliceId, status: 'rejected' });

    expect((await call(bobId, 'POST', `/${alices}/merge`, { intoId: alicesOther })).status).toBe(404);
    expect((await call(bobId, 'POST', `/${bobs}/merge`, { intoId: alices })).status).toBe(404);
    expect((await call(aliceId, 'POST', `/${alices}/merge`, { intoId: rejected })).body).toMatchObject({ code: 'not_open' });
    expect((await call(aliceId, 'POST', `/${alices}/merge`, { intoId: rejected })).status).toBe(409);
    expect((await call(aliceId, 'POST', `/${alices}/merge`, { intoId: alices })).status).toBe(400);
    expect((await call(adminId, 'POST', `/${alices}/merge`, { intoId: bobs })).body).toMatchObject({ code: 'owner' });
    expect((await call(aliceId, 'POST', `/${alices}/merge`, {})).status).toBe(422);
    expect((await read(alices)).status).toBe('pending');
    expect(complete).not.toHaveBeenCalled();
  });
});

describe('POST /api/skills/proposals/:id/surface', () => {
  test('surfaces the caller\'s candidate; another user\'s is 404', async () => {
    const candidate = await seed({ name: 'waiting', userId: aliceId, status: 'candidate' });
    expect((await call(bobId, 'POST', `/${candidate}/surface`)).status).toBe(404);
    const res = await call(aliceId, 'POST', `/${candidate}/surface`);
    expect(res).toMatchObject({ status: 200, body: { surfaced: true, proposal: { id: candidate, status: 'pending' } } });
    expect(typeof res.body.proposal.surfacedAt).toBe('string');
    expect(res.text).not.toContain('"embedding"');
    expect((await call(aliceId, 'POST', `/${candidate}/surface`)).status).toBe(404);
  });
});

describe('approve and reject', () => {
  test('a candidate can be approved and rejected by its owner only', async () => {
    const one = await seed({ name: 'one', userId: aliceId, status: 'candidate' });
    const two = await seed({ name: 'two', userId: aliceId, status: 'candidate' });
    expect((await call(bobId, 'POST', `/${one}/approve`)).status).toBe(404);
    expect((await call(bobId, 'POST', `/${two}/reject`)).status).toBe(404);
    expect((await call(aliceId, 'POST', `/${one}/approve`)).body).toMatchObject({ promoted: true, name: 'one' });
    expect((await call(aliceId, 'POST', `/${two}/reject`)).body).toMatchObject({ rejected: true });
  });
});

describe('POST /api/skills/proposals/consolidate', () => {
  test('consolidates the caller\'s proposals only, admins included', async () => {
    const a1 = await seed({ name: 'token-rotation', userId: aliceId });
    const a2 = await seed({ name: 'rotate-credentials', userId: aliceId });
    const b1 = await seed({ name: 'token-rotation', userId: bobId });
    const b2 = await seed({ name: 'rotate-credentials', userId: bobId });

    const admin = await call(adminId, 'POST', '/consolidate');
    expect(admin).toMatchObject({ status: 200, body: { merged: 0, expired: 0, promoted: 0, degraded: 0, notesMerged: 0, notesArchived: 0 } });
    expect([(await read(a1)).status, (await read(a2)).status]).toEqual(['pending', 'pending']);

    const bob = await call(bobId, 'POST', '/consolidate');
    expect(bob.body).toMatchObject({ merged: 1, expired: 0, degraded: 0 });
    expect(typeof bob.body.embedded).toBe('number');
    expect([(await read(b1)).status, (await read(b2)).status].sort()).toEqual(['merged', 'pending']);
    expect([(await read(a1)).status, (await read(a2)).status]).toEqual(['pending', 'pending']);
  });
});
