/**
 * Consolidating skill proposals against embedded PGlite: duplicates merge and
 * their counts add up, a related pair the model calls distinct stays apart
 * (and is not asked twice), stale candidates expire, candidates surface within
 * the caps, `maxMerges` bounds a run, and the daily maintenance runs at most
 * once per 24 hours (docs/plans/self-learning-consolidation.md). The embedding
 * service and the merge model are stubbed.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Config } from '@/config';

const userId = '55555555-5555-4555-8555-555555555555';
const otherId = '66666666-6666-4666-8666-666666666666';

const VECTORS = {
  rotation: [1, 0.9, 0.1, 0],
  /** cosine ≈ 0.75 to rotation: the related band. */
  keyring: [1, 0.1, 0.5, 0],
  backups: [0, 0.1, 1, 0.9],
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
let consolidation: typeof import('./consolidation');
let learning: Config['learning'];
let savedLearning: Config['learning'];
const complete = vi.fn();

const reply = (verdict: 'merged' | 'unchanged' | 'distinct', description = '', content = '') =>
  ({ content: JSON.stringify({ verdict, description, content }), finishReason: 'stop' });

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-learning-consolidation-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: userId, username: 'consolidate-a' }, { id: otherId, username: 'consolidate-b' }]);

  embeddingsModule = await import('@/core/rag/embeddings');
  registryModule = await import('@/models/model-registry');
  clientModule = await import('@/models/litellm-client');
  consolidation = await import('./consolidation');
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
  const { kvStore } = await import('@/db/schema/kv');
  await getDb().delete(skillProposals);
  await getDb().delete(skills);
  await getDb().delete(kvStore);
  complete.mockReset();
  vi.spyOn(embeddingsModule, 'getEmbeddingService').mockReturnValue({
    generateEmbedding: async (text: string) => vectorFor(text),
  } as never);
  vi.spyOn(registryModule, 'getModelRegistry').mockReturnValue({
    getModelForTopic: async (topic: string) => (topic === 'background' ? { modelId: 'test-background', name: 'background-test' } : null),
  } as never);
  vi.spyOn(clientModule, 'getLiteLLMClient').mockReturnValue({ complete } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.assign(learning, savedLearning);
});

const DAY = 24 * 60 * 60 * 1000;
let seq = 0;

async function seed(fields: Record<string, unknown> & { name: string }): Promise<string> {
  const { getDb } = await import('@/db/postgres');
  const { skillProposals } = await import('@/db/schema/skill-proposals');
  const { skillFingerprint } = await import('@/tools/skill-distill/distiller');
  const owner = (fields.userId as string | undefined) ?? userId;
  seq++;
  const [row] = await getDb().insert(skillProposals).values({
    userId: owner,
    fingerprint: skillFingerprint(owner, fields.name),
    description: 'How to rotate a token',
    draftPromptTemplate: '1. revoke\n2. reissue',
    kind: 'skill',
    status: 'pending',
    exemplarCount: 1,
    sourceRef: `learning:j${seq}:session:s${seq}`,
    sourceRefs: [`learning:j${seq}:session:s${seq}`],
    lastExemplarAt: new Date(),
    // Distinct, increasing creation times: "oldest" is well defined.
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

describe('consolidateProposals', () => {
  test('duplicates merge into the pending one with the most observations, and the counts add up', async () => {
    const small = await seed({ name: 'token-rotation', exemplarCount: 1 });
    const big = await seed({ name: 'rotate-credentials', exemplarCount: 3, sourceRefs: ['session:a', 'session:b', 'session:c'] });
    const candidate = await seed({ name: 'credential-rotation', status: 'candidate', exemplarCount: 2, sourceRefs: ['session:d', 'session:e'] });
    const unrelated = await seed({ name: 'deploy-preview', description: 'Deploy a preview build' });
    complete.mockResolvedValue(reply('unchanged'));

    const report = await consolidation.consolidateProposals(userId);

    expect(report).toMatchObject({ merged: 2, degraded: 0, expired: 0 });
    expect(report.embedded).toBe(4);
    const target = await read(big);
    expect(target).toMatchObject({ status: 'pending', exemplarCount: 6 });
    expect(target.sourceRefs).toEqual(expect.arrayContaining(['session:a', 'session:d', 'session:e', (await read(small)).sourceRefs[0]]));
    expect(target.sourceRefs).toHaveLength(6);
    expect(await read(small)).toMatchObject({ status: 'merged', mergedIntoId: big });
    expect(await read(candidate)).toMatchObject({ status: 'merged', mergedIntoId: big });
    expect((await read(unrelated)).status).toBe('pending');
    // Duplicates: the model may not answer distinct.
    for (const call of complete.mock.calls) expect(JSON.parse(call[0].messages[1].content).allowDistinct).toBe(false);
  });

  test('a degraded merge is counted and reported', async () => {
    await seed({ name: 'token-rotation' });
    await seed({ name: 'rotate-credentials' });
    complete.mockRejectedValue(new Error('provider down'));
    expect(await consolidation.consolidateProposals(userId)).toMatchObject({ merged: 1, degraded: 1 });
  });

  test('a related pair the model calls distinct stays apart and is asked once', async () => {
    const rotation = await seed({ name: 'token-rotation' });
    const keyring = await seed({ name: 'unlock-keyring', description: 'Unlock the desktop keyring' });
    const backupA = await seed({ name: 'restore-backups', description: 'Restore from backups' });
    const backupB = await seed({ name: 'backup-restore', description: 'Restore the nightly backups' });
    complete.mockImplementation(async (req: { messages: Array<{ content: string }> }) =>
      (/keyring/i.test(req.messages[1].content) ? reply('distinct') : reply('unchanged')));

    const report = await consolidation.consolidateProposals(userId);

    expect(report.merged).toBe(1);
    expect((await read(rotation)).status).toBe('pending');
    expect((await read(keyring)).status).toBe('pending');
    expect([(await read(backupA)).status, (await read(backupB)).status].sort()).toEqual(['merged', 'pending']);
    // The backups pair once, the related pair once — not again in the second round.
    expect(complete).toHaveBeenCalledTimes(2);
    const related = complete.mock.calls.map(call => JSON.parse(call[0].messages[1].content)).find(input => /keyring/i.test(JSON.stringify(input)));
    expect(related.allowDistinct).toBe(true);
  });

  test('a related pair the merge model cannot judge stays apart for this run and is asked again next run', async () => {
    const rotation = await seed({ name: 'token-rotation' });
    const keyring = await seed({ name: 'unlock-keyring', description: 'Unlock the desktop keyring' });
    complete.mockRejectedValue(new Error('provider down'));

    expect(await consolidation.consolidateProposals(userId)).toMatchObject({ merged: 0, degraded: 0 });
    expect((await read(rotation)).status).toBe('pending');
    expect((await read(keyring)).status).toBe('pending');
    expect((await read(rotation)).exemplarCount).toBe(1);
    // Asked once in the run, not retried within it ...
    expect(complete).toHaveBeenCalledTimes(1);
    // ... but not remembered as distinct: the next run asks again and merges.
    complete.mockReset();
    complete.mockResolvedValue(reply('unchanged'));
    expect((await consolidation.consolidateProposals(userId)).merged).toBe(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  test('a stale candidate that already recurred, or rests on a correction, is kept', async () => {
    learning.candidateTtlDays = 30;
    learning.maxPendingSkillProposals = 0;
    const old = new Date(Date.now() - 40 * DAY);
    const recurred = await seed({ name: 'restore-backups', description: 'Restore from backups', status: 'candidate', lastExemplarAt: old,
      sourceRefs: ['learning:j1:session:s1', 'learning:j2:session:s2'] });
    const corrected = await seed({ name: 'deploy-preview', description: 'Deploy a preview build', status: 'candidate', lastExemplarAt: old, signal: 'correction' });
    const once = await seed({ name: 'token-rotation', status: 'candidate', lastExemplarAt: old });

    const report = await consolidation.consolidateProposals(userId);

    expect(report.expired).toBe(1);
    expect(await read(once)).toBeUndefined();
    expect((await read(recurred)).status).toBe('candidate');
    expect((await read(corrected)).status).toBe('candidate');
  });

  test('candidates not seen for candidateTtlDays expire, with the rows merged into them', async () => {
    learning.candidateTtlDays = 30;
    const stale = await seed({ name: 'restore-backups', description: 'Restore from backups', status: 'candidate', lastExemplarAt: new Date(Date.now() - 40 * DAY) });
    const absorbed = await seed({ name: 'backup-restore', description: 'Restore from backups', status: 'merged', mergedIntoId: stale });
    const fresh = await seed({ name: 'deploy-preview', description: 'Deploy a preview build', status: 'candidate', lastExemplarAt: new Date(Date.now() - 10 * DAY) });
    const oldPending = await seed({ name: 'token-rotation', lastExemplarAt: new Date(Date.now() - 40 * DAY) });

    const report = await consolidation.consolidateProposals(userId);

    expect(report.expired).toBe(1);
    expect(await read(stale)).toBeUndefined();
    expect(await read(absorbed)).toBeUndefined();
    expect((await read(fresh)).status).toBe('candidate');
    expect((await read(oldPending)).status).toBe('pending');
  });

  test('recurring candidates are promoted oldest first until a cap is reached', async () => {
    learning.maxSkillProposalsPerDay = 1;
    const twoSessions = ['learning:j1:session:s1', 'learning:j2:session:s2'];
    const older = await seed({ name: 'restore-backups', description: 'Restore from backups', status: 'candidate', sourceRefs: twoSessions });
    const newer = await seed({ name: 'deploy-preview', description: 'Deploy a preview build', status: 'candidate', sourceRefs: twoSessions });
    const oneSession = await seed({ name: 'token-rotation', status: 'candidate' });

    const report = await consolidation.consolidateProposals(userId);

    expect(report.promoted).toBe(1);
    expect(await read(older)).toMatchObject({ status: 'pending' });
    expect((await read(older)).surfacedAt).toBeInstanceOf(Date);
    expect((await read(newer)).status).toBe('candidate');
    expect((await read(oneSession)).status).toBe('candidate');
  });

  test('maxMerges bounds the merges of one run', async () => {
    for (const name of ['token-rotation', 'rotate-credentials', 'credential-rotation', 'rotate-tokens', 'token-swap']) await seed({ name });
    complete.mockResolvedValue(reply('unchanged'));
    expect((await consolidation.consolidateProposals(userId, { maxMerges: 2 })).merged).toBe(2);
    expect(complete).toHaveBeenCalledTimes(2);
    const { getDb } = await import('@/db/postgres');
    const { skillProposals } = await import('@/db/schema/skill-proposals');
    const rows = await getDb().select().from(skillProposals);
    expect(rows.filter(row => row.status === 'pending')).toHaveLength(3);
  });

  test('only the given user\'s proposals are touched', async () => {
    const mine = await seed({ name: 'token-rotation' });
    const theirs = await seed({ name: 'rotate-credentials', userId: otherId });
    complete.mockResolvedValue(reply('unchanged'));
    expect((await consolidation.consolidateProposals(userId)).merged).toBe(0);
    expect((await read(mine)).status).toBe('pending');
    expect((await read(theirs)).status).toBe('pending');
    expect((await read(theirs)).embedding).toBeNull();
  });
});

describe('runDailyLearningMaintenance', () => {
  test('runs at most once per 24 hours, also when two ticks race', async () => {
    await seed({ name: 'token-rotation' });
    await seed({ name: 'rotate-credentials' });
    await seed({ name: 'restore-backups', description: 'Restore from backups', userId: otherId });
    complete.mockResolvedValue(reply('unchanged'));

    const [first, second] = await Promise.all([consolidation.runDailyLearningMaintenance(), consolidation.runDailyLearningMaintenance()]);
    const ran = [first, second].filter(result => result.ran);
    expect(ran).toHaveLength(1);
    expect(ran[0]).toMatchObject({ ran: true, users: 2, failed: 0, report: { merged: 1 }, curator: { archived: 0 } });
    expect(await consolidation.runDailyLearningMaintenance()).toEqual({ ran: false });

    // A day later it runs again.
    const { eq } = await import('drizzle-orm');
    const { getDb } = await import('@/db/postgres');
    const { kvStore } = await import('@/db/schema/kv');
    await getDb().update(kvStore).set({ value: String(Date.now() - DAY - 1000) }).where(eq(kvStore.key, consolidation.MAINTENANCE_KEY));
    expect((await consolidation.runDailyLearningMaintenance()).ran).toBe(true);
  });

  test('a run cut short (claimed, never finished) is retried after the lease, not a day later', async () => {
    const { eq } = await import('drizzle-orm');
    const { getDb } = await import('@/db/postgres');
    const { kvStore } = await import('@/db/schema/kv');
    const claimedAt = async (ms: number) => getDb().insert(kvStore)
      .values({ key: consolidation.MAINTENANCE_KEY, value: String(ms - DAY + consolidation.MAINTENANCE_LEASE_MS), expiresAt: null })
      .onConflictDoUpdate({ target: kvStore.key, set: { value: String(ms - DAY + consolidation.MAINTENANCE_LEASE_MS) } });

    // Claimed an hour ago by a process that may still be running: held off.
    await claimedAt(Date.now() - 60 * 60 * 1000);
    expect(await consolidation.runDailyLearningMaintenance()).toEqual({ ran: false });

    // Claimed past the lease and never finished (the process restarted): runs again.
    await claimedAt(Date.now() - consolidation.MAINTENANCE_LEASE_MS - 1000);
    const before = Date.now();
    expect((await consolidation.runDailyLearningMaintenance()).ran).toBe(true);
    // Finishing records the real run time, so the next is a day away.
    const [row] = await getDb().select().from(kvStore).where(eq(kvStore.key, consolidation.MAINTENANCE_KEY));
    expect(Number(row.value)).toBeGreaterThanOrEqual(before);
    expect(await consolidation.runDailyLearningMaintenance()).toEqual({ ran: false });
  });

  test('a failing user is logged and the others still run', async () => {
    const backfill = await import('@/skills/embedding-backfill');
    const real = backfill.ensureProposalEmbeddings;
    vi.spyOn(backfill, 'ensureProposalEmbeddings').mockImplementation(async (owner, opts) => {
      if (owner === otherId) throw new Error('db hiccup');
      return real(owner, opts);
    });
    await seed({ name: 'token-rotation' });
    await seed({ name: 'rotate-credentials' });
    await seed({ name: 'restore-backups', description: 'Restore from backups', userId: otherId });
    complete.mockResolvedValue(reply('unchanged'));

    const result = await consolidation.runDailyLearningMaintenance();
    expect(result).toMatchObject({ ran: true, users: 2, failed: 1, report: { merged: 1 } });
  });

  test('the hourly timer is unref\'d', () => {
    const unref = vi.fn();
    const interval = vi.spyOn(globalThis, 'setInterval').mockReturnValue({ unref } as never);
    const timeout = vi.spyOn(globalThis, 'setTimeout').mockReturnValue({ unref } as never);
    vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {});
    consolidation.startLearningMaintenance();
    expect(interval).toHaveBeenCalledWith(expect.any(Function), 60 * 60 * 1000);
    expect(timeout).toHaveBeenCalled();
    expect(unref).toHaveBeenCalledTimes(2);
    consolidation.stopLearningMaintenance();
  });
});
