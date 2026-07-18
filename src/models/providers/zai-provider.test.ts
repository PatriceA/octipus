import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { ZaiProvider } from './zai-provider';

describe('ZaiProvider.supportsModel', () => {
  const p = new ZaiProvider();

  it('matches GLM model ids', () => {
    for (const m of ['glm-4.6', 'glm-4.5', 'glm-4.5-air', 'glm-z1-air', 'zai/glm-4.6']) {
      expect(p.supportsModel(m)).toBe(true);
    }
  });

  it('is case-insensitive', () => {
    expect(p.supportsModel('GLM-4.6')).toBe(true);
  });

  it('does not match other providers', () => {
    for (const m of ['gpt-4o', 'claude-sonnet-4-6', 'deepseek-chat', 'kimi-k2', 'gemini-2.0-flash']) {
      expect(p.supportsModel(m)).toBe(false);
    }
  });

  it('identifies as a direct provider named "zai"', () => {
    expect(p.name).toBe('zai');
    expect(p.type).toBe('direct');
  });
});

describe('ZaiProvider.complete', () => {
  const p = new ZaiProvider();
  // Stub global fetch (the OpenAI SDK uses fetch under the hood) rather than
  // mock.module — the latter leaks process-wide.
  const realFetch = globalThis.fetch;
  const realKey = process.env.ZAI_API_KEY;

  beforeEach(() => { process.env.ZAI_API_KEY = 'test-key'; });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.ZAI_API_KEY;
    else process.env.ZAI_API_KEY = realKey;
  });

  it('parses tool calls and extracts cached prompt tokens', async () => {
    let capturedUrl = '';
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion',
          created: 1,
          model: 'glm-4.6',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{
                id: 'call_1',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"SF"}' },
              }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 10,
            total_tokens: 110,
            prompt_tokens_details: { cached_tokens: 80 },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const result = await p.complete({
      model: 'glm-4.6',
      messages: [{ role: 'user', content: 'weather in SF?' }],
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: {} } }],
    } as any);

    expect(capturedUrl).toContain('api.z.ai/api/paas/v4/chat/completions');
    expect(result.toolCalls?.[0].name).toBe('get_weather');
    expect(result.toolCalls?.[0].arguments).toEqual({ city: 'SF' });
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.cacheReadTokens).toBe(80);
  });
});
