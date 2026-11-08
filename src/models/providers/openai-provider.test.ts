import { describe, expect, test, vi } from 'vitest';
import type { CompletionOptions } from '../litellm-client';
import { isUnsupportedRetentionError, OpenAIProvider } from './openai-provider';

const reply = { id: 'r', model: 'm', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
const unsupported = { status: 400, message: "Unsupported parameter: 'prompt_cache_retention' is not supported with this model." };

function provider(create: ReturnType<typeof vi.fn>) {
  const p = new OpenAIProvider();
  (p as unknown as { createClient: () => unknown }).createClient = async () => ({ chat: { completions: { create } } });
  return p;
}
const options = (model: string): CompletionOptions => ({
  model, messages: [{ role: 'user', content: 'hi', timestamp: new Date() }],
  extraBody: { prompt_cache_key: 'octi-k', prompt_cache_retention: '24h' },
});

describe('OpenAIProvider — extended prompt-cache retention', () => {
  test('recognizes only a 400 naming the parameter', () => {
    expect(isUnsupportedRetentionError(unsupported)).toBe(true);
    expect(isUnsupportedRetentionError({ status: 400, message: 'Invalid messages' })).toBe(false);
    expect(isUnsupportedRetentionError({ status: 500, message: 'prompt_cache_retention' })).toBe(false);
  });

  test('a model that rejects it is retried once without, keeps its key, and is not sent it again', async () => {
    const create = vi.fn().mockRejectedValueOnce(unsupported).mockResolvedValue(reply);
    const p = provider(create);
    await expect(p.complete(options('gpt-old-retention'))).resolves.toMatchObject({ content: 'ok' });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0].prompt_cache_retention).toBe('24h');
    expect(create.mock.calls[1][0]).not.toHaveProperty('prompt_cache_retention');
    expect(create.mock.calls[1][0].prompt_cache_key).toBe('octi-k');
    await p.complete(options('gpt-old-retention'));
    expect(create).toHaveBeenCalledTimes(3);
    expect(create.mock.calls[2][0]).not.toHaveProperty('prompt_cache_retention');
  });

  test('a model that accepts it keeps it, and other errors are not retried', async () => {
    const ok = vi.fn().mockResolvedValue(reply);
    await provider(ok).complete(options('gpt-new-retention'));
    expect(ok.mock.calls[0][0].prompt_cache_retention).toBe('24h');
    const failing = vi.fn().mockRejectedValue({ status: 400, message: 'Invalid messages' });
    await expect(provider(failing).complete(options('gpt-other'))).rejects.toBeTruthy();
    expect(failing).toHaveBeenCalledTimes(1);
  });

  test('the GPT-5.6+ prompt_cache_options field gets the same retry-without treatment', async () => {
    const create = vi.fn().mockRejectedValueOnce({ status: 400, message: "Unsupported parameter: 'prompt_cache_options'." }).mockResolvedValue(reply);
    const opts: CompletionOptions = { ...options('gpt-5.6-test'), extraBody: { prompt_cache_key: 'octi-k', prompt_cache_options: { ttl: '12h' } } };
    await expect(provider(create).complete(opts)).resolves.toMatchObject({ content: 'ok' });
    expect(create.mock.calls[0][0].prompt_cache_options).toEqual({ ttl: '12h' });
    expect(create.mock.calls[1][0]).not.toHaveProperty('prompt_cache_options');
    expect(create.mock.calls[1][0].prompt_cache_key).toBe('octi-k');
  });
});
