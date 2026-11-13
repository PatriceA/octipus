import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClassifiedError, FailoverReason } from '@/core/errors/classification';
import { MetaProvider } from './meta-provider';
import { OllamaProvider } from './ollama-provider';
import { OpenRouterProvider } from './openrouter-provider';

describe('MetaProvider.supportsModel', () => {
  const p = new MetaProvider();

  it('matches Muse chat model ids, case-insensitively', () => {
    for (const m of ['muse-spark-1.3', 'muse-ember-1.0', 'muse-wonder-1.0', 'Muse-Spark-1.2']) {
      expect(p.supportsModel(m)).toBe(true);
    }
  });

  it('does not claim Muse image/voice models, sam, Llama, or other providers', () => {
    for (const m of ['muse-image-1.0', 'muse-voice-transcribe-1.0', 'sam-3.1', 'meta-llama/llama-3.3-70b-instruct', 'llama3.1:8b', 'gpt-4o', 'kimi-k2']) {
      expect(p.supportsModel(m)).toBe(false);
    }
  });

  it('leaves meta-llama/* to OpenRouter and keeps muse-* away from Ollama', () => {
    expect(new OpenRouterProvider().supportsModel('meta-llama/llama-3.3-70b-instruct')).toBe(true);
    const ollama = new OllamaProvider('http://localhost:11434');
    expect(ollama.supportsModel('llama3.1:8b')).toBe(true);
    expect(ollama.supportsModel('muse-spark-1.3')).toBe(false);
  });

  it('identifies as a direct provider named "meta"', () => {
    expect(p.name).toBe('meta');
    expect(p.type).toBe('direct');
  });
});

describe('MetaProvider.complete', () => {
  const p = new MetaProvider();
  const realFetch = globalThis.fetch;
  const realKey = process.env.META_API_KEY;

  beforeEach(() => { process.env.META_API_KEY = 'test-key'; });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.META_API_KEY;
    else process.env.META_API_KEY = realKey;
  });

  const stub = (status: number, body: unknown, seen?: { url?: string }) => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (seen) seen.url = String(url);
      return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
  };

  it('parses tool calls, reasoning and cached prompt tokens', async () => {
    const seen: { url?: string } = {};
    stub(200, {
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 1,
      model: 'muse-spark-1.3',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: '',
          reasoning_content: 'thinking',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"muse"}' } }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 200, completion_tokens: 12, total_tokens: 212, prompt_tokens_details: { cached_tokens: 150 } },
    }, seen);

    const result = await p.complete({
      model: 'muse-spark-1.3',
      messages: [{ role: 'user', content: 'search muse' }],
      tools: [{ type: 'function', function: { name: 'lookup', parameters: {} } }],
    } as any);

    expect(seen.url).toContain('api.meta.ai/v1/chat/completions');
    expect(result.toolCalls?.[0].name).toBe('lookup');
    expect(result.toolCalls?.[0].arguments).toEqual({ q: 'muse' });
    expect(result.reasoningContent).toBe('thinking');
    expect(result.usage.inputTokens).toBe(200);
    expect(result.usage.cacheReadTokens).toBe(150);
  });

  it('maps a Muse Code subscription key 403 to a non-retryable auth error', async () => {
    stub(403, {
      error: {
        code: 'client_attestation_denied',
        type: 'permission_error',
        message: 'This API key is billed to a Muse Code subscription. Muse Code subscriptions cover requests from the Muse Code client only. Use it in Muse Code, or use a pay-as-you-go API key for other clients.',
      },
    });

    const err = await p.complete({ model: 'muse-spark-1.3', messages: [{ role: 'user', content: 'hi' }] } as any)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ClassifiedError);
    const c = err as ClassifiedError;
    expect(c.reason).toBe(FailoverReason.AUTH_FAILED);
    expect(c.isRetryable).toBe(false);
    expect(c.message).toMatch(/pay-as-you-go/);
    expect(c.message).toMatch(/cli\/muse/);
  });
});

describe('MetaDiscovery', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it('keeps chat models only', async () => {
    const { MetaDiscovery } = await import('./discovery/meta');
    const ids = ['muse-spark-1.3', 'muse-ember-1.0', 'muse-wonder-1.0', 'muse-spark-1.3-contributor', 'muse-image-1.0', 'muse-voice-transcribe-1.0', 'sam-3.1'];
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: ids.map((id) => ({ id, owned_by: 'meta' })) }))) as unknown as typeof fetch;
    const models = await new MetaDiscovery().listAll({ apiKey: 'k' });
    expect(models.map((m) => m.id).sort()).toEqual(['muse-ember-1.0', 'muse-spark-1.3', 'muse-wonder-1.0']);
  });
});
