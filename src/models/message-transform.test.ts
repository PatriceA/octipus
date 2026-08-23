import { describe, expect, test } from 'vitest';
import {
  normalizeToolCallId,
  transformMessagesForProvider,
} from './message-transform';
import type { AgentMessage } from '@/core/types';

describe('Message Transform', () => {
  describe('normalizeToolCallId', () => {
    test('passes through short IDs unchanged', () => {
      expect(normalizeToolCallId('call_abc123')).toBe('call_abc123');
    });

    test('hashes IDs longer than 64 chars', () => {
      const longId = 'a'.repeat(100);
      const result = normalizeToolCallId(longId);
      expect(result.startsWith('tc-')).toBe(true);
      expect(result.length).toBeLessThanOrEqual(63); // 'tc-' + 60 hex chars
    });

    test('strips invalid characters (pipes, etc.)', () => {
      const id = 'call|with|pipes';
      const result = normalizeToolCallId(id);
      expect(result).toBe('callwithpipes');
      expect(result).not.toContain('|');
    });

    test('returns empty/falsy input unchanged', () => {
      expect(normalizeToolCallId('')).toBe('');
    });

    test('hashed IDs are deterministic', () => {
      const longId = 'x'.repeat(100);
      const r1 = normalizeToolCallId(longId);
      const r2 = normalizeToolCallId(longId);
      expect(r1).toBe(r2);
    });

    test('is idempotent — re-normalizing returns the same id', () => {
      const cases = [
        'call_abc123',
        'a'.repeat(100),
        'call|with|pipes',
        'mixed-and_underscored.ID:42',
      ];
      for (const id of cases) {
        const once = normalizeToolCallId(id);
        const twice = normalizeToolCallId(once);
        expect(twice).toBe(once);
      }
    });

    test('falls back to a hash when stripping leaves nothing', () => {
      // Anthropic-incompatible chars only — must still produce a non-empty,
      // stable id so the assistant↔tool message link is preserved.
      const result = normalizeToolCallId('|||::::....');
      expect(result.length).toBeGreaterThan(0);
      expect(result.startsWith('tc-')).toBe(true);
      // Stability check.
      expect(normalizeToolCallId('|||::::....')).toBe(result);
    });

    test('long ids stay within the 64-char Anthropic limit', () => {
      const result = normalizeToolCallId('y'.repeat(500));
      expect(result.length).toBeLessThanOrEqual(64);
    });
  });

  describe('transformMessagesForProvider', () => {
    const now = new Date();

    test('normalizes tool call IDs in assistant messages', () => {
      const longId = 'z'.repeat(100);
      const messages: AgentMessage[] = [
        {
          role: 'assistant',
          content: 'Using a tool',
          toolCalls: [{ id: longId, name: 'read', arguments: {} }],
          timestamp: now,
        },
      ];

      const result = transformMessagesForProvider(messages, 'openai');
      expect(result[0].toolCalls![0].id).not.toBe(longId);
      expect(result[0].toolCalls![0].id.startsWith('tc-')).toBe(true);
    });

    test('normalizes tool_call_id in tool result messages', () => {
      const longId = 'z'.repeat(100);
      const messages: AgentMessage[] = [
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: longId, name: 'read', arguments: {} }],
          timestamp: now,
        },
        {
          role: 'tool',
          content: 'result',
          toolCallId: longId,
          timestamp: now,
        },
      ];

      const result = transformMessagesForProvider(messages, 'openai');
      // Tool result ID should match the normalized assistant tool call ID
      expect(result[1].toolCallId).toBe(result[0].toolCalls![0].id);
    });

    test('strips thinking blocks from assistant content', () => {
      const messages: AgentMessage[] = [
        {
          role: 'assistant',
          content:
            '<thinking>Let me reason about this...</thinking>Here is my answer.',
          timestamp: now,
        },
      ];

      const result = transformMessagesForProvider(messages, 'anthropic');
      expect(result[0].content).toBe('Here is my answer.');
      expect(result[0].content).not.toContain('<thinking>');
    });

    test('preserves content when no id/thinking/pairing transformation needed', () => {
      const messages: AgentMessage[] = [
        { role: 'user', content: 'Hello', timestamp: now },
        { role: 'assistant', content: 'Hi there', timestamp: now },
      ];

      // The idMap early-return was removed (item 25) so thinking-strip + pairing
      // run for every provider — the array is rebuilt but content is unchanged.
      const result = transformMessagesForProvider(messages, 'openai');
      expect(result).toEqual(messages);
    });
  });
});
