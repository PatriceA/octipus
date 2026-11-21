/**
 * Filing a skill proposal against embedded PGlite: the recurrence gate
 * (candidate until seen in two sessions), merging instead of dropping, the
 * surfacing caps, suppression by meaning, the related band, a degraded merge,
 * the merged-row redirect and live-skill embeddings filled on demand
 * (docs/plans/self-learning-consolidation.md). The embedding service and the
 * merge model are stubbed.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Config } from '@/config';

const userId = '44444444-4444-4444-8444-444444444444';

/** Deterministic stand-in embeddings by topic. */
const VECTORS = {
  rotation: [1, 0.9, 0.1, 0],
  /** cosine ≈ 0.75 to rotation: the related band. */
  keyring: [1, 0.1, 0.5, 0],
  backups: [0, 0.1, 1, 0.9],
  /** Unlike any of the others. */
  deploy: [0, 1, 0, 0],
};
function vectorFor(text: string): number[] {
  if (/keyring/i.test(text)) return VECTORS.keyring;
  if (/deploy/i.test(text)) return VECTORS.deploy;
  return /rotat|credential|token/i.test(text) ? VECTORS.rotation : VECTORS.backups;
}

let embeddingsModule: typeof import('@/core/rag/embeddings');
let registryModule: typeof import('@/models/model-registry');
let clientModule: typeof import('@/models/litellm-client');
let fileSkillProposal: typeof import('./file-skill-proposal').fileSkillProposal;
let learning: Config['learning'];
let savedLearning: Config['learning'];
const complete = vi.fn();

function stubEmbeddings() {
  vi.spyOn(embeddingsModule, 'getEmbeddingService').mockReturnValue({
    generateEmbedding: async (text: string) => vectorFor(text),
  } as never);
}

function stubMergeModel() {
  vi.spyOn(registryModule, 'getModelRegistry').mockReturnValue({
    getModelForTopic: async (topic: string) => (topic === 'background' ? { modelId: 'test-background', name: 'background-test' } : null),
  } as never);
  vi.spyOn(clientModule, 'getLiteLLMClient').mockReturnValue({ complete } as never);
}

const reply = (verdict: 'merged' | 'unchanged' | 'distinct', description = '', content = '') =>
  ({ content: JSON.stringify({ verdict, description, content }), finishReason: 'stop' });

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-skill-consolidation-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: userId, username: 'consolidator' }]);

  embeddingsModule = await import('@/core/rag/embeddings');
  registryModule = await import('@/models/model-registry');
  clientModule = await import('@/models/litellm-client');
  ({ fileSkillProposal } = await import('./file-skill-proposal'));
  const { getConfig } = await import('@/config');
  learning = getConfig().learning;
  savedLearning = { ...learning };
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
  stubEmbeddings();
  stubMergeModel();
});

afterEach(async () => {
  vi.restoreAllMocks();
  Object.assign(learning, savedLearning);
  const { setCapabilitiesForTest } = await import('@/core/capabilities/gates');
  setCapabilitiesForTest({ embedding: true });
});

async function readProposal(id: string) {
  const { eq } = await import('drizzle-orm');
  const { getDb } = await import('@/db/postgres');
  const { skillProposals } = await import('@/db/schema/skill-proposals');
  const [row] = await getDb().select().from(skillProposals).where(eq(skillProposals.id, id));
  return row;
}

async function allProposals() {
  const { getDb } = await import('@/db/postgres');
  const { skillProposals } = await import('@/db/schema/skill-proposals');
  return getDb().select().from(skillProposals);
}

async function seedProposal(fields: Record<string, unknown> & { name: string }): Promise<string> {
  const { getDb } = await import('@/db/postgres');
  const { skillProposals } = await import('@/db/schema/skill-proposals');
  const { skillFingerprint } = await import('@/tools/skill-distill/distiller');
  const [row] = await getDb().insert(skillProposals).values({
    userId,
    fingerprint: skillFingerprint(userId, fields.name),
    description: 'How to rotate a token',
    draftPromptTemplate: '1. revoke\n2. reissue',
    kind: 'skill',
    lastExemplarAt: new Date(),
    ...fields,
  }).returning();
  return row.id;
}

const rotation = { name: 'token-rotation', description: 'Rotate an API token safely', content: '1. revoke\n2. reissue' };
const learned = (job: string, session: string) => `learning:${job}:session:${session}`;

describe('fileSkillProposal: recurrence gate and merging', () => {
  test('a learned proposal starts as a candidate with one exemplar and its source', async () => {
    const result = await fileSkillProposal(rotation, userId, learned('j1', 's1'), { origin: 'learning', signal: 'procedure' });
    expect(result).toMatchObject({ distilled: true, status: 'candidate' });
    const row = await readProposal(result.proposalId as string);
    expect(row).toMatchObject({ status: 'candidate', exemplarCount: 1, sourceRefs: [learned('j1', 's1')], signal: 'procedure', surfacedAt: null });
    expect(row.embedding).toEqual(VECTORS.rotation);
  });

  test('the same topic from a second session merges into it and surfaces it', async () => {
    const first = await fileSkillProposal(rotation, userId, learned('j1', 's1'), { origin: 'learning', signal: 'procedure' });
    complete.mockResolvedValueOnce(reply('merged', 'Rotate an API token without downtime', '1. issue new\n2. switch\n3. revoke old'));

    // Another name, same meaning: caught by similarity, not the fingerprint.
    const second = await fileSkillProposal({ ...rotation, name: 'rotate-credentials' }, userId, learned('j2', 's2'),
      { origin: 'learning', signal: 'recovery' });
    expect(second).toMatchObject({ deduped: true, merged: true, proposalId: first.proposalId, status: 'pending' });
    expect(second.mergeDegraded).toBeUndefined();

    const row = await readProposal(first.proposalId as string);
    expect(row).toMatchObject({
      name: 'token-rotation', status: 'pending', exemplarCount: 2,
      sourceRefs: [learned('j1', 's1'), learned('j2', 's2')], signal: 'recovery',
      previousDraft: '1. revoke\n2. reissue', draftPromptTemplate: '1. issue new\n2. switch\n3. revoke old',
      description: 'Rotate an API token without downtime',
    });
    expect(row.surfacedAt).toBeInstanceOf(Date);
    expect(await allProposals()).toHaveLength(1);
    expect(complete.mock.calls[0][0]).toMatchObject({ model: 'test-background', responseFormat: { type: 'json_object' } });
  });

  test('the same session twice is counted but stays a candidate', async () => {
    const first = await fileSkillProposal(rotation, userId, learned('j1', 's1'), { origin: 'learning', signal: 'procedure' });
    complete.mockResolvedValueOnce(reply('unchanged'));
    const second = await fileSkillProposal(rotation, userId, learned('j2', 's1'), { origin: 'learning', signal: 'procedure' });
    expect(second).toMatchObject({ merged: true, status: 'candidate' });
    expect(await readProposal(first.proposalId as string)).toMatchObject({ status: 'candidate', exemplarCount: 2, previousDraft: null });
  });

  test('a user correction and a manual request are pending at once', async () => {
    const correction = await fileSkillProposal(rotation, userId, learned('j1', 's1'), { origin: 'learning', signal: 'correction' });
    expect(correction.status).toBe('pending');
    const manual = await fileSkillProposal({ name: 'restore-backups', description: 'Restore from backups', content: 'steps' }, userId, 'session:s9');
    expect(manual.status).toBe('pending');
    expect((await readProposal(manual.proposalId as string)).surfacedAt).toBeInstanceOf(Date);
  });

  test('a manual request merged into a candidate shows it at once, past the gate and the caps', async () => {
    learning.maxSkillProposalsPerDay = 0;
    learning.maxPendingSkillProposals = 0;
    const first = await fileSkillProposal(rotation, userId, learned('j1', 's1'), { origin: 'learning', signal: 'procedure' });
    expect(first.status).toBe('candidate');
    complete.mockResolvedValueOnce(reply('unchanged'));
    // Same session: the recurrence gate alone would keep it a candidate.
    const manual = await fileSkillProposal(rotation, userId, 'session:s1');
    expect(manual).toMatchObject({ merged: true, proposalId: first.proposalId, status: 'pending' });
    expect(manual.message).toContain('now shown for review');
    const row = await readProposal(first.proposalId as string);
    expect(row).toMatchObject({ status: 'pending', exemplarCount: 2 });
    expect(row.surfacedAt).toBeInstanceOf(Date);
  });

  test('recurrenceSessions 1 turns the gate off', async () => {
    learning.recurrenceSessions = 1;
    expect((await fileSkillProposal(rotation, userId, learned('j1', 's1'), { origin: 'learning', signal: 'procedure' })).status).toBe('pending');
  });
});

describe('fileSkillProposal: caps', () => {
  test('the per-day cap keeps a learned proposal a candidate; a manual one passes', async () => {
    learning.maxSkillProposalsPerDay = 1;
    await seedProposal({ name: 'earlier-today', description: 'Restore from backups', status: 'pending', surfacedAt: new Date(), sourceRef: learned('j0', 's0') });
    const capped = await fileSkillProposal(rotation, userId, learned('j1', 's1'), { origin: 'learning', signal: 'correction' });
    expect(capped.status).toBe('candidate');
    const manual = await fileSkillProposal({ name: 'deploy-preview', description: 'Deploy a preview build', content: 'steps' }, userId, 'text');
    expect(manual.status).toBe('pending');
  });

  test('the max-pending cap holds back a learned proposal and its promotion', async () => {
    learning.maxPendingSkillProposals = 1;
    await seedProposal({ name: 'restore-backups', description: 'Restore from backups', status: 'pending', sourceRef: 'text' });
    const first = await fileSkillProposal(rotation, userId, learned('j1', 's1'), { origin: 'learning', signal: 'correction' });
    expect(first.status).toBe('candidate');
    complete.mockResolvedValueOnce(reply('unchanged'));
    const second = await fileSkillProposal(rotation, userId, learned('j2', 's2'), { origin: 'learning', signal: 'procedure' });
    expect(second).toMatchObject({ merged: true, status: 'candidate' });
    expect(await readProposal(first.proposalId as string)).toMatchObject({ status: 'candidate', exemplarCount: 2 });
    expect((await fileSkillProposal({ name: 'deploy-preview', description: 'Deploy a preview build', content: 'steps' }, userId, 'text')).status)
      .toBe('pending');
  });
});

describe('fileSkillProposal: dedup outcomes', () => {
  test('a rejected, still suppressed proposal blocks a differently named equal one', async () => {
    // Seeded without an embedding: the dedup embeds suppressed rows too.
    const id = await seedProposal({ name: 'vault-token-rotation', status: 'rejected', rejectedUntil: new Date(Date.now() + 86_400_000) });
    const result = await fileSkillProposal({ ...rotation, name: 'secure-credential-rotation' }, userId, learned('j1', 's1'), { origin: 'learning', signal: 'procedure' });
    expect(result).toMatchObject({ distilled: false, deduped: true, name: 'vault-token-rotation' });
    expect(result.message).toContain('suppressed');
    expect((await readProposal(id)).embedding).toEqual(VECTORS.rotation);
    expect(await allProposals()).toHaveLength(1);
  });

  test('the related band asks the model; a distinct verdict files a new row', async () => {
    const first = await fileSkillProposal(rotation, userId, learned('j1', 's1'), { origin: 'learning', signal: 'procedure' });
    complete.mockResolvedValueOnce(reply('distinct'));
    const second = await fileSkillProposal({ name: 'unlock-keyring', description: 'Unlock the desktop keyring', content: 'steps' }, userId,
      learned('j2', 's2'), { origin: 'learning', signal: 'procedure' });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(JSON.parse(complete.mock.calls[0][0].messages[1].content)).toMatchObject({ allowDistinct: true });
    expect(second.proposalId).not.toBe(first.proposalId);
    expect(second).toMatchObject({ distilled: true, status: 'candidate' });
    expect(await readProposal(first.proposalId as string)).toMatchObject({ exemplarCount: 1 });
    expect(await allProposals()).toHaveLength(2);
  });

  test.each([
    ['fails', () => complete.mockRejectedValueOnce(new Error('provider down'))],
    ['is truncated', () => complete.mockResolvedValueOnce({ content: '{"verdict":"merged","descr', finishReason: 'length' })],
    ['answers nonsense', () => complete.mockResolvedValueOnce({ content: 'sure!', finishReason: 'stop' })],
  ])('a merge model that %s degrades to a count-only merge and says so', async (_label, arrange) => {
    const first = await fileSkillProposal(rotation, userId, learned('j1', 's1'), { origin: 'learning', signal: 'procedure' });
    arrange();
    const second = await fileSkillProposal(rotation, userId, learned('j2', 's2'), { origin: 'learning', signal: 'procedure' });
    expect(second).toMatchObject({ merged: true, mergeDegraded: true, status: 'pending' });
    expect(await readProposal(first.proposalId as string)).toMatchObject({
      exemplarCount: 2, draftPromptTemplate: rotation.content, previousDraft: null, status: 'pending',
    });
  });

  test.each([
    ['fails', () => complete.mockRejectedValueOnce(new Error('provider down'))],
    ['is truncated', () => complete.mockResolvedValueOnce({ content: '{"verdict":"merged","descr', finishReason: 'length' })],
    ['answers nonsense', () => complete.mockResolvedValueOnce({ content: 'sure!', finishReason: 'stop' })],
  ])('in the related band a merge model that %s files a separate proposal instead of counting it', async (_label, arrange) => {
    const first = await fileSkillProposal(rotation, userId, learned('j1', 's1'), { origin: 'learning', signal: 'procedure' });
    arrange();
    const second = await fileSkillProposal({ name: 'unlock-keyring', description: 'Unlock the desktop keyring', content: 'steps' }, userId,
      learned('j2', 's2'), { origin: 'learning', signal: 'procedure' });
    expect(second.proposalId).not.toBe(first.proposalId);
    expect(second).toMatchObject({ distilled: true, status: 'candidate' });
    expect(second.merged).toBeUndefined();
    expect(await readProposal(first.proposalId as string)).toMatchObject({ exemplarCount: 1, sourceRefs: [learned('j1', 's1')] });
    expect(await allProposals()).toHaveLength(2);
  });

  test('a merge target rejected between the decision and the write is decided again (now suppressed)', async () => {
    const first = await fileSkillProposal(rotation, userId, learned('j1', 's1'), { origin: 'learning', signal: 'procedure' });
    const { rejectProposal } = await import('./skill-proposal-service');
    complete.mockImplementationOnce(async () => {
      await rejectProposal(first.proposalId as string, userId);
      return reply('unchanged');
    });
    const second = await fileSkillProposal(rotation, userId, learned('j2', 's2'), { origin: 'learning', signal: 'procedure' });
    expect(second).toMatchObject({ distilled: false, deduped: true, name: 'token-rotation' });
    expect(second.message).toContain('suppressed');
    expect(await readProposal(first.proposalId as string)).toMatchObject({ status: 'rejected', exemplarCount: 1 });
    expect(await allProposals()).toHaveLength(1);
  });

  test('a merge target that is not open twice in a row is an error', async () => {
    const first = await fileSkillProposal(rotation, userId, learned('j1', 's1'), { origin: 'learning', signal: 'procedure' });
    const merge = await import('./skill-proposal-merge');
    const spy = vi.spyOn(merge, 'mergeIntoProposal').mockRejectedValue(new merge.ProposalNotOpenError(first.proposalId as string, 'promoted'));
    await expect(fileSkillProposal(rotation, userId, learned('j2', 's2'), { origin: 'learning', signal: 'procedure' }))
      .rejects.toBeInstanceOf(merge.ProposalNotOpenError);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  test('a merged row redirects to the proposal it was absorbed into', async () => {
    const target = await seedProposal({ name: 'credential-rotation', status: 'pending', sourceRefs: ['text'], sourceRef: 'text' });
    await seedProposal({ name: 'restore-backups', description: 'Restore from backups', status: 'merged', mergedIntoId: target });
    complete.mockResolvedValueOnce(reply('unchanged'));
    const result = await fileSkillProposal({ name: 'Restore Backups', description: 'Restore from backups', content: 'steps' }, userId, 'session:s3');
    expect(result).toMatchObject({ merged: true, proposalId: target });
    expect(await readProposal(target)).toMatchObject({ exemplarCount: 2, sourceRefs: ['text', 'session:s3'] });
  });

  test('a live skill without an embedding is embedded first and then blocks the proposal', async () => {
    const { getDb } = await import('@/db/postgres');
    const { skills } = await import('@/db/schema/skills');
    const { eq } = await import('drizzle-orm');
    const skillId = randomUUID();
    await getDb().insert(skills).values({ id: skillId, name: 'credential-rotation-runbook', description: 'Rotate credentials on schedule', content: 'steps', userId });
    const result = await fileSkillProposal({ ...rotation, name: 'secure-token-swap' }, userId, learned('j1', 's1'), { origin: 'learning', signal: 'procedure' });
    expect(result).toMatchObject({ distilled: false, deduped: true, existingSkillId: skillId });
    const [skill] = await getDb().select().from(skills).where(eq(skills.id, skillId));
    expect(skill.descriptionEmbedding).toEqual(VECTORS.rotation);
    expect(skill.descriptionHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('a process that has not computed its capabilities yet still compares by meaning (the check the backfill makes)', async () => {
    const gates = await import('@/core/capabilities/gates');
    const first = await fileSkillProposal(rotation, userId, learned('j1', 's1'), { origin: 'learning', signal: 'procedure' });
    // "Not checked yet" reads as off to the synchronous check; the async one computes it.
    gates.resetCapabilitiesForTest();
    gates.setCapabilityResolver('embedding', async () => ({ on: true }));
    complete.mockResolvedValueOnce(reply('unchanged'));
    const second = await fileSkillProposal({ ...rotation, name: 'rotate-credentials' }, userId, learned('j2', 's2'), { origin: 'learning', signal: 'procedure' });
    expect(second).toMatchObject({ merged: true, proposalId: first.proposalId });
    expect(await allProposals()).toHaveLength(1);
  });

  test('without an embedding model the name checks and extendsProposalId still work', async () => {
    const { setCapabilitiesForTest } = await import('@/core/capabilities/gates');
    setCapabilitiesForTest({ embedding: false });
    const target = await seedProposal({ name: 'restore-backups', description: 'Restore from backups', status: 'candidate', sourceRefs: [learned('j0', 's0')] });
    complete.mockResolvedValueOnce(reply('unchanged'));
    const result = await fileSkillProposal(rotation, userId, learned('j1', 's1'), { origin: 'learning', signal: 'procedure', extendsProposalId: `proposal:${target}` });
    expect(result).toMatchObject({ merged: true, proposalId: target, status: 'pending' });
    expect(await allProposals()).toHaveLength(1);
  });
});

describe('fileSkillPatchProposal', () => {
  test('records its source and is surfaced at once', async () => {
    const { getDb } = await import('@/db/postgres');
    const { skills } = await import('@/db/schema/skills');
    const skillId = randomUUID();
    await getDb().insert(skills).values({ id: skillId, name: 'deploy', description: 'Deploy', content: '1. Build.\n2. Push it.\n', userId });
    const { fileSkillPatchProposal } = await import('./file-skill-proposal');
    const result = await fileSkillPatchProposal({ skillId, oldText: '2. Push it.', newText: '2. Push it with --tag.', reason: 'untagged push failed' }, userId, learned('j1', 's1'));
    const row = await readProposal(result.proposalId as string);
    expect(row).toMatchObject({ kind: 'patch', status: 'pending', exemplarCount: 1, sourceRefs: [learned('j1', 's1')] });
    expect(row.surfacedAt).toBeInstanceOf(Date);
  });
});
