import { beforeEach, expect, test, vi } from 'vitest';
const complete = vi.hoisted(() => vi.fn());
vi.mock('@/models/litellm-client', () => ({ getLiteLLMClient: () => ({ complete }) }));
import { createLLMSummary } from './context-compaction';
const message = (content: string) => ({ role: 'user' as const, content, timestamp: new Date() });
beforeEach(() => complete.mockReset());
test('strict checkpoint summarization covers the second half of a 9KB transcript', async () => {
  complete.mockResolvedValue({ content: 'concise summary', finishReason: 'stop' });
  await createLLMSummary([message('start ' + 'word '.repeat(1800) + 'TAIL_SENTINEL')], 'model', { requireSuccess: true });
  expect(complete.mock.calls.some(([options]) => options.messages.some((m: any) => m.content.includes('TAIL_SENTINEL')))).toBe(true);
  expect(complete).toHaveBeenCalledTimes(3); // two chunks, then reduce
});
test('strict checkpoint refuses partial map coverage instead of summarizing only successful chunks', async () => {
  complete.mockResolvedValueOnce({ content: 'partial summary', finishReason: 'stop' }).mockRejectedValueOnce(new Error('map failed'));
  await expect(createLLMSummary([message('word '.repeat(1800))], 'model', { requireSuccess: true })).rejects.toThrow('every chunk');
  expect(complete).toHaveBeenCalledTimes(2);
});
test('strict checkpoint rejects truncated final output', async () => {
  complete.mockResolvedValue({ content: 'incomplete', finishReason: 'length' });
  await expect(createLLMSummary([message('short')], 'model', { requireSuccess: true })).rejects.toThrow('truncated');
});
