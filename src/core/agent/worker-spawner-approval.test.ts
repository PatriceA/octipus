import { beforeEach, describe, expect, test, vi } from 'vitest';
import { APPROVAL_DISCONNECT_REASON, APPROVAL_TIMEOUT_REASON } from '@/core/approval-wait';

const resolveModel = vi.hoisted(() => vi.fn());
const retry = vi.hoisted(() => ({ spawn: vi.fn(), delay: vi.fn(async (_delay: number, _value?: unknown, _options?: { signal?: AbortSignal }) => undefined) }));
vi.mock('@/core/agent-manager', () => ({ getAgentManager: () => ({ spawn: retry.spawn }) }));
vi.mock('node:timers/promises', () => ({ setTimeout: retry.delay }));
beforeEach(() => { resolveModel.mockReset(); retry.spawn.mockReset(); retry.delay.mockReset().mockResolvedValue(undefined); });
vi.mock('@/models/resolve-model', () => ({ resolveModel }));
vi.mock('@/core/notification-service', () => ({ getNotificationService: () => ({ notify: async () => undefined }) }));

describe('an abandoned approval wait leaves the worker spawner unchanged (#12/#20)', () => {
  test.each([APPROVAL_TIMEOUT_REASON, APPROVAL_DISCONNECT_REASON])('%s is neither a user stop nor retried', async reason => {
    const { handleWorkerFailure } = await import('./worker-spawner');
    // The CLI worker stops itself to end the wait, so its status is `stopped`.
    const worker = { getTotalTokens: () => 0, getBillableTokens: () => 0, getStatus: () => 'stopped' };
    const emit = vi.fn();
    const failure = handleWorkerFailure(new Error(reason), worker as never, 'w1', 'model', 'qa' as never, {} as never,
      'qa', 'task', '', { id: 'root-context', userId: 'u', sessionId: 's' } as never, Date.now(),
      { emit, modelSelector: {} as never }, {} as never);
    await expect(failure).rejects.toThrow(reason);
    expect(resolveModel).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'failed', error: reason }) }));
  });
});


const failedWorker = () => ({ getTotalTokens: () => 0, getBillableTokens: () => 0, getStatus: () => 'failed' });
const retryWorker = (run: () => Promise<string>) => ({ run, getBillableTokens: () => 5, getTotalTokens: () => 5,
  getPartialOutput: () => '', getContext: () => ({ id: 'retry' }), getIteration: () => 1, getSideEffectCounters: () => null });
const fail = async (message: string, options: Record<string, unknown> = {}) => {
  const { handleWorkerFailure } = await import('./worker-spawner');
  return handleWorkerFailure(new Error(message), failedWorker() as never, 'original', 'primary', 'qa' as never, {} as never,
    'qa', 'check', '', { id: 'root-context', userId: 'u', sessionId: 's' } as never, Date.now(),
    { emit: vi.fn(), modelSelector: {} as never }, { modelName: 'primary-row', systemPrompt: 'QA', tools: [], ...options } as never);
};

test('capacity retries stay inside the attempt, back off, then use the configured Backup (#40/#44)', async () => {
  const message = 'Selected model is at capacity. Please try a different model.';
  let attempt = 0;
  retry.spawn.mockImplementation(async () => retryWorker(async () => { if (++attempt <= 3) throw new Error(message); return 'QA passed'; }));
  resolveModel.mockResolvedValue({ modelId: 'backup', name: 'backup-row', provider: 'alternate' });
  const charged = vi.fn();
  expect(await fail(message, { onTokens: charged })).toBe('QA passed');
  expect(retry.delay.mock.calls.map(call => call[0])).toEqual([1000, 2000, 4000]);
  expect(retry.spawn.mock.calls.map(call => call[0].model)).toEqual(['primary', 'primary', 'primary', 'backup']);
  expect(charged.mock.calls.reduce((sum, call) => sum + call[0], 0)).toBe(20);
});
test('multi-day quota exhaustion uses the configured alternate immediately (#38)', async () => {
  retry.spawn.mockResolvedValue(retryWorker(async () => 'QA passed'));
  resolveModel.mockResolvedValue({ modelId: 'backup', name: 'backup-row', provider: 'alternate' });
  expect(await fail("You've hit your usage limit. Try again at Oct 27th, 2026 9:20 AM")).toBe('QA passed');
  expect(retry.delay).not.toHaveBeenCalled();
  expect(retry.spawn.mock.calls[0][0].model).toBe('backup');
});
test('a stop during backoff cannot restart a stage worker', async () => {
  const controller = new AbortController();
  retry.delay.mockImplementation(async () => { controller.abort(); throw new Error('aborted during backoff'); });
  await expect(fail('workspace routing discovery failed', { signal: controller.signal })).rejects.toThrow('aborted');
  expect(retry.spawn).not.toHaveBeenCalled();
  expect(resolveModel).not.toHaveBeenCalled();
});
test('a permission denial from a retry cannot switch provider to bypass it', async () => {
  retry.spawn.mockResolvedValue(retryWorker(async () => { throw new Error('Permission denied'); }));
  await expect(fail('workspace routing discovery failed')).rejects.toThrow('Permission denied');
  expect(resolveModel).not.toHaveBeenCalled();
});


test('malformed JSON retries the primary before falling back to the configured backup', async () => {
  let attempt = 0;
  retry.spawn.mockImplementation(async () => retryWorker(async () => {
    if (++attempt <= 3) throw new SyntaxError('Unterminated string in JSON at position 512');
    return 'QA passed';
  }));
  resolveModel.mockResolvedValue({ modelId: 'backup', name: 'backup-row', provider: 'alternate' });
  expect(await fail('Unexpected end of JSON input')).toBe('QA passed');
  expect(retry.delay.mock.calls.map(call => call[0])).toEqual([1000, 2000, 4000]);
  expect(retry.spawn.mock.calls.map(call => call[0].model)).toEqual(['primary', 'primary', 'primary', 'backup']);
});

test('provider retries rebind stage delegation to the replacement worker before run', async () => {
  const ready = vi.fn();
  const replacement = retryWorker(async () => { expect(ready).toHaveBeenCalledWith(replacement); return 'QA passed'; });
  retry.spawn.mockResolvedValue(replacement);
  expect(await fail('workspace routing discovery failed', { onWorkerReady: ready })).toBe('QA passed');
  expect(ready).toHaveBeenCalledOnce();
});


test('a provider retry includes its detached children in stage evidence', async () => {
  const { swarmNodeRepository } = await import('@/core/swarm/node-repository');
  const { emptyCounters } = await import('@/core/swarm/receipt');
  const childEffects = { ...emptyCounters(), toolCalls: 3, commandsRun: 3, byName: { shell__run: 3 }, uncertainActionIds: ['child-recovery-record'] };
  const descendants = vi.spyOn(swarmNodeRepository, 'findDescendants').mockResolvedValue([{ result: { receipt: { sideEffects: childEffects } } }] as never);
  const own = { ...emptyCounters(), toolCalls: 2, byName: { spawn_child: 1, collect_children: 1 } };
  retry.spawn.mockResolvedValue({ ...retryWorker(async () => 'Delegated gates finished'), getSideEffectCounters: () => own });
  const counters = vi.fn();
  try {
    expect(await fail('workspace routing discovery failed', { hasSwarmParent: true, onCounters: counters })).toBe('Delegated gates finished');
    expect(descendants).toHaveBeenCalledWith('retry');
    expect(counters).toHaveBeenCalledWith(expect.objectContaining({ commandsRun: 3, toolCalls: 5, uncertainActionIds: ['child-recovery-record'] }));
  } finally { descendants.mockRestore(); }
});
