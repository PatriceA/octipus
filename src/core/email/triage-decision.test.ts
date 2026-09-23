/**
 * Decision-model triage in shadow mode: the LLM result is what the user gets,
 * the decision model's answer is only compared — and an unbound/declined
 * decision model changes nothing.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { InboxItem } from './types';

let decision: unknown = null;
vi.mock('@/models/decision', () => ({ decide: vi.fn(async () => decision) }));
vi.mock('@/models/model-registry', async () => ({
  ...(await vi.importActual<typeof import('@/models/model-registry')>('@/models/model-registry')),
  getModelRegistry: () => ({ getModelForTopic: async () => ({ modelId: 'chat-model' }) }),
}));
vi.mock('@/models/litellm-client', async () => ({
  ...(await vi.importActual<typeof import('@/models/litellm-client')>('@/models/litellm-client')),
  getLiteLLMClient: () => ({ complete: async () => ({ content: '{"m1":{"priority":"high","category":"work","reason":"r"}}' }) }),
}));

const { triageInbox } = await import('./service');
const item: InboxItem = { id: 'm1', provider: 'google', from: { email: 'a@b.c' }, subject: 's', snippet: 'x', receivedAt: '', unread: true };

describe('triageInbox with a decision model (shadow)', () => {
  beforeEach(() => { decision = null; });

  test('no decision model → LLM triage unchanged', async () => {
    expect(await triageInbox('u', [item])).toEqual({ m1: { priority: 'high', category: 'work', reason: 'r' } });
  });

  test('decision model answers → still returns the LLM result', async () => {
    decision = {
      priority: { type: 'score', score: 0.1, probabilities: {}, confidence: 0.9 },
      category: { type: 'choice', choice: 'promotion', probabilities: {}, confidence: 0.9 },
    };
    expect((await triageInbox('u', [item])).m1.priority).toBe('high');
  });
});
