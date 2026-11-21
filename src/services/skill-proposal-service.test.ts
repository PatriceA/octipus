/**
 * The proposal service against embedded PGlite: approve and reject take
 * candidates too, rejecting a target rejects what was merged into it, bulk
 * reject is scoped to the owner, the manual merge refuses what it cannot do,
 * a candidate can be surfaced by hand, and the served view
 * (docs/plans/self-learning-consolidation.md, "API"). The merge model is stubbed.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

const userId = '77777777-7777-4777-8777-777777777777';
const otherId = '88888888-8888-4888-8888-888888888888';

let registryModule: typeof import('@/models/model-registry');
let clientModule: typeof import('@/models/litellm-client');
let service: typeof import('./skill-proposal-service');
const complete = vi.fn();
const reply = (verdict: 'merged' | 'unchanged' | 'distinct', description = '', content = '') =>
  ({ content: JSON.stringify({ verdict, description, content }), finishReason: 'stop' });

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-skill-proposal-service-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: userId, username: 'svc-owner' }, { id: otherId, username: 'svc-other' }]);
  registryModule = await import('@/models/model-registry');
  clientModule = await import('@/models/litellm-client');
  service = await import('./skill-proposal-service');
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

beforeEach(async () => {
  const { getDb } = await import('@/db/postgres');
  const { skillProposals } = await import('@/db/schema/skill-proposals');
  const { skills } = await import('@/db/schema/skills');
  await getDb().delete(skillProposals);
  await getDb().delete(skills);
  complete.mockReset();
  vi.spyOn(registryModule, 'getModelRegistry').mockReturnValue({
    getModelForTopic: async (topic: string) => (topic === 'background' ? { modelId: 'test-background', name: 'background-test' } : null),
  } as never);
  vi.spyOn(clientModule, 'getLiteLLMClient').mockReturnValue({ complete } as never);
});

afterEach(() => { vi.restoreAllMocks(); });

let seq = 0;
async function seed(fields: Record<string, unknown> & { name: string }): Promise<string> {
  const { getDb } = await import('@/db/postgres');
  const { skillProposals } = await import('@/db/schema/skill-proposals');
  seq++;
  const [row] = await getDb().insert(skillProposals).values({
    userId,
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

describe('listing', () => {
  test('pending sorted by exemplar count then oldest; candidates follow only when asked; the candidate count', async () => {
    const oldOne = await seed({ name: 'old-one' });
    const busy = await seed({ name: 'busy', exemplarCount: 5 });
    const newOne = await seed({ name: 'new-one' });
    const candidate = await seed({ name: 'waiting', status: 'candidate', exemplarCount: 9 });
    await seed({ name: 'theirs', userId: otherId, status: 'candidate' });

    expect((await service.listPendingProposals(userId)).map(p => p.id)).toEqual([busy, oldOne, newOne]);
    expect((await service.listOpenProposals(userId, { includeCandidates: true })).map(p => p.id)).toEqual([busy, oldOne, newOne, candidate]);
    expect(await service.countCandidateProposals(userId)).toBe(1);
    expect(await service.countCandidateProposals()).toBe(2);
  });

  test('the view adds sessionCount and the nearest similar skill, and never carries the embedding', async () => {
    const { getDb } = await import('@/db/postgres');
    const { skills } = await import('@/db/schema/skills');
    const skillId = randomUUID();
    await getDb().insert(skills).values({ id: skillId, name: 'rotate-keys', description: 'Rotate keys', content: 'x', userId, descriptionEmbedding: [1, 0.8, 0.2, 0] });
    // Another user's skill, nearer still, is not mentioned.
    await getDb().insert(skills).values({ id: randomUUID(), name: 'their-rotation', description: 'Rotate', content: 'x', userId: otherId, descriptionEmbedding: [1, 0.9, 0.1, 0] });
    const near = await seed({ name: 'token-rotation', embedding: [1, 0.9, 0.1, 0], sourceRefs: ['learning:j1:session:a', 'learning:j2:session:a', 'session:b', 'text'] });
    const far = await seed({ name: 'restore-backups', embedding: [0, 0.1, 1, 0.9] });
    const none = await seed({ name: 'no-embedding' });

    const views = await service.toProposalViews(await service.listPendingProposals(userId));
    const byId = new Map(views.map(v => [v.id, v]));
    expect(byId.get(near)).toMatchObject({ sessionCount: 3, similarSkill: { id: skillId, name: 'rotate-keys' } });
    expect(byId.get(near)!.similarSkill!.similarity).toBeGreaterThan(0.95);
    expect(byId.get(far)!.similarSkill).toBeNull();
    expect(byId.get(none)!.similarSkill).toBeNull();
    for (const view of views) {
      expect(view).not.toHaveProperty('embedding');
      expect(view).not.toHaveProperty('rejectedUntil');
      expect(typeof view.createdAt).toBe('string');
    }
  });
});

describe('approve and reject', () => {
  test('a candidate can be approved and rejected', async () => {
    const approved = await seed({ name: 'candidate-skill', status: 'candidate' });
    expect(await service.approveProposal(approved, { userId })).toMatchObject({ promoted: 'skill', name: 'candidate-skill' });
    expect((await read(approved)).status).toBe('promoted');

    const rejected = await seed({ name: 'other-candidate', status: 'candidate' });
    expect(await service.rejectProposal(rejected, userId)).toBeInstanceOf(Date);
    expect((await read(rejected)).status).toBe('rejected');
  });

  test('rejecting a target rejects its absorbed rows with the same rejected_until; a merged row cannot be rejected', async () => {
    const target = await seed({ name: 'target' });
    const absorbed = await seed({ name: 'absorbed', status: 'merged', mergedIntoId: target });
    const elsewhere = await seed({ name: 'elsewhere', status: 'merged', mergedIntoId: await seed({ name: 'other-target' }) });

    expect(await service.rejectProposal(absorbed, userId)).toBeNull();
    const until = await service.rejectProposal(target, userId);
    expect(until).toBeInstanceOf(Date);
    expect(await read(target)).toMatchObject({ status: 'rejected', rejectedUntil: until });
    expect(await read(absorbed)).toMatchObject({ status: 'rejected', rejectedUntil: until });
    expect((await read(elsewhere)).status).toBe('merged');
  });

  test('bulk reject is scoped to the owner and reports what it did not find', async () => {
    const a = await seed({ name: 'a' });
    const b = await seed({ name: 'b', status: 'candidate' });
    const absorbed = await seed({ name: 'b-child', status: 'merged', mergedIntoId: b });
    const theirs = await seed({ name: 'theirs', userId: otherId });
    const promoted = await seed({ name: 'done', status: 'promoted' });
    const missing = randomUUID();

    const result = await service.rejectProposals([a, b, theirs, promoted, missing, 'not-a-uuid', a], userId);
    expect(result).toEqual({ rejected: [a, b], notFound: [theirs, promoted, missing, 'not-a-uuid'] });
    expect((await read(absorbed)).status).toBe('rejected');
    expect((await read(theirs)).status).toBe('pending');
  });
});

describe('manual merge', () => {
  test('merges one proposal into another: counts, sources, merged_into_id', async () => {
    const into = await seed({ name: 'into', exemplarCount: 2, sourceRefs: ['session:x', 'session:y'] });
    const from = await seed({ name: 'from', exemplarCount: 3, sourceRefs: ['session:z'] });
    const child = await seed({ name: 'from-child', status: 'merged', mergedIntoId: from });
    complete.mockResolvedValueOnce(reply('merged', 'Both together', '1. both'));

    const result = await service.mergeProposals(from, into, userId);
    expect(result).toMatchObject({ outcome: 'merged', verdict: 'merged', mergeDegraded: false });
    expect(await read(into)).toMatchObject({ exemplarCount: 5, sourceRefs: ['session:x', 'session:y', 'session:z'], draftPromptTemplate: '1. both', previousDraft: 'into steps' });
    expect(await read(from)).toMatchObject({ status: 'merged', mergedIntoId: into });
    expect(await read(child)).toMatchObject({ status: 'merged', mergedIntoId: into });
    expect(JSON.parse(complete.mock.calls[0][0].messages[1].content).allowDistinct).toBe(false);
  });

  test('a pending proposal merged into a candidate keeps the topic shown', async () => {
    const candidate = await seed({ name: 'candidate', status: 'candidate' });
    const pending = await seed({ name: 'pending' });
    complete.mockResolvedValueOnce(reply('unchanged'));
    await service.mergeProposals(pending, candidate, userId);
    expect((await read(candidate)).status).toBe('pending');
    expect((await read(candidate)).surfacedAt).toBeInstanceOf(Date);
  });

  test.each([
    ['the same row', async () => { const id = await seed({ name: 'x' }); return [id, id]; }, 'same'],
    ['another user\'s target', async () => [await seed({ name: 'x' }), await seed({ name: 'y', userId: otherId })], 'not_found'],
    ['a missing row', async () => [await seed({ name: 'x' }), randomUUID()], 'not_found'],
    ['a patch', async () => [await seed({ name: 'x', kind: 'patch' }), await seed({ name: 'y' })], 'patch'],
    ['a rejected target', async () => [await seed({ name: 'x' }), await seed({ name: 'y', status: 'rejected' })], 'not_open'],
    ['a merged source', async () => [await seed({ name: 'x', status: 'merged' }), await seed({ name: 'y' })], 'not_open'],
  ] as const)('refuses %s', async (_label, arrange, code) => {
    const [from, into] = await arrange();
    await expect(service.mergeProposals(from, into, userId)).rejects.toMatchObject({ code });
    expect(complete).not.toHaveBeenCalled();
  });

  test('an admin (no owner scope) still cannot merge two users\' proposals', async () => {
    const mine = await seed({ name: 'x' });
    const theirs = await seed({ name: 'y', userId: otherId });
    await expect(service.mergeProposals(mine, theirs)).rejects.toMatchObject({ code: 'owner' });
  });

  test('a target approved while the model answers: nothing merged, the source is open again', async () => {
    const into = await seed({ name: 'into' });
    const from = await seed({ name: 'from' });
    complete.mockImplementationOnce(async () => {
      await service.approveProposal(into, { userId });
      return reply('unchanged');
    });
    await expect(service.mergeProposals(from, into, userId)).rejects.toMatchObject({ code: 'not_open' });
    expect(await read(from)).toMatchObject({ status: 'pending', mergedIntoId: null, exemplarCount: 1 });
  });

  test('a target rejected while the model answers takes the source being merged into it along', async () => {
    const into = await seed({ name: 'into' });
    const from = await seed({ name: 'from' });
    complete.mockImplementationOnce(async () => {
      await service.rejectProposal(into, userId);
      return reply('unchanged');
    });
    await expect(service.mergeProposals(from, into, userId)).rejects.toMatchObject({ code: 'not_open' });
    expect((await read(from)).status).toBe('rejected');
  });
});

describe('surface', () => {
  test('a candidate becomes pending now, caps or not; anything else is not found', async () => {
    const candidate = await seed({ name: 'waiting', status: 'candidate' });
    const theirs = await seed({ name: 'theirs', status: 'candidate', userId: otherId });
    const pending = await seed({ name: 'shown' });
    const surfaced = await service.surfaceProposal(candidate, userId);
    expect(surfaced).toMatchObject({ id: candidate, status: 'pending' });
    expect(surfaced!.surfacedAt).toBeInstanceOf(Date);
    expect(await service.surfaceProposal(theirs, userId)).toBeNull();
    expect(await service.surfaceProposal(pending, userId)).toBeNull();
    expect(await service.surfaceProposal('nope', userId)).toBeNull();
  });
});
