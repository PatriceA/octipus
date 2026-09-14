import { describe, expect, test } from 'vitest';
import type { AgentMessage } from '@/core/types';
import {
  compactMessages,
  calculateTotalTokens,
  CONTEXT_OVERFLOW_TRUNCATED_MARKER,
  DEFAULT_TOOL_OUTPUT_SOFT_CAP,
  truncateOldestToolOutputs,
} from './context-compaction';
import { estimateTokens } from './context-compaction';

describe('estimateTokens (real tokenizer)', () => {
  test('empty string is zero', () => {
    expect(estimateTokens('')).toBe(0);
  });
  test('counts BPE tokens, not chars/4', () => {
    // " hello world" is 2 tokens in o200k_base; chars/4 would say ~3.
    const n = estimateTokens(' hello world');
    expect(n).toBe(2);
    expect(n).toBeGreaterThan(0);
  });
});

const now = new Date();
const big = (n: number) => 'x'.repeat(n);

function msg(role: AgentMessage['role'], content: string): AgentMessage {
  return { role, content, timestamp: now };
}

/** Build `count` tool messages each with `chars` chars of content. */
function toolMessages(count: number, chars: number): AgentMessage[] {
  return Array.from({ length: count }, (_, i) => msg('tool', `t${i}:${big(chars)}`));
}

describe('truncateOldestToolOutputs', () => {
  test('no-op when tool count is at or below the soft cap', () => {
    const messages = toolMessages(DEFAULT_TOOL_OUTPUT_SOFT_CAP, 5000);
    const { messages: out, truncated } = truncateOldestToolOutputs(messages);
    expect(truncated).toBe(0);
    expect(out).toBe(messages); // same reference, untouched
  });

  test('12 tool messages, cap 10 ⇒ 2 oldest truncated, recent untouched', () => {
    const messages = toolMessages(12, 5000);
    const { messages: out, truncated } = truncateOldestToolOutputs(messages, { softCap: 10, maxToolChars: 2000 });
    expect(truncated).toBe(2);
    // oldest two truncated
    expect(out[0].content.length).toBeLessThan(5000);
    expect(out[0].content).toContain('truncated to keep context small');
    expect(out[1].content).toContain('truncated to keep context small');
    // the remaining 10 most-recent are full
    for (let i = 2; i < 12; i++) {
      expect(out[i].content.length).toBe(messages[i].content.length);
    }
  });

  test('preserves non-tool turns interleaved with tool messages', () => {
    const messages: AgentMessage[] = [
      msg('system', 'sys'),
      msg('user', 'do the thing'),
      ...toolMessages(12, 5000).flatMap((t, i) => [msg('assistant', `step ${i}`), t]),
    ];
    const before = messages.filter((m) => m.role !== 'tool').map((m) => m.content);
    const { messages: out, truncated } = truncateOldestToolOutputs(messages, { softCap: 10 });
    expect(truncated).toBe(2);
    const after = out.filter((m) => m.role !== 'tool').map((m) => m.content);
    expect(after).toEqual(before); // every non-tool turn intact
  });

  test('idempotent: a second pass truncates nothing (no double-fold loop)', () => {
    const messages = toolMessages(12, 5000);
    const first = truncateOldestToolOutputs(messages, { softCap: 10 });
    expect(first.truncated).toBe(2);
    const second = truncateOldestToolOutputs(first.messages, { softCap: 10 });
    expect(second.truncated).toBe(0);
    expect(second.messages).toBe(first.messages); // unchanged reference on the second pass
    // content stable across passes
    expect(second.messages[0].content).toBe(first.messages[0].content);
  });

  test('skips oldest outputs already small enough to gain nothing', () => {
    // 11 tool msgs, cap 10 ⇒ only the single oldest is a candidate; make it small
    const messages = [msg('tool', 'tiny'), ...toolMessages(10, 5000)];
    const { truncated } = truncateOldestToolOutputs(messages, { softCap: 10, maxToolChars: 2000 });
    expect(truncated).toBe(0);
  });

  test('does not re-fold a tool output already truncated by the reactive overflow path', () => {
    // Oldest tool output already carries the reactive-overflow marker.
    const reactive = msg('tool', big(2000) + CONTEXT_OVERFLOW_TRUNCATED_MARKER);
    const messages = [reactive, ...toolMessages(11, 5000)];
    const { truncated } = truncateOldestToolOutputs(messages, { softCap: 10, maxToolChars: 2000 });
    // 12 tool msgs, cap 10 ⇒ 2 oldest are candidates: the reactive one (skipped)
    // + one fresh 5000-char one (folded).
    expect(truncated).toBe(1);
  });

  test('does not mutate the input array or its messages', () => {
    const messages = toolMessages(12, 5000);
    const originalFirst = messages[0].content;
    truncateOldestToolOutputs(messages, { softCap: 10 });
    expect(messages[0].content).toBe(originalFirst);
  });
});

describe('compactMessages conversation boundary', () => {
  test('retains the nearest user turn before a recent assistant tool call', () => {
    const messages: AgentMessage[] = [
      msg('user', 'Research the provider error'),
      {
        ...msg('assistant', ''),
        toolCalls: [{ id: 'old-call', name: 'search', arguments: { q: 'old' } }],
      },
      { ...msg('tool', 'old result '.repeat(2000)), toolCallId: 'old-call', name: 'search' },
      {
        ...msg('assistant', ''),
        toolCalls: [{ id: 'recent-call', name: 'search', arguments: { q: 'recent' } }],
      },
      { ...msg('tool', 'recent result'), toolCallId: 'recent-call', name: 'search' },
      msg('assistant', 'Final synthesis'),
    ];

    const compacted = compactMessages(messages, {
      maxMessages: 1,
      maxTokens: 100,
      preserveRecentCount: 3,
    });

    expect(compacted.removed).toBe(2);
    expect(compacted.messages.map((message) => message.role)).toEqual([
      'user', 'assistant', 'tool', 'assistant',
    ]);
    expect(compacted.messages[0].content).toBe('Research the provider error');
    expect(compacted.messages[1].toolCalls?.[0].id).toBe('recent-call');
    expect(compacted.messages[2].toolCallId).toBe('recent-call');
  });

  test('does not reinsert an oversized user anchor after applying the token budget', () => {
    const oversized = 'large pasted document '.repeat(10_000);
    const messages: AgentMessage[] = [
      msg('user', oversized),
      msg('assistant', 'I will inspect it.'),
      {
        ...msg('assistant', ''),
        toolCalls: [{ id: 'recent-call', name: 'search', arguments: { q: 'recent' } }],
      },
      { ...msg('tool', 'recent result'), toolCallId: 'recent-call', name: 'search' },
      msg('assistant', 'Final synthesis'),
    ];

    const compacted = compactMessages(messages, {
      maxMessages: 1,
      maxTokens: 2000,
      preserveRecentCount: 3,
    });

    expect(compacted.removed).toBeGreaterThan(0);
    expect(compacted.messages.some(message => message.content === oversized)).toBe(false);
    expect(calculateTotalTokens(compacted.messages)).toBeLessThanOrEqual(2000);
    expect(compacted.messages[0].role).toBe('assistant');
  });
});
