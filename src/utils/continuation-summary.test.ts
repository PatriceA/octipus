import { beforeEach, describe, expect, test, vi } from 'vitest';
const complete = vi.hoisted(() => vi.fn());
vi.mock('@/models/litellm-client', () => ({ getLiteLLMClient: () => ({ complete }) }));
import { createLLMSummary, SUMMARY_MAX_TOKENS, SUMMARY_MIN_TOKENS, summaryBudgetTokens } from './context-compaction';
import type { AgentMessage } from '@/core/types';

const msg = (role: AgentMessage['role'], content: string): AgentMessage => ({ role, content, timestamp: new Date() });
const conversation = [msg('system', 'stable system prompt'), msg('user', 'build it'), msg('assistant', 'done step one')];
const tools = [{ type: 'function' as const, function: { name: 'probe', description: 'p', parameters: { type: 'object', properties: {} } } }];
const continuation = { messages: conversation, tools, cacheScope: 'root:g1', cachePacing: 'human' as const, sessionId: 's1' };
beforeEach(() => complete.mockReset());

describe('summary as a continuation of the live conversation', () => {
  test('sends the conversation\'s own prefix and tools, the instruction last, one call', async () => {
    complete.mockResolvedValue({ content: '1. Goal: build it', finishReason: 'stop' });
    const result = await createLLMSummary(conversation.slice(1), 'claude-sonnet-5-5', { continuation, priority: 'interactive' });
    expect(complete).toHaveBeenCalledTimes(1);
    const sent = complete.mock.calls[0][0];
    // Byte-identical prefix: the same messages in the same order, then one more.
    expect(sent.messages.slice(0, conversation.length)).toEqual(conversation);
    expect(sent.messages).toHaveLength(conversation.length + 1);
    expect(sent.messages.at(-1)).toMatchObject({ role: 'user' });
    expect(sent.messages.at(-1).content).toContain('checkpoint summary');
    expect(sent).toMatchObject({ tools, cacheScope: 'root:g1', cachePacing: 'human', sessionId: 's1', priority: 'interactive', requestType: 'compaction' });
    // No tool_choice flip: Claude caches messages per tool_choice.
    expect(sent).not.toHaveProperty('toolChoice');
    expect(result.summaryText).toBe('1. Goal: build it');
  });

  test.each([
    ['a tool call', { content: '', toolCalls: [{ id: 'x', name: 'probe', arguments: {} }], finishReason: 'tool_calls' }],
    ['a cut-off reply', { content: 'partial', finishReason: 'length' }],
    ['an empty reply', { content: '  ', finishReason: 'stop' }],
  ])('falls back to the standalone summarizer on %s', async (_label, reply) => {
    complete.mockResolvedValueOnce(reply).mockResolvedValue({ content: 'standalone summary', finishReason: 'stop' });
    const result = await createLLMSummary(conversation.slice(1), 'm', { continuation });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1][0].messages[0].content).toContain('conversation summarizer');
    expect(result.summaryText).toBe('standalone summary');
  });

  test('a failing continuation call falls back too', async () => {
    complete.mockRejectedValueOnce(new Error('overloaded')).mockResolvedValue({ content: 'standalone summary', finishReason: 'stop' });
    expect((await createLLMSummary(conversation.slice(1), 'm', { continuation })).summaryText).toBe('standalone summary');
  });
});

describe('summary budget', () => {
  test('a fifth of the replaced history, within bounds, and the standalone prompt is structured', async () => {
    expect(summaryBudgetTokens([msg('user', 'short')])).toBe(SUMMARY_MIN_TOKENS);
    expect(summaryBudgetTokens([msg('user', 'word '.repeat(200_000))])).toBe(SUMMARY_MAX_TOKENS);
    complete.mockResolvedValue({ content: 'summary', finishReason: 'stop' });
    await createLLMSummary([msg('user', 'word '.repeat(1000))], 'm', {});
    const sent = complete.mock.calls.at(-1)![0];
    expect(sent.maxTokens).toBeGreaterThanOrEqual(SUMMARY_MIN_TOKENS);
    expect(sent.messages[1].content).toContain('Errors hit');
    expect(sent.messages[1].content).not.toContain('under 500 words');
  });
});
