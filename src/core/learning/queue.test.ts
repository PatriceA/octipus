import { beforeEach, expect, test, vi } from 'vitest';
const mock = vi.hoisted(() => ({ claim: vi.fn(), process: vi.fn(), model: vi.fn(), create: vi.fn(), session: vi.fn(), rows: [] as unknown[][] }));
vi.mock('@/db/repositories/background-job-repository', () => ({ backgroundJobRepository: { claimNext: mock.claim, create: mock.create } }));
vi.mock('@/db/repositories/session-repository', () => ({ sessionRepository: { findById: mock.session } }));
vi.mock('@/core/rooms/access', () => ({ canActInSession: async () => true }));
// Each select resolves to the next queued result: the session's latest check, then the tool-call count.
vi.mock('@/db/postgres', () => ({ getDb: () => ({ select: () => {
  const result = Promise.resolve(mock.rows.shift() ?? []);
  const query = { from: () => query, where: () => query, orderBy: () => query, limit: () => result,
    then: (resolve: (rows: unknown[]) => unknown, reject: (err: unknown) => unknown) => result.then(resolve, reject) };
  return query;
} }) }));
vi.mock('./processor', () => ({ processLearningJob: mock.process }));
vi.mock('@/models/model-registry', () => ({ getModelRegistry: () => ({ getModelForTopic: mock.model }) }));
vi.mock('@/config', () => ({ getConfig: () => ({ learning: { localIdleMs: 60_000, reviewEveryToolCalls: 10, minReviewIntervalMinutes: 30 }, ollama: { url: 'http://localhost:11434' } }) }));
import { drainLearningQueue, enqueueTurnLearning } from './queue';
import { getRateLimitManager, resetRateLimitManager } from '@/models/rate-limiter';
beforeEach(() => { vi.resetAllMocks(); resetRateLimitManager(); mock.model.mockResolvedValue(null); });
test('drains persisted queued checks without overlap', async () => {
  let release!: () => void;
  mock.claim.mockResolvedValueOnce({ id: 'saved-before-restart' }).mockResolvedValueOnce({ id: 'next' }).mockResolvedValue(null);
  mock.process.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  const first = drainLearningQueue();
  await vi.waitFor(() => expect(mock.process).toHaveBeenCalledTimes(1));
  await drainLearningQueue();
  expect(mock.claim).toHaveBeenCalledTimes(1);
  release(); await first;
  expect(mock.process).toHaveBeenCalledTimes(2);
  expect(mock.claim).toHaveBeenCalledWith('learning');
});
test('database failure releases the drainer so the next tick can retry', async () => {
  mock.claim.mockRejectedValueOnce(new Error('DB temporarily unavailable')).mockResolvedValue(null);
  await drainLearningQueue(); await drainLearningQueue();
  expect(mock.claim).toHaveBeenCalledTimes(2);
});
test('a review on a local model waits until that provider has been idle', async () => {
  mock.model.mockResolvedValue({ provider: 'ollama', modelId: 'qwen', endpoint: 'http://localhost:11434', metadata: {} });
  mock.claim.mockResolvedValue(null);
  const token = await getRateLimitManager().acquire('ollama');
  await drainLearningQueue();
  expect(mock.claim).not.toHaveBeenCalled();          // a turn is using the GPU
  token.release();
  await drainLearningQueue();
  expect(mock.claim).not.toHaveBeenCalled();          // released a moment ago: not idle yet
  resetRateLimitManager();
  await drainLearningQueue();
  expect(mock.claim).toHaveBeenCalledWith('learning'); // never used: idle
});
test('a review on a remote model is not deferred', async () => {
  mock.model.mockResolvedValue({ provider: 'openrouter', modelId: 'x', metadata: {} });
  mock.claim.mockResolvedValue(null);
  await getRateLimitManager().acquire('openrouter');
  await drainLearningQueue();
  expect(mock.claim).toHaveBeenCalledWith('learning');
});

test('the tool-count review waits out the interval after the session\'s previous check', async () => {
  mock.session.mockResolvedValue({ id: 's1', userId: 'u1', workspaceId: 'w1' });
  const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
  mock.rows = [[{ payload: { through: minutesAgo(10).toISOString() }, createdAt: minutesAgo(10) }], [{ n: 50 }]];
  await enqueueTurnLearning('s1', 'u1', 'a1');
  expect(mock.create).not.toHaveBeenCalled(); // 50 tool calls, but only 10 minutes since the last check
  mock.rows = [[{ payload: { through: minutesAgo(31).toISOString() }, createdAt: minutesAgo(31) }], [{ n: 9 }]];
  await enqueueTurnLearning('s1', 'u1', 'a1');
  expect(mock.create).not.toHaveBeenCalled(); // interval passed, too few tool calls
  mock.rows = [[{ payload: { through: minutesAgo(31).toISOString() }, createdAt: minutesAgo(31) }], [{ n: 10 }]];
  await enqueueTurnLearning('s1', 'u1', 'a1');
  expect(mock.create).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ trigger: 'substantial_turn' }) }));
  mock.create.mockClear();
  mock.rows = [[], [{ n: 10 }]]; // the session's first check is not held back
  await enqueueTurnLearning('s1', 'u1', 'a1');
  expect(mock.create).toHaveBeenCalledTimes(1);
});
