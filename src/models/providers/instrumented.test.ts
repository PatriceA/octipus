import { beforeEach, describe, expect, test, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ log: vi.fn(), lookup: vi.fn() }));
vi.mock('../cost-tracker', () => ({ getCostTracker: () => ({ logUsageWithCost: mocks.log }) }));
vi.mock('../model-registry', () => ({ getModelRegistry: () => ({ getModel: mocks.lookup, getModelByModelId: mocks.lookup }) }));
import { instrumentProvider, SYSTEM_USAGE_USER, withProviderUsageContext } from './instrumented';
import type { CompletionOptions, CompletionResult } from '../litellm-client';
import type { ModelProvider } from './interface';
const options: CompletionOptions = { model: 'test', messages: [], userId: '11111111-1111-1111-1111-111111111111', sessionId: '22222222-2222-2222-2222-222222222222' };
const result: CompletionResult = { content: 'ok', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, reportedCost: 0 }, model: 'actual', latencyMs: 1 };
function provider(): ModelProvider {
  return { name: 'openai', type: 'direct', supportsModel: () => true, checkHealth: async () => ({ healthy: true }),
    complete: vi.fn(async () => result), stream: async function* () { yield { content: 'ok' }; yield { usage: result.usage }; } };
}
beforeEach(() => { vi.clearAllMocks(); mocks.lookup.mockResolvedValue({ metadata: { extraBody: { think: false } } }); mocks.log.mockResolvedValue({}); });
describe('provider accounting boundary', () => {
  test('one completion row with session attribution and legitimate zero charge', async () => {
    const p = instrumentProvider(provider());
    expect(await p.complete(options)).toBe(result);
    expect(mocks.log).toHaveBeenCalledOnce();
    expect(mocks.log.mock.calls[0][4]).toMatchObject({ reportedCost: 0, sessionId: options.sessionId });
  });
  test('does not reintroduce worker-suppressed extraBody flags', async () => {
    const p = provider(); const complete = p.complete;
    await instrumentProvider(p).complete(options);
    expect((complete as any).mock.calls[0][0].extraBody).not.toHaveProperty('think');
  });
  test('settings DB failure does not block a prepared request', async () => {
    mocks.lookup.mockRejectedValue(new Error('offline'));
    expect(await instrumentProvider(provider()).complete(options)).toBe(result);
  });
  test('ledger failure never replays or loses a successful completion', async () => {
    mocks.log.mockRejectedValue(new Error('offline'));
    const p = provider(); const complete = p.complete;
    expect(await instrumentProvider(p).complete(options)).toBe(result);
    expect(complete).toHaveBeenCalledOnce();
  });
  test('one stream row, terminal counters replace rather than add', async () => {
    const p = instrumentProvider(provider());
    for await (const _ of p.stream(options)) { /* drain */ }
    expect(mocks.log).toHaveBeenCalledOnce();
    expect(mocks.log.mock.calls[0].slice(2, 4)).toEqual([10, 2]);
  });
  test('cancelled stream without final usage records unknown usage', async () => {
    for await (const _ of instrumentProvider(provider()).stream(options)) break;
    expect(mocks.log).toHaveBeenCalledOnce();
    expect(mocks.log.mock.calls[0][4]).toMatchObject({ usageAvailable: false, metadata: { incomplete: true } });
  });
  test('invalid user IDs are explicitly unattributed', async () => {
    await instrumentProvider(provider()).complete({ ...options, userId: 'system' });
    expect(mocks.log.mock.calls[0][0]).toBe(SYSTEM_USAGE_USER);
    expect(mocks.log.mock.calls[0][4].metadata.unattributed).toBe(true);
  });
});

test('records a billable response even when tool argument decoding fails', async () => {
  const p = provider();
  p.complete = async opts => { opts.accountingResponse?.(result); throw new Error('bad tool JSON'); };
  await expect(instrumentProvider(p).complete(options)).rejects.toThrow('bad tool');
  expect(mocks.log).toHaveBeenCalledOnce();
  expect(mocks.log.mock.calls[0][4].metadata.incomplete).toBe(true);
});
test('stream-to-completion fallback does not double count', async () => {
  const p = provider();
  p.stream = async function* (opts) { const r = await this.complete(opts); yield { usage: r.usage, finishReason: r.finishReason }; };
  for await (const _ of instrumentProvider(p).stream(options)) { /* drain */ }
  expect(mocks.log).toHaveBeenCalledOnce();
});
test('tool and document calls inherit attribution without global cross-user state', async () => {
  await Promise.all(['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'].map(userId =>
    withProviderUsageContext({ userId, sessionId: options.sessionId }, () => instrumentProvider(provider()).complete({ model: 'test', messages: [] }))));
  expect(mocks.log.mock.calls.map(c => c[0]).sort()).toEqual(['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222']);
});

test('CLI completion inherits tool attribution and records once', async () => {
  const p = provider();
  Object.assign(p, { name: 'cli', type: 'cli' });
  await withProviderUsageContext({ userId: options.userId, sessionId: options.sessionId }, () => instrumentProvider(p).complete({ model: 'test', messages: [] }));
  expect(mocks.log).toHaveBeenCalledOnce();
  expect(mocks.log.mock.calls[0][0]).toBe(options.userId);
  expect(mocks.log.mock.calls[0][4]).toMatchObject({ sessionId: options.sessionId });
});
