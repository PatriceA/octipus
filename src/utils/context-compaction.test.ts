import { describe, expect, test } from 'bun:test';
import type { AgentMessage } from '@/core/types';
import {
  CONTEXT_OVERFLOW_TRUNCATED_MARKER,
  DEFAULT_TOOL_OUTPUT_SOFT_CAP,
  truncateOldestToolOutputs,
} from './context-compaction';

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
