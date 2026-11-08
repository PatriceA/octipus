import { describe, expect, test } from 'vitest';
import type { AgentMessage } from '@/core/types';
import {
  compactMessages,
  calculateTotalTokens,
  CONTEXT_OVERFLOW_TRUNCATED_MARKER,
  DEFAULT_TOOL_OUTPUT_SOFT_CAP,
  shouldCompactToolOutputs,
  stripSignedReasoning,
  truncateOldestToolOutputs,
  usableContextWindow,
} from './context-compaction';
import { contextLimits, estimateTokens } from './context-compaction';

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

  test('12 tool messages, cap 10 ⇒ cut back to the newest half of the cap', () => {
    const messages = toolMessages(12, 5000);
    const { messages: out, truncated, firstChanged } = truncateOldestToolOutputs(messages, { softCap: 10, maxToolChars: 2000 });
    expect(truncated).toBe(7);
    expect(firstChanged).toBe(0);
    for (let i = 0; i < 7; i++) expect(out[i].content).toContain('truncated to keep context small');
    // the 5 most recent are full
    for (let i = 7; i < 12; i++) {
      expect(out[i].content.length).toBe(messages[i].content.length);
    }
  });

  test('batched: no further rewrite until another large output leaves the cap window', () => {
    let messages = truncateOldestToolOutputs(toolMessages(12, 5000), { softCap: 10 }).messages;
    // Five more results: the newest 10 now include all untruncated ones.
    for (let i = 0; i < 5; i++) {
      messages = [...messages, msg('tool', big(5000))];
      const pass = truncateOldestToolOutputs(messages, { softCap: 10 });
      expect(pass.truncated).toBe(0);
      expect(pass.messages).toBe(messages);
    }
    // The sixth pushes a large untruncated output out of the newest 10.
    messages = [...messages, msg('tool', big(5000))];
    const pass = truncateOldestToolOutputs(messages, { softCap: 10 });
    expect(pass.truncated).toBe(6);
    expect(pass.firstChanged).toBe(7);
  });

  test('preserves non-tool turns interleaved with tool messages', () => {
    const messages: AgentMessage[] = [
      msg('system', 'sys'),
      msg('user', 'do the thing'),
      ...toolMessages(12, 5000).flatMap((t, i) => [msg('assistant', `step ${i}`), t]),
    ];
    const before = messages.filter((m) => m.role !== 'tool').map((m) => m.content);
    const { messages: out, truncated, firstChanged } = truncateOldestToolOutputs(messages, { softCap: 10 });
    expect(truncated).toBe(7);
    expect(firstChanged).toBe(3);
    const after = out.filter((m) => m.role !== 'tool').map((m) => m.content);
    expect(after).toEqual(before); // every non-tool turn intact
  });

  test('idempotent: a second pass truncates nothing (no double-fold loop)', () => {
    const messages = toolMessages(12, 5000);
    const first = truncateOldestToolOutputs(messages, { softCap: 10 });
    expect(first.truncated).toBe(7);
    const second = truncateOldestToolOutputs(first.messages, { softCap: 10 });
    expect(second.truncated).toBe(0);
    expect(second.messages).toBe(first.messages); // unchanged reference on the second pass
    // content stable across passes
    expect(second.messages[0].content).toBe(first.messages[0].content);
  });

  test('skips oldest outputs already small enough to gain nothing', () => {
    // 11 tool msgs, cap 10 ⇒ only the single oldest is outside the cap; make it small
    const messages = [msg('tool', 'tiny'), ...toolMessages(10, 5000)];
    const { truncated } = truncateOldestToolOutputs(messages, { softCap: 10, maxToolChars: 2000 });
    expect(truncated).toBe(0);
  });

  test('does not re-fold a tool output already truncated by the reactive overflow path', () => {
    // Oldest tool output already carries the reactive-overflow marker.
    const reactive = msg('tool', big(2000) + CONTEXT_OVERFLOW_TRUNCATED_MARKER);
    const messages = [reactive, ...toolMessages(11, 5000)];
    const { truncated, firstChanged } = truncateOldestToolOutputs(messages, { softCap: 10, maxToolChars: 2000 });
    // 12 tool msgs, cap 10 ⇒ triggered by the fresh 5000-char one outside the
    // cap; cut back to the newest 5: the reactive one is skipped, 6 folded.
    expect(truncated).toBe(6);
    expect(firstChanged).toBe(1);
  });

  test('does not mutate the input array or its messages', () => {
    const messages = toolMessages(12, 5000);
    const originalFirst = messages[0].content;
    truncateOldestToolOutputs(messages, { softCap: 10 });
    expect(messages[0].content).toBe(originalFirst);
  });
});

describe('stripSignedReasoning', () => {
  const thinking = { type: 'thinking', thinking: '', signature: 'sig' };
  const text = { type: 'text', text: 'answer' };
  const toolUse = { type: 'tool_use', id: 't1', name: 'read', input: {} };
  const assistant = (providerRaw: Record<string, unknown>): AgentMessage => ({ ...msg('assistant', 'answer'), providerRaw });

  test('drops Claude thinking blocks from the given index on, keeping text and tool_use', () => {
    const messages = [
      assistant({ anthropicContent: [thinking, text] }),
      msg('user', 'next'),
      assistant({ anthropicContent: [thinking, { type: 'redacted_thinking', data: 'x' }, text, toolUse] }),
    ];
    const out = stripSignedReasoning(messages, 1);
    expect(out[0]).toBe(messages[0]); // before the edit: untouched
    expect(out[2].providerRaw).toEqual({ anthropicContent: [text, toolUse] });
    expect(messages[2].providerRaw?.anthropicContent).toHaveLength(4); // input not mutated
  });

  test('a turn that was only thinking loses its provider payload', () => {
    const out = stripSignedReasoning([assistant({ anthropicContent: [thinking] })]);
    expect(out[0].providerRaw).toBeUndefined();
  });

  test('strips reasoning OpenRouter relays for Claude, not for other models', () => {
    const claude = assistant({ openrouterModel: 'anthropic/claude-sonnet-4-6', reasoning_details: [{ signature: 's' }] });
    const gemini = assistant({ openrouterModel: 'google/gemini-3-pro', reasoning_details: [{ signature: 's' }] });
    const out = stripSignedReasoning([claude, gemini]);
    expect(out[0].providerRaw).toBeUndefined();
    expect(out[1]).toBe(gemini);
  });

  test('leaves Gemini thought signatures alone and returns the same array when nothing is signed', () => {
    const messages = [assistant({ role: 'assistant', tool_calls: [{ thought_signature: 'keep' }] })];
    expect(stripSignedReasoning(messages)).toBe(messages);
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

describe('shouldCompactToolOutputs', () => {
  test('leaves history alone while the window has room', () => {
    // The arena module run: 30k tokens into a 1M window, eleven tool results.
    expect(shouldCompactToolOutputs(30_000, 1_048_576)).toBe(false);
  });

  test('compacts once the request is past half the window', () => {
    expect(shouldCompactToolOutputs(20_000, 32_768)).toBe(true);
  });

  test('an unknown window keeps the count-only behaviour', () => {
    expect(shouldCompactToolOutputs(1_000, 0)).toBe(true);
  });
});

describe('usableContextWindow', () => {
  test('the model\'s own window wins', () => {
    expect(usableContextWindow(1_048_576, 32_000)).toBe(1_048_576);
  });

  test('a zero or missing window falls back to the setting', () => {
    // Reachable: POST/PATCH /models accept contextWindow with no minimum, and
    // every compaction threshold is a fraction of this number.
    expect(usableContextWindow(0, 32_000)).toBe(32_000);
    expect(usableContextWindow(-1, 32_000)).toBe(32_000);
    expect(usableContextWindow(null, 32_000)).toBe(32_000);
    expect(usableContextWindow(undefined, 32_000)).toBe(32_000);
    expect(usableContextWindow(999, 32_000)).toBe(32_000);
  });
});

describe('contextLimits', () => {
  test('tool output is cut at half the window; history summarised at 100k or 80%, whichever comes first', () => {
    expect(contextLimits(200_000)).toEqual({ toolTrimTokens: 100_000, summaryTokens: 100_000 });
    expect(contextLimits(1_000_000)).toEqual({ toolTrimTokens: 500_000, summaryTokens: 100_000 });
    expect(contextLimits(32_000)).toEqual({ toolTrimTokens: 16_000, summaryTokens: 25_600 });
    expect(contextLimits(0)).toBeNull();
  });
});
