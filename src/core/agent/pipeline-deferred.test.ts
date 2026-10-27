import { beforeEach, expect, test, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ due: vi.fn(), resume: vi.fn(), find: vi.fn(), update: vi.fn() }));
vi.mock('@/db/repositories/pipeline-repository', () => ({ pipelineRepository: { dueDeferred: fixture.due, findById: fixture.find, updatePipeline: fixture.update } }));
vi.mock('./pipeline-manager', () => ({ getPipelineManager: () => ({ resume: fixture.resume }) }));
import { wakeDeferredPipelines } from './pipeline-deferred';
beforeEach(() => vi.resetAllMocks());
test('wakes due deferred runs once while a previous wake is running', async () => {
  let finish!: () => void;
  fixture.due.mockResolvedValue([{ id: 'p' }]);
  fixture.resume.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  await wakeDeferredPipelines();
  await wakeDeferredPipelines();
  expect(fixture.resume).toHaveBeenCalledTimes(1);
  finish();
  await vi.waitFor(() => expect(fixture.update).not.toHaveBeenCalled());
});
test('makes a wake error inspectable instead of looping retries', async () => {
  const row = { id: 'failed-wake', status: 'paused', metadata: { resumeAfter: '2026-11-10T11:40:18Z' } };
  fixture.due.mockResolvedValue([row]); fixture.find.mockResolvedValue(row);
  fixture.resume.mockRejectedValue(new Error('Recovery review unavailable'));
  await wakeDeferredPipelines();
  await vi.waitFor(() => expect(fixture.update).toHaveBeenCalledWith(row.id, { metadata: { ...row.metadata, deferredWakeError: 'Error: Recovery review unavailable' } }));
});
