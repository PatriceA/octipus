import { beforeEach, expect, test, vi } from 'vitest';
const mock = vi.hoisted(() => ({ claim: vi.fn(), process: vi.fn(), model: vi.fn() }));
vi.mock('@/db/repositories/background-job-repository', () => ({ backgroundJobRepository: { claimNext: mock.claim } }));
vi.mock('./processor', () => ({ processLearningJob: mock.process }));
vi.mock('@/models/model-registry', () => ({ getModelRegistry: () => ({ getModelForTopic: mock.model }) }));
vi.mock('@/config', () => ({ getConfig: () => ({ learning: { localIdleMs: 60_000, reviewEveryToolCalls: 10 }, ollama: { url: 'http://localhost:11434' } }) }));
import { drainLearningQueue } from './queue';
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
