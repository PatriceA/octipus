/**
 * The review pipeline end to end against embedded PGlite
 * (docs/plans/self-learning-consolidation.md, "Validation"): three learning
 * checks of the same topic across two sessions end with exactly one pending
 * proposal seen three times. The review model, the merge model and the
 * embedding service are stubbed; queueing, evidence windows, `existing`,
 * dedup, merge and the recurrence gate are the real ones.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';

const userId = '55555555-5555-4555-8555-555555555555';
const otherUserId = '66666666-6666-4666-8666-666666666666';
const sessionA = randomUUID();
const sessionB = randomUUID();

/** Every text about cache repair embeds to the same direction; anything else elsewhere. */
const vectorFor = (text: string) => (/cache/i.test(text) ? [1, 0.2, 0, 0] : [0, 0, 1, 0.3]);

interface ReviewInput {
  trigger: string;
  evidence: Array<{ id: string; kind: string; text: string }>;
  existing: { skills: Array<{ ref: string; name: string }>; proposals: Array<{ ref: string; name: string; excerpt?: string }> };
}
const reviewInputs: ReviewInput[] = [];

const complete = vi.fn(async (request: { requestType: string; messages: Array<{ content: string }> }) => {
  if (request.requestType === 'skill-proposal-merge') {
    return { content: JSON.stringify({ verdict: 'merged', description: 'Repair a stale build cache and verify it',
      content: '1. Clear the cache\n2. Rebuild\n3. Verify the tests pass' }), finishReason: 'stop' };
  }
  const input = JSON.parse(request.messages[1].content) as ReviewInput;
  reviewInputs.push(input);
  const cited = input.evidence.find(row => row.kind === 'execution');
  // The reviewer extends the open proposal it was shown, as the prompt asks.
  const offered = input.existing.proposals[0]?.ref;
  return { content: JSON.stringify({
    reason: 'A failure followed by a verified fix',
    knowledge: [], memories: [], patches: [],
    skills: cited ? [{ name: `repair-build-cache-${reviewInputs.length}`, description: 'Repair a stale build cache',
      content: '1. Clear the cache\n2. Rebuild', signal: 'recovery', sources: [cited.id], ...(offered ? { extends: offered } : {}) }] : [],
  }), finishReason: 'stop' };
});

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-learning-review-'));
  process.env.MASTER_KEY ??= randomUUID(); process.env.JWT_SECRET ??= randomUUID(); process.env.SESSION_SECRET ??= randomUUID();
  const { initializeDb, executeRaw } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: userId, username: 'learner' }, { id: otherUserId, username: 'stranger' }]);
  await executeRaw(`INSERT INTO sessions (id, user_id, channel_type, channel_id) VALUES ('${sessionA}', '${userId}', 'webchat', 'learn-a'), ('${sessionB}', '${userId}', 'webchat', 'learn-b')`);

  const embeddings = await import('@/core/rag/embeddings');
  vi.spyOn(embeddings, 'getEmbeddingService').mockReturnValue({ generateEmbedding: async (text: string) => vectorFor(text) } as never);
  const registry = await import('@/models/model-registry');
  vi.spyOn(registry, 'getModelRegistry').mockReturnValue({
    getModelForTopic: async (topic: string) => (topic === 'background' ? { modelId: 'test-background', name: 'background-test' } : null),
  } as never);
  const client = await import('@/models/litellm-client');
  vi.spyOn(client, 'getLiteLLMClient').mockReturnValue({ complete } as never);
  const { setCapabilitiesForTest } = await import('@/core/capabilities/gates');
  setCapabilitiesForTest({ embedding: true });
});

afterAll(async () => {
  vi.restoreAllMocks();
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

async function toolResult(sessionId: string, output: string, owner = userId) {
  const { agentEventRepository } = await import('@/db/repositories/agent-event-repository');
  await agentEventRepository.create({ sessionId, agentId: 'test', userId: owner, type: 'action', data: { type: 'cli_tool_result', output } });
}

/** Queue a check through `now` and run it the way the queue does. */
async function runCheck(sessionId: string, trigger: 'plan_completed' | 'substantial_turn' | 'manual') {
  const { backgroundJobRepository } = await import('@/db/repositories/background-job-repository');
  const { processLearningJob } = await import('./processor');
  // Strictly after the events just written.
  await new Promise(resolve => setTimeout(resolve, 5));
  await backgroundJobRepository.create({ kind: 'learning', userId, title: 'Learning check', payload: {
    sessionId, trigger, triggerKey: `${trigger}:${randomUUID()}`, through: new Date().toISOString(),
    ...(trigger === 'plan_completed' ? { plan: { id: 'p1', title: 'Fix the stale build cache', goal: 'Tests pass again', steps: [] } } : {}),
  } });
  const job = await backgroundJobRepository.claimNext('learning');
  if (!job) throw new Error('No learning check was queued');
  await processLearningJob(job);
  const { getDb } = await import('@/db/postgres');
  const { backgroundJobs } = await import('@/db/schema/background-jobs');
  const { eq } = await import('drizzle-orm');
  const [done] = await getDb().select().from(backgroundJobs).where(eq(backgroundJobs.id, job.id));
  return done;
}

test('three reviews of one topic across two sessions end as one pending proposal seen three times', async () => {
  const { getDb } = await import('@/db/postgres');
  const { skillProposals } = await import('@/db/schema/skill-proposals');
  // Another user's proposal on the same topic must never be offered.
  await getDb().insert(skillProposals).values({ userId: otherUserId, fingerprint: 'other', name: 'stranger-cache-fix', description: 'Repair a cache',
    draftPromptTemplate: 'private steps', kind: 'skill', status: 'pending', lastExemplarAt: new Date(), embedding: vectorFor('cache') });

  await toolResult(sessionA, 'build failed: stale cache');
  await toolResult(sessionA, 'cleared cache, tests pass');
  const first = await runCheck(sessionA, 'plan_completed');
  expect(first).toMatchObject({ status: 'done', stage: 'checked' });
  expect(first.result).toMatchObject({ outputs: [{ kind: 'skill', status: 'candidate' }] });
  expect(reviewInputs[0].existing.proposals).toEqual([]);
  expect(JSON.stringify(reviewInputs[0])).not.toContain('stranger');

  // Nothing new happened: the next automatic check ends without a review.
  const idle = await runCheck(sessionA, 'substantial_turn');
  expect(idle).toMatchObject({ status: 'done', stage: 'insufficient_evidence' });
  expect(reviewInputs).toHaveLength(1);

  await toolResult(sessionA, 'cache stale again after dependency bump; cleared it, tests pass');
  const second = await runCheck(sessionA, 'substantial_turn');
  expect(second.result).toMatchObject({ outputs: [{ kind: 'skill', status: 'merged' }] });
  // Only the new event was read, and the open proposal was offered.
  const secondEvents = reviewInputs[1].evidence.filter(row => row.kind === 'execution').map(row => row.text);
  expect(secondEvents).toHaveLength(1);
  expect(secondEvents[0]).toContain('dependency bump');
  expect(reviewInputs[1].existing.proposals).toHaveLength(1);
  expect(JSON.stringify(reviewInputs[1])).not.toContain('stranger');

  await toolResult(sessionB, 'build failed with stale cache; cleared it, tests pass');
  const third = await runCheck(sessionB, 'plan_completed');
  expect(third.result).toMatchObject({ outputs: [{ kind: 'skill', status: 'merged' }] });

  const mine = (await getDb().select().from(skillProposals)).filter(row => row.userId === userId);
  expect(mine).toHaveLength(1);
  expect(mine[0]).toMatchObject({ status: 'pending', exemplarCount: 3, signal: 'recovery' });
  expect(new Set(mine[0].sourceRefs.map(ref => ref.split(':session:')[1]))).toEqual(new Set([sessionA, sessionB]));

  // A manual check reads the whole window again.
  await runCheck(sessionA, 'manual');
  expect(reviewInputs[3].evidence.filter(row => row.kind === 'execution')).toHaveLength(3);
});
