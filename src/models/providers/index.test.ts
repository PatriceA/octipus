import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// instrumentProvider (wrapping every registered provider) persists usage via
// the real cost tracker, which needs a DB. Stub it out — this test is about
// the completion log, not accounting.
vi.mock('../cost-tracker', () => ({ getCostTracker: () => ({ logUsageWithCost: vi.fn(async () => ({})) }) }));

// Pure unit test: proves the 'LLM completion' log line in ProviderRouter.complete()
// (src/models/providers/index.ts) carries cacheReadTokens/cacheCreationTokens.
// Env vars mirror litellm-client.test.ts so the real config/logger load cleanly.
const rand = (n: number) => randomBytes(n).toString('hex');
process.env.LOG_LEVEL ??= 'error';
process.env.NODE_ENV ??= 'test';
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;

const TEST_MODEL = 'zzz-test-cache-model';

// Only AnthropicProvider is faked — every other constituent provider is the
// real class (constructors here do no I/O), it just won't claim this model.
vi.mock('./anthropic-provider', async () => {
  const actual = await vi.importActual<typeof import('./anthropic-provider')>('./anthropic-provider');
  class FakeAnthropicProvider {
    name = 'anthropic';
    type = 'direct';
    supportsModel(model: string) { return model === TEST_MODEL; }
    async complete() {
      return {
        model: TEST_MODEL,
        content: 'ok',
        usage: {
          inputTokens: 100,
          outputTokens: 10,
          totalTokens: 110,
          cacheReadTokens: 42,
          cacheCreationTokens: 7,
        },
        finishReason: 'stop',
      };
    }
    async *stream(): AsyncGenerator<never> {
      // Not exercised by this test — complete() is the path under test.
    }
  }
  return { ...actual, AnthropicProvider: FakeAnthropicProvider };
});

// Model-registry lookup (resolveProvider) fails fast — router falls back to
// the name-based heuristic, which is all this test needs.
vi.mock('@/models/model-registry', () => ({
  getModelRegistry: () => { throw new Error('not needed in this test'); },
}));

const { ProviderRouter } = await import('./index');
const { modelLogger } = await import('@/utils/logger');

describe('ProviderRouter.complete — LLM completion log', () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    infoSpy = vi.spyOn(modelLogger, 'info').mockImplementation(() => modelLogger as never);
  });

  afterEach(() => {
    infoSpy.mockRestore();
  });

  test('logs cacheReadTokens and cacheCreationTokens from the result usage', async () => {
    const router = new ProviderRouter();
    await router.complete({ model: TEST_MODEL, messages: [{ role: 'user', content: 'hi', timestamp: new Date() }] } as never);

    const completionCall = infoSpy.mock.calls.find((args: unknown[]) => args[1] === 'LLM completion');
    expect(completionCall).toBeDefined();
    const logObj = completionCall![0];
    expect(logObj).toMatchObject({ cacheReadTokens: 42, cacheCreationTokens: 7 });
  });
});
