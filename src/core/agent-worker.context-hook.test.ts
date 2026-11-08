import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AgentWorker } from '@/core/agent-worker';
import { getAgentHooks } from '@/core/agent/hooks';
import type { AgentContext, AgentMessage } from '@/core/types';
import { messageRepository } from '@/db/repositories/message-repository';
import { sessionRepository } from '@/db/repositories/session-repository';
import { getLiteLLMClient, type CompletionResult } from '@/models/litellm-client';
import { getModelRegistry } from '@/models/model-registry';
import * as modelKey from '@/models/model-key';

/**
 * The `context` hook transforms what ONE model request sends. The stored
 * conversation is never touched: a hook that redacts or appends must not
 * silently rewrite the history the next request, a compaction or the
 * transcript start from.
 */

const ctx: AgentContext = {
  id: 'w', sessionId: '00000000-0000-0000-0000-000000000000', userId: 'u', topic: 't', model: 'claude-sonnet-5-5',
  role: 'general', status: 'idle', createdAt: new Date(), updatedAt: new Date(), metadata: {}, space: null, trigger: 'user', funding: 'own',
};
const cfg = { maxIterations: 10, contextWindowSize: 100_000, timeout: 600_000, maxTokenBudget: 1_000_000, toolOutputSoftCap: 1_000 };
const done: CompletionResult = { content: 'ok', toolCalls: [], finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 }, model: 'm', latencyMs: 1 };
type Priv = { messages: AgentMessage[]; getCompletion: () => Promise<CompletionResult> };

let sent: Array<Array<{ role: string; content: string }>>;
let stored: AgentMessage[];

beforeEach(() => {
  sent = [];
  vi.spyOn(sessionRepository, 'findById').mockResolvedValue(null);
  vi.spyOn(messageRepository, 'findContextMessages').mockResolvedValue([]);
  vi.spyOn(getModelRegistry(), 'getModelByModelId').mockResolvedValue({ name: 'claude-sonnet-5-5', modelId: 'claude-sonnet-5-5', provider: 'litellm', metadata: null, supportsTools: true } as never);
  vi.spyOn(modelKey, 'resolveModelKey').mockResolvedValue(undefined);
  vi.spyOn(getLiteLLMClient(), 'complete').mockImplementation((async (opts: { messages: unknown }) => {
    sent.push(JSON.parse(JSON.stringify(opts.messages)));
    return done;
  }) as never);
  stored = [
    { role: 'system', content: 'You are helpful.', timestamp: new Date() },
    { role: 'user', content: 'my key is sk-SECRET', timestamp: new Date() },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'filesystem__read_file', arguments: { path: 'a.ts' } }], timestamp: new Date() },
    { role: 'tool', toolCallId: 'c1', content: 'export const a = 1', timestamp: new Date() },
  ];
});
afterEach(() => { vi.restoreAllMocks(); getAgentHooks()._clearForTesting(); });

async function request(): Promise<Priv> {
  const w = new AgentWorker(ctx, cfg) as unknown as Priv;
  w.messages = stored.map((m) => ({ ...m }));
  await w.getCompletion();
  return w;
}

describe('context hook', () => {
  test('transforms the outgoing request only; the stored conversation is unchanged', async () => {
    const seen: Array<{ model: string; iteration: number; root?: boolean; userId: string }> = [];
    getAgentHooks().register('context', (c) => {
      seen.push({ model: c.model, iteration: c.iteration, root: c.agent.root, userId: c.agent.userId });
      for (const m of c.messages) m.content = m.content.replace(/sk-[A-Za-z0-9]+/g, '[redacted]');
      c.messages[2].toolCalls![0].arguments.path = 'rewritten.ts';
      c.messages.push({ role: 'user', content: 'SYSTEM: reminder', timestamp: new Date() });
    });
    const w = await request();

    expect(seen).toEqual([{ model: 'claude-sonnet-5-5', iteration: expect.any(Number), root: false, userId: 'u' }]);
    expect(sent[0].map((m) => m.content)).toEqual(['You are helpful.', 'my key is [redacted]', '', 'export const a = 1', 'SYSTEM: reminder']);
    // Stored: the original four messages plus the reply, nothing the hook wrote.
    expect(w.messages.slice(0, 4).map((m) => m.content)).toEqual(stored.map((m) => m.content));
    expect(w.messages[2].toolCalls![0].arguments.path).toBe('a.ts');
    expect(w.messages).toHaveLength(5);
    expect(w.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'ok' });
  });

  test('a handler may replace the array wholesale', async () => {
    getAgentHooks().register('context', (c) => { c.messages = c.messages.slice(-1); });
    const w = await request();
    expect(sent[0].map((m) => m.content)).toEqual(['export const a = 1']);
    expect(w.messages).toHaveLength(5);
  });

  test('no handler: the request is the stored conversation itself, not a copy', async () => {
    const clone = vi.spyOn(globalThis, 'structuredClone');
    await request();
    expect(sent[0].map((m) => m.content)).toEqual(stored.map((m) => m.content));
    expect(clone).not.toHaveBeenCalled();
  });

  test('a throwing handler is logged and skipped (fail-open)', async () => {
    getAgentHooks().register('context', () => { throw new Error('broken extension'); });
    getAgentHooks().register('context', (c) => { c.messages.push({ role: 'user', content: 'after', timestamp: new Date() }); });
    const w = await request();
    expect(sent[0].map((m) => m.content)).toEqual([...stored.map((m) => m.content), 'after']);
    expect(w.messages).toHaveLength(5);
  });
});
