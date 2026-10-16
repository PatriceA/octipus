import { describe, expect, test, vi } from 'vitest';
import { APPROVAL_DISCONNECT_REASON, APPROVAL_TIMEOUT_REASON } from '@/core/approval-wait';

const resolveModel = vi.hoisted(() => vi.fn());
vi.mock('@/models/resolve-model', () => ({ resolveModel }));
vi.mock('@/core/notification-service', () => ({ getNotificationService: () => ({ notify: async () => undefined }) }));

describe('an abandoned approval wait leaves the worker spawner unchanged (#12/#20)', () => {
  test.each([APPROVAL_TIMEOUT_REASON, APPROVAL_DISCONNECT_REASON])('%s is neither a user stop nor retried', async reason => {
    const { handleWorkerFailure } = await import('./worker-spawner');
    // The CLI worker stops itself to end the wait, so its status is `stopped`.
    const worker = { getTotalTokens: () => 0, getBillableTokens: () => 0, getStatus: () => 'stopped' };
    const emit = vi.fn();
    const failure = handleWorkerFailure(new Error(reason), worker as never, 'w1', 'model', 'qa' as never, {} as never,
      'qa', 'task', '', { userId: 'u', sessionId: 's' } as never, Date.now(),
      { emit, modelSelector: {} as never, setLastWorkerResult: () => {} }, {} as never);
    await expect(failure).rejects.toThrow(reason);
    expect(resolveModel).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'failed', error: reason }) }));
  });
});
