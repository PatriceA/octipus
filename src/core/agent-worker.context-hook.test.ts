import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AgentWorker } from '@/core/agent-worker';
import { getAgentHooks, HookFailedError } from '@/core/agent/hooks';
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

  test('a throwing handler fails the request (fail-closed): nothing is sent, the error names the hook', async () => {
    getAgentHooks().register('context', (c) => {
      c.messages[1].content = 'my key is [redacted]';
      c.messages[3].content = 'half-done';
      throw new Error('broken extension');
    });
    const after = vi.fn();
    getAgentHooks().register('context', after);
    const w = new AgentWorker(ctx, cfg) as unknown as Priv;
    w.messages = stored.map((m) => ({ ...m }));
    const err = await w.getCompletion().then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(HookFailedError);
    expect((err as Error).message).toBe('context hook failed: broken extension');
    expect(sent).toHaveLength(0);
    expect(after).not.toHaveBeenCalled();
    expect(w.messages.map((m) => m.content)).toEqual(stored.map((m) => m.content));
  });

  test('an uncloneable conversation fails the request: nothing is sent unhooked', async () => {
    const handler = vi.fn((c: { messages: AgentMessage[] }) => { c.messages[1].content = 'mutated'; });
    getAgentHooks().register('context', handler);
    vi.spyOn(globalThis, 'structuredClone').mockImplementation(() => { throw new DOMException('could not be cloned', 'DataCloneError'); });
    const w = new AgentWorker(ctx, cfg) as unknown as Priv;
    w.messages = stored.map((m) => ({ ...m }));
    const err = await w.getCompletion().then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(HookFailedError);
    expect((err as Error).message).toMatch(/^context hook failed: the conversation cannot be copied/);
    expect(handler).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
    expect(w.messages[1].content).toBe('my key is sk-SECRET');
  });
});

describe('context hook and signed reasoning', () => {
  const thinking = (n: number) => ({ anthropicContent: [{ type: 'thinking', thinking: `t${n}`, signature: `sig${n}` }, { type: 'text', text: `a${n}` }] });
  beforeEach(() => {
    stored = [
      { role: 'system', content: 'You are helpful.', timestamp: new Date() },
      { role: 'user', content: 'q1', timestamp: new Date() },
      { role: 'assistant', content: 'a1', providerRaw: thinking(1), timestamp: new Date() },
      { role: 'user', content: 'q2', timestamp: new Date() },
      { role: 'assistant', content: 'a2', providerRaw: thinking(2), timestamp: new Date() },
      { role: 'user', content: 'q3', timestamp: new Date() },
    ];
  });
  const signed = () => (sent[0] as Array<{ providerRaw?: { anthropicContent?: Array<{ type: string }> } }>)
    .map((m) => m.providerRaw?.anthropicContent?.some((b) => b.type === 'thinking') ?? false);

  test('appending or editing only the newest message keeps every signed block', async () => {
    getAgentHooks().register('context', (c) => {
      c.messages.at(-1)!.content = 'q3 (redacted)';
      c.messages.push({ role: 'user', content: 'reminder', timestamp: new Date() });
    });
    await request();
    expect(signed()).toEqual([false, false, true, false, true, false, false]);
  });

  test('an edit to an earlier turn drops signed reasoning from that message on, in the request only', async () => {
    getAgentHooks().register('context', (c) => { c.messages[3].content = 'q2 (redacted)'; });
    const w = await request();
    expect(signed()).toEqual([false, false, true, false, false, false]);
    // The stored conversation keeps its reasoning.
    expect(w.messages[4].providerRaw).toEqual(thinking(2));
  });

  test('an edited assistant turn loses its own signed reasoning', async () => {
    getAgentHooks().register('context', (c) => { c.messages[2].content = 'a1 (rewritten)'; });
    const w = await request();
    expect(signed()).toEqual([false, false, false, false, false, false]);
    expect(w.messages[2].providerRaw).toEqual(thinking(1));
  });
});
