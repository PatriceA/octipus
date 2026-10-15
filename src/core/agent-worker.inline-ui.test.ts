/**
 * The worker's one repair round for interactive answers (spec G3): a final
 * reply whose `octi-ui` block cannot be shown as written goes back to the
 * model once, in the same turn — with its draft in the history, so it can
 * rewrite it — and a second broken reply is returned as it is (extraction
 * then shows a notice in place of the block).
 *
 * Hermetic, like agent-worker.hardening.test.ts: the private `getCompletion`
 * is overridden, repositories are stubbed.
 */
import { beforeEach, expect, test, vi } from 'vitest';
import { AgentWorker } from '@/core/agent-worker';
import type { AgentContext } from '@/core/types';
import { messageRepository } from '@/db/repositories/message-repository';
import { sessionRepository } from '@/db/repositories/session-repository';
import type { CompletionResult } from '@/models/litellm-client';

beforeEach(() => {
  vi.spyOn(sessionRepository, 'findById').mockResolvedValue(null);
  vi.spyOn(sessionRepository, 'patchContextIfGeneration').mockResolvedValue(true);
  vi.spyOn(sessionRepository, 'incrementMessageCount').mockResolvedValue(undefined as never);
  vi.spyOn(messageRepository, 'findContextMessages').mockResolvedValue([]);
});

const ctx = (over: Partial<AgentContext> = {}): AgentContext => ({
  id: 'root-iu', sessionId: '00000000-0000-0000-0000-000000000000', userId: 'local', topic: 'test', model: 'test-model',
  role: 'general', status: 'idle', createdAt: new Date(), updatedAt: new Date(), metadata: { inlineUiOffered: true },
  space: null, trigger: 'user', funding: 'own', root: true, ...over,
});

const cfg = { maxIterations: 10, contextWindowSize: 100_000, timeout: 600_000, maxTokenBudget: 1_000_000, toolOutputSoftCap: 1_000 };

const completion = (content: string): CompletionResult => ({
  content, toolCalls: [], finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 }, model: 'test-model', latencyMs: 1,
});

const BROKEN = 'Here:\n```octi-ui title="Calc"\n<button onclick="go()">x</button>\n```';
const FIXED = 'Here:\n```octi-ui title="Calc"\n<button id="b" type="button">x</button>\n```';

type Msg = { role: string; content: string };

function drive(worker: AgentWorker, replies: string[]) {
  const priv = worker as unknown as { loop: () => Promise<string>; getCompletion: () => Promise<CompletionResult>; messages: Msg[]; startTime: number };
  priv.startTime = Date.now();
  const seen: Msg[][] = [];
  priv.getCompletion = async () => {
    seen.push(priv.messages.map((m) => ({ role: m.role, content: m.content })));
    return completion(replies.shift() ?? 'unexpected extra call');
  };
  return { run: () => priv.loop(), seen };
}

test('a block that cannot be shown goes back once, with the draft before the request to fix it', async () => {
  const { run, seen } = drive(new AgentWorker(ctx(), cfg), [BROKEN, FIXED]);
  expect(await run()).toBe(FIXED);
  expect(seen).toHaveLength(2);
  const [draft, ask] = seen[1].slice(-2);
  expect(draft).toEqual({ role: 'assistant', content: BROKEN });
  expect(ask.role).toBe('user');
  expect(ask.content).toContain('cannot be shown as written');
  expect(ask.content).toContain('inline event attributes');
});

test('only once: a second broken reply is returned as it is', async () => {
  const { run, seen } = drive(new AgentWorker(ctx(), cfg), [BROKEN, BROKEN]);
  expect(await run()).toBe(BROKEN);
  expect(seen).toHaveLength(2);
});

test('no repair where interactive answers are not offered, or for a child', async () => {
  for (const c of [ctx({ metadata: {} }), ctx({ root: false })]) {
    const { run, seen } = drive(new AgentWorker(c, cfg), [BROKEN]);
    expect(await run()).toBe(BROKEN);
    expect(seen).toHaveLength(1);
  }
});
