/**
 * Ollama JSON mode: a responseFormat:json_object request must route to the
 * native /api/chat endpoint and set the top-level `format: 'json'` field —
 * Ollama's real structured-output lever. The /v1 response_format is unreliable,
 * so small local models only return parseable JSON via this path.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { OllamaProvider } from './ollama-provider';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Capture the URL + parsed JSON body of the next fetch, return a canned reply. */
function captureFetch(): { calls: Array<{ url: string; body: any }> } {
  const calls: Array<{ url: string; body: any }> = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return Promise.resolve(
      new Response(JSON.stringify({ message: { role: 'assistant', content: '{"ok":true}' }, done: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof fetch;
  return { calls };
}

const baseOpts = {
  model: 'qwen2.5:7b',
  messages: [{ role: 'user' as const, content: 'hi', timestamp: new Date() }],
  temperature: 0,
  maxTokens: 100,
};

describe('OllamaProvider JSON mode', () => {
  test('responseFormat json_object → native /api/chat with format:json', async () => {
    const { calls } = captureFetch();
    const provider = new OllamaProvider('http://localhost:11434');

    await provider.complete({ ...baseOpts, responseFormat: { type: 'json_object' } });

    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('http://localhost:11434/api/chat');
    expect(calls[0].body.format).toBe('json');
  });

  test('no responseFormat and no think:false → does NOT use native /api/chat', async () => {
    const { calls } = captureFetch();
    const provider = new OllamaProvider('http://localhost:11434');

    // This path goes through the OpenAI SDK (/v1), not our raw fetch — so our
    // captured fetch should NOT see an /api/chat call.
    await provider.complete(baseOpts).catch(() => {
      /* SDK may throw without a real server; we only assert routing */
    });

    expect(calls.some((c) => c.url.endsWith('/api/chat'))).toBe(false);
  });

  test('think:false still routes native, and without JSON has no format field', async () => {
    const { calls } = captureFetch();
    const provider = new OllamaProvider('http://localhost:11434');

    await provider.complete({ ...baseOpts, extraBody: { think: false } });

    expect(calls[0].url).toBe('http://localhost:11434/api/chat');
    expect('format' in calls[0].body).toBe(false);
  });

  test('native request carries keep_alive so the model stays warm in VRAM', async () => {
    const { calls } = captureFetch();
    const provider = new OllamaProvider('http://localhost:11434');

    await provider.complete({ ...baseOpts, responseFormat: { type: 'json_object' } });

    // Default keepAlive is '10m'; without it Ollama unloads after its own 5min
    // default and every cold-load risks the timeout loop we fixed.
    expect(calls[0].body.keep_alive).toBe('10m');
  });
});
