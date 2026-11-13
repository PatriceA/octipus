import { afterEach, expect, test, vi } from 'vitest';
import { testModelConnection } from './provider-service';

afterEach(() => vi.unstubAllGlobals());

test('an explicit Ollama endpoint cannot pass by testing a different LiteLLM server', async () => {
  const fetch = vi.fn(async (url: string | URL | Request) => {
    const address = String(url);
    if (address.startsWith('http://chosen-server:11434')) return new Response('Unavailable', { status: 503 });
    if (address.endsWith('/v1/models')) return Response.json({ data: [{ id: 'same-model' }] });
    return Response.json({ choices: [{ message: { content: 'ok' } }] });
  });
  vi.stubGlobal('fetch', fetch);
  expect(await testModelConnection({ provider: 'ollama', modelId: 'same-model', endpoint: 'http://chosen-server:11434' })).toMatchObject({ success: false, error: 'Cannot reach Ollama at http://chosen-server:11434' });
  expect(fetch.mock.calls.map(([url]) => String(url))).toEqual(['http://chosen-server:11434/api/tags']);
});
