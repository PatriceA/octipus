import { beforeEach, expect, test, vi } from 'vitest';
const mock = vi.hoisted(() => ({ claim: vi.fn(), process: vi.fn() }));
vi.mock('@/db/repositories/background-job-repository', () => ({ backgroundJobRepository: { claimNext: mock.claim } }));
vi.mock('./processor', () => ({ processLearningJob: mock.process }));
import { drainLearningQueue } from './queue';
beforeEach(() => { vi.resetAllMocks(); });
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
