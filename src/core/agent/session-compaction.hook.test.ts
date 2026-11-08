import { afterEach, beforeEach, expect, test, vi } from 'vitest';

/**
 * `compact:before` on the session checkpoint path (`/compact` and the
 * automatic pass between turns): a supplied summary is what the checkpoint
 * stores, and the model summariser is not called.
 */

const mocks = vi.hoisted(() => ({ history: vi.fn(), patch: vi.fn(), insert: vi.fn() }));
vi.mock('@/core/cli-compaction', () => ({ rootCliConversation: async () => null, compactCliConversation: vi.fn() }));
vi.mock('@/core/session-history', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/session-history')>()),
  withSessionConversation: async (_id: string, run: () => unknown) => run(),
  readSessionHistory: mocks.history,
}));
vi.mock('@/db/repositories/session-repository', () => ({
  sessionRepository: { findById: async () => session, patchContextIfGeneration: mocks.patch },
}));
vi.mock('@/db/repositories/compaction-entry-repository', () => ({ compactionEntryRepository: { insert: mocks.insert } }));
vi.mock('@/core/protection/routing', () => ({ localRowInstead: async () => null, PSEUDONYMIZED: 'pseudonymized' }));
vi.mock('./audience', async (importOriginal) => {
  const real = await importOriginal<typeof import('./audience')>();
  return { ...real, sessionAudience: async () => real.audienceOf('personal') };
});

import { getAgentHooks } from '@/core/agent/hooks';
import { getLiteLLMClient } from '@/models/litellm-client';
import { getModelRegistry } from '@/models/model-registry';
import { maybeCompactSession } from './session-compaction';

const session = { id: 'sess', userId: 'owner', workspaceId: null, kind: 'chat', context: {} };
const rows = Array.from({ length: 10 }, (_, i) => ({
  id: `r${i}`, role: i % 2 ? 'assistant' : 'user', content: `turn ${i} ${'x'.repeat(200)}`, createdAt: new Date(2026, 0, 1, 0, i), metadata: {},
}));

let complete: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.history.mockResolvedValue({ session, rows, generation: 0, checkpoint: undefined, messages: [] });
  mocks.patch.mockResolvedValue(true);
  mocks.insert.mockResolvedValue({ id: 'entry-1' });
  vi.spyOn(getModelRegistry(), 'getDefaultModel').mockResolvedValue({ name: 'm', modelId: 'm', contextWindow: 100_000 } as never);
  complete = vi.fn(async () => ({ content: 'model summary', toolCalls: [], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, model: 'm', latencyMs: 1 }));
  vi.spyOn(getLiteLLMClient(), 'complete').mockImplementation(complete as never);
});
afterEach(() => { vi.restoreAllMocks(); getAgentHooks()._clearForTesting(); });

test('/compact: the hook supplies the checkpoint summary and the model is not called', async () => {
  const seen: Array<{ source: string; sessionId: string; userId: string; instructions?: string; count: number }> = [];
  getAgentHooks().register('compact:before', (c) => {
    seen.push({ source: c.source, sessionId: c.agent.sessionId, userId: c.agent.userId, instructions: c.userInstructions, count: c.messagesToSummarize.length });
    c.summary = 'summary from the hook';
  });
  expect(await maybeCompactSession('sess', { force: true, userInstructions: 'keep decisions' })).toBe(true);
  expect(complete).not.toHaveBeenCalled();
  expect(seen).toEqual([{ source: 'session', sessionId: 'sess', userId: 'owner', instructions: 'keep decisions', count: 4 }]);
  expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({ summary: 'summary from the hook' }));
  expect(mocks.patch).toHaveBeenCalledWith('sess', 0, expect.objectContaining({
    checkpoint: expect.objectContaining({ summary: expect.stringContaining('summary from the hook') }),
  }), expect.anything());
});

test('a throwing handler falls back to the model summariser', async () => {
  getAgentHooks().register('compact:before', () => { throw new Error('broken extension'); });
  expect(await maybeCompactSession('sess', { force: true })).toBe(true);
  expect(complete).toHaveBeenCalled();
  expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({ summary: 'model summary' }));
});
