import { describe, test, expect, mock } from 'bun:test';
import {
  serializeConversation,
  extractFileOperations,
  compactWithSummarization,
} from './context-compaction';
import type { AgentMessage } from '@/core/types';

const now = new Date();

function msg(role: AgentMessage['role'], content: string): AgentMessage {
  return { role, content, timestamp: now };
}

describe('Context Compaction', () => {
  describe('serializeConversation', () => {
    test('formats messages as [ROLE]: content', () => {
      const messages = [
        msg('user', 'Hello'),
        msg('assistant', 'Hi there'),
      ];

      const result = serializeConversation(messages);
      expect(result).toBe('[USER]: Hello\n\n[ASSISTANT]: Hi there');
    });

    test('stringifies non-string content', () => {
      const messages: AgentMessage[] = [
        { role: 'system', content: JSON.stringify({ key: 'value' }), timestamp: now },
      ];

      const result = serializeConversation(messages);
      expect(result).toContain('[SYSTEM]:');
    });
  });

  describe('extractFileOperations', () => {
    test('finds read files from tool results', () => {
      const messages = [
        msg('tool', 'Read file: /src/index.ts'),
        msg('tool', 'Read file: /src/utils.ts'),
      ];

      const ops = extractFileOperations(messages);
      expect(ops.read).toContain('/src/index.ts');
      expect(ops.read).toContain('/src/utils.ts');
    });

    test('finds written and edited files from tool results', () => {
      const messages = [
        msg('tool', 'Wrote: /src/new-file.ts'),
        msg('tool', 'Edited: /src/existing.ts'),
        msg('tool', 'Created: /src/another.ts'),
        msg('tool', 'Modified: /src/modified.ts'),
      ];

      const ops = extractFileOperations(messages);
      expect(ops.written).toContain('/src/new-file.ts');
      expect(ops.written).toContain('/src/another.ts');
      expect(ops.edited).toContain('/src/existing.ts');
      expect(ops.edited).toContain('/src/modified.ts');
    });

    test('ignores non-tool messages', () => {
      const messages = [
        msg('user', 'Read file: /src/fake.ts'),
        msg('assistant', 'Wrote: /src/fake.ts'),
      ];

      const ops = extractFileOperations(messages);
      expect(ops.read).toHaveLength(0);
      expect(ops.written).toHaveLength(0);
      expect(ops.edited).toHaveLength(0);
    });

    test('deduplicates file paths', () => {
      const messages = [
        msg('tool', 'Read file: /src/index.ts'),
        msg('tool', 'Read file: /src/index.ts'),
      ];

      const ops = extractFileOperations(messages);
      expect(ops.read).toHaveLength(1);
    });
  });

  describe('compactWithSummarization', () => {
    test('returns unchanged messages when under keepRecent threshold', async () => {
      const messages = [msg('user', 'Hello'), msg('assistant', 'Hi')];
      const summarize = mock(() => Promise.resolve('summary'));

      const result = await compactWithSummarization(messages, summarize, 5);

      expect(result.compactedMessages).toEqual(messages);
      expect(result.removedCount).toBe(0);
      expect(summarize).not.toHaveBeenCalled();
    });

    test('calls summarize callback with correct prompt', async () => {
      const messages = Array.from({ length: 25 }, (_, i) =>
        msg(i % 2 === 0 ? 'user' : 'assistant', `Message ${i}`),
      );

      const summarize = mock(() => Promise.resolve('This is the summary.'));

      await compactWithSummarization(messages, summarize, 10);

      expect(summarize).toHaveBeenCalledTimes(1);
      const prompt = (summarize.mock.calls as unknown as string[][])[0][0];
      expect(prompt).toContain('Summarize the following conversation');
      expect(prompt).toContain('Message 0'); // first message in summarized window
      expect(prompt).not.toContain('Message 24'); // last message is in keepRecent
    });

    test('summary message includes file operation metadata', async () => {
      const messages: AgentMessage[] = [
        msg('user', 'Edit the file'),
        msg('tool', 'Read file: /src/main.ts'),
        msg('tool', 'Edited: /src/main.ts'),
        ...Array.from({ length: 10 }, (_, i) => msg('user', `Follow-up ${i}`)),
      ];

      const summarize = mock(() => Promise.resolve('Did some edits.'));

      const result = await compactWithSummarization(messages, summarize, 5);

      expect(result.removedCount).toBe(messages.length - 5);
      expect(result.summaryMessage.content).toContain('Files read: /src/main.ts');
      expect(result.summaryMessage.content).toContain('Files edited: /src/main.ts');
      expect(result.fileOperations.read).toContain('/src/main.ts');
      expect(result.fileOperations.edited).toContain('/src/main.ts');
    });

    test('compacted result starts with summary then keeps recent messages', async () => {
      const messages = Array.from({ length: 10 }, (_, i) =>
        msg('user', `Msg ${i}`),
      );

      const summarize = mock(() => Promise.resolve('Summary of old messages.'));

      const result = await compactWithSummarization(messages, summarize, 3);

      expect(result.compactedMessages).toHaveLength(4); // 1 summary + 3 kept
      expect(result.compactedMessages[0].role).toBe('system');
      expect(result.compactedMessages[0].content).toContain('Summary of old messages.');
      expect(result.compactedMessages[1].content).toBe('Msg 7');
      expect(result.compactedMessages[3].content).toBe('Msg 9');
    });
  });
});
