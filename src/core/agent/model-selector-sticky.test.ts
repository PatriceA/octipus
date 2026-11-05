/**
 * Per-message lane routing vs a warm conversation: a switch of model is a cold
 * prompt cache for the whole conversation, so within one the route is
 * followed only when it is a step up.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ModelConfigEntry } from '@/db/schema/models';
import type { SessionContext } from '@/db/schema/sessions';

const rows = vi.hoisted(() => ({
  everyday: { name: 'everyday-row', modelId: 'cheap-model', supportsTools: true, provider: 'openai', costPerInputToken: 1e-7, costPerOutputToken: 4e-7, isEnabled: true },
  coding: { name: 'coding-row', modelId: 'strong-model', supportsTools: true, provider: 'anthropic', costPerInputToken: 3e-6, costPerOutputToken: 1.5e-5, isEnabled: true },
} as Record<string, Partial<ModelConfigEntry>>));
vi.mock('@/models/resolve-model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/models/resolve-model')>()),
  resolveModel: async (req: { topic?: string; name?: string }) => (req.topic
    ? rows[req.topic] ?? null
    : Object.values(rows).find((r) => r.name === req.name || r.modelId === req.name) ?? null),
}));
vi.mock('@/models/install-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/models/install-access')>()),
  mayUseInstallModels: async () => true,
}));
import { ModelSelector, STICKY_LANE_MIN_CHARS, warmConversationOf } from './model-selector';

afterEach(() => vi.restoreAllMocks());

const route = (lane: string, conversation?: { name?: string; modelId: string }) =>
  new ModelSelector().selectForRootAgent('s1', 'task', { message: 'm', laneChoice: { lane, reason: 'test' } as never, conversation }, { userId: 'u1' });

describe('lane routing within a warm conversation', () => {
  test('a cheaper or equal lane keeps the conversation on its model', async () => {
    expect((await route('everyday', { name: 'coding-row', modelId: 'strong-model' })).name).toBe('coding-row');
  });
  test('a step up follows the route', async () => {
    expect((await route('coding', { name: 'everyday-row', modelId: 'cheap-model' })).name).toBe('coding-row');
  });
  test('without a warm conversation, or on the same model, the route decides', async () => {
    expect((await route('everyday')).name).toBe('everyday-row');
    expect((await route('everyday', { name: 'everyday-row', modelId: 'cheap-model' })).name).toBe('everyday-row');
  });
  test('a conversation model the requester can no longer use is not kept', async () => {
    expect((await route('everyday', { name: 'gone-row', modelId: 'gone' })).name).toBe('everyday-row');
  });
});

describe('warmConversationOf', () => {
  const big = 'x'.repeat(STICKY_LANE_MIN_CHARS);
  const native = (over: Partial<NonNullable<SessionContext['nativeConversation']>> = {}): SessionContext['nativeConversation'] => ({
    generation: '', model: 'strong-model', modelName: 'coding-row', ownerAgentId: 'a', acknowledged: { id: 'm', createdAt: '' },
    messages: [{ role: 'user', content: big, timestamp: '2030-01-01T00:00:00Z' }], ...over,
  });

  test('a saved conversation of the current generation and checkpoint, big enough to keep', () => {
    expect(warmConversationOf({ nativeConversation: native() })).toEqual({ name: 'coding-row', modelId: 'strong-model' });
    expect(warmConversationOf({ nativeConversation: native({ messages: [{ role: 'user', content: 'hi', timestamp: '' }] }) })).toBeUndefined();
    expect(warmConversationOf({ conversationGeneration: 'g2', nativeConversation: native() })).toBeUndefined();
    expect(warmConversationOf({ nativeConversation: native({ checkpointId: 'old' }) })).toBeUndefined();
  });

  test('a root vendor CLI session counts, a child one does not, and the latest wins', () => {
    const cliSessions = {
      'Claude Code': { id: 'v', fingerprint: 'f', lastUsedAt: '2030-01-02T00:00:00Z', generation: '', modelName: 'claude-cli-row' },
    } as SessionContext['cliSessions'];
    expect(warmConversationOf({ cliSessions, nativeConversation: native() })).toEqual({ name: 'claude-cli-row', modelId: 'claude-cli-row' });
    const childOnly = Object.fromEntries(Object.entries(cliSessions!).map(([k, v]) => [`${k}::child:x`, v]));
    expect(warmConversationOf({ cliSessions: childOnly })).toBeUndefined();
  });
});
