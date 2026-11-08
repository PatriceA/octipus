import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getAgentHooks } from '@/core/agent/hooks';
import type { AgentMessage } from '@/core/types';
import { getLiteLLMClient } from '@/models/litellm-client';
import { compactMessagesWithSummary, createLLMSummary, HOOK_SUMMARY_MAX_CHARS } from './context-compaction';

/**
 * `compact:before` lets a trusted extension supply the compaction summary
 * (Pi's `session_before_compact`). The in-loop path (`compactMessagesWithSummary`,
 * called by the agent worker) and the session checkpoint both summarise
 * through `createLLMSummary`, so the hook runs there.
 */

const msg = (role: AgentMessage['role'], content: string): AgentMessage => ({ role, content, timestamp: new Date() });
const history = (): AgentMessage[] => [
  msg('system', 'You are helpful.'),
  ...Array.from({ length: 12 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', `turn ${i} ${'x'.repeat(400)}`)),
];
const agent = { userId: 'u', sessionId: 's', role: 'general' };

let complete: ReturnType<typeof vi.fn>;
beforeEach(() => {
  complete = vi.fn(async () => ({ content: 'model summary', toolCalls: [], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, model: 'm', latencyMs: 1 }));
  vi.spyOn(getLiteLLMClient(), 'complete').mockImplementation(complete as never);
});
afterEach(() => { vi.restoreAllMocks(); getAgentHooks()._clearForTesting(); });

describe('compact:before', () => {
  test('in the agent loop: a supplied summary replaces the model summariser', async () => {
    const seen: Array<{ source: string; count: number; userId: string; instructions?: string }> = [];
    getAgentHooks().register('compact:before', (c) => {
      seen.push({ source: c.source, count: c.messagesToSummarize.length, userId: c.agent.userId, instructions: c.userInstructions });
      c.summary = '  custom summary  ';
    });
    const { messages, removed } = await compactMessagesWithSummary(history(), {
      maxTokens: 300, preserveSystemMessages: true, preserveRecentCount: 2, summaryModel: 'm', userId: 'u',
      hook: { source: 'agent', agent },
    });
    expect(removed).toBeGreaterThan(0);
    expect(complete).not.toHaveBeenCalled();
    expect(seen).toEqual([{ source: 'agent', count: expect.any(Number), userId: 'u', instructions: undefined }]);
    expect(seen[0].count).toBeGreaterThan(0);
    const summary = messages.find((m) => m.content.startsWith('[Context Summary'));
    // Packaged like a model summary: the header, the trimmed text.
    expect(summary?.content).toMatch(/^\[Context Summary - \d+ earlier messages compacted\]\n\ncustom summary$/);
  });

  test('a session checkpoint: the summary text, file ops and chained inputs reach the caller', async () => {
    let previous: string | undefined;
    getAgentHooks().register('compact:before', (c) => { previous = c.previousSummary; c.summary = 'checkpoint by hook'; });
    const removed = [msg('user', 'read it'), { ...msg('assistant', ''), toolCalls: [{ id: 'c', name: 'filesystem__read_file', arguments: { path: 'a.ts' } }] }];
    const result = await createLLMSummary(removed, 'm', {
      previousSummary: 'earlier', requireSuccess: true, userInstructions: 'keep decisions',
      hook: { source: 'session', agent },
    });
    expect(complete).not.toHaveBeenCalled();
    expect(previous).toBe('earlier');
    expect(result.summaryText).toBe('checkpoint by hook');
    expect(result.message.content).toContain('checkpoint by hook');
  });

  test('the messages a handler sees are a frozen copy', async () => {
    const input = [msg('user', 'original')];
    getAgentHooks().register('compact:before', (c) => {
      expect(() => { (c.messagesToSummarize[0] as AgentMessage).content = 'changed'; }).toThrow();
      c.summary = 'ok';
    });
    await createLLMSummary(input, 'm', { hook: { source: 'agent', agent } });
    expect(input[0].content).toBe('original');
  });

  test('a supplied summary is capped at the summariser budget', async () => {
    getAgentHooks().register('compact:before', (c) => { c.summary = 'y'.repeat(HOOK_SUMMARY_MAX_CHARS + 500); });
    const result = await createLLMSummary([msg('user', 'hi')], 'm', { hook: { source: 'agent', agent } });
    expect(result.summaryText.length).toBeLessThan(HOOK_SUMMARY_MAX_CHARS + 100);
    expect(result.summaryText).toMatch(/summary truncated\]$/);
  });

  test('a throwing handler, or an empty summary, falls back to the model summariser', async () => {
    getAgentHooks().register('compact:before', () => { throw new Error('broken extension'); });
    getAgentHooks().register('compact:before', (c) => { c.summary = '   '; });
    const result = await createLLMSummary([msg('user', 'hi'), msg('assistant', 'hello')], 'm', { requireSuccess: true, hook: { source: 'session', agent } });
    expect(complete).toHaveBeenCalled();
    expect(result.summaryText).toBe('model summary');
  });

  test('no handler: the model summariser runs as before', async () => {
    const result = await createLLMSummary([msg('user', 'hi'), msg('assistant', 'hello')], 'm', {});
    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.summaryText).toBe('model summary');
  });
});
