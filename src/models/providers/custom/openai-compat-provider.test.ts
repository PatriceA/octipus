import { describe, expect, test, vi } from 'vitest';
import type { CompletionOptions } from '../../litellm-client';
import { CustomOpenAICompatProvider, isUnsupportedStreamUsageError } from './openai-compat-provider';

const options: CompletionOptions = {
  model: 'custom-model',
  messages: [{ role: 'user', content: 'hi', timestamp: new Date() }],
  customProviderOverride: {
    baseUrl: 'https://example.test',
    apiKey: 'test-key',
    modelId: 'wire-model',
    custom: { auth: { type: 'bearer' } },
  },
};

describe('CustomOpenAICompatProvider stream usage fallback', () => {
  test('recognizes only targeted HTTP 400 responses', () => {
    expect(isUnsupportedStreamUsageError({ status: 400, message: 'Unknown parameter: stream_options.include_usage' })).toBe(true);
    expect(isUnsupportedStreamUsageError({ status: 401, message: 'Unknown parameter: stream_options' })).toBe(false);
    expect(isUnsupportedStreamUsageError({ status: 400, message: 'Invalid messages' })).toBe(false);
  });

  test('retries once without stream_options when rejected before chunks', async () => {
    async function* successfulStream() {
      yield { id: 'chunk-1', model: 'wire-model', choices: [{ delta: { content: 'ok' }, finish_reason: null }] };
    }
    const create = vi.fn()
      .mockRejectedValueOnce({ status: 400, message: 'Unsupported parameter stream_options.include_usage' })
      .mockResolvedValueOnce(successfulStream());
    const provider = new CustomOpenAICompatProvider();
    (provider as unknown as { createClient: () => unknown }).createClient = () => ({ chat: { completions: { create } } });

    const chunks: import('../../litellm-client').StreamChunk[] = [];
    for await (const chunk of provider.stream(options)) chunks.push(chunk);

    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0].stream_options).toEqual({ include_usage: true });
    expect(create.mock.calls[1][0].stream_options).toBeUndefined();
    expect(chunks).toEqual([{ content: 'ok' }]);
  });

  test('does not retry after any upstream chunk has arrived', async () => {
    async function* interruptedStream() {
      yield { id: 'chunk-1', model: 'wire-model', choices: [{ delta: { content: 'partial' }, finish_reason: null }] };
      throw { status: 400, message: 'Unsupported parameter stream_options.include_usage' };
    }
    const create = vi.fn().mockResolvedValue(interruptedStream());
    const provider = new CustomOpenAICompatProvider();
    (provider as unknown as { createClient: () => unknown }).createClient = () => ({ chat: { completions: { create } } });
    const chunks: import('../../litellm-client').StreamChunk[] = [];

    await expect(async () => {
      for await (const chunk of provider.stream(options)) chunks.push(chunk);
    }).rejects.toThrow();

    expect(create).toHaveBeenCalledOnce();
    expect(chunks).toEqual([{ content: 'partial' }]);
  });
});
