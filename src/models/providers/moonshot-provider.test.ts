import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { MoonshotProvider } from './moonshot-provider';

describe('MoonshotProvider.supportsModel', () => {
  const p = new MoonshotProvider();

  it('matches Kimi / Moonshot model ids', () => {
    for (const m of ['kimi-k2-0711-preview', 'kimi-k2', 'moonshot-v1-8k', 'moonshot-v1-128k']) {
      expect(p.supportsModel(m)).toBe(true);
    }
  });

  it('is case-insensitive', () => {
    expect(p.supportsModel('Kimi-K2')).toBe(true);
  });

  it('does not match other providers', () => {
    for (const m of ['gpt-4o', 'claude-sonnet-4-6', 'deepseek-chat', 'glm-4.6', 'gemini-2.0-flash']) {
      expect(p.supportsModel(m)).toBe(false);
    }
  });

  it('identifies as a direct provider named "moonshot"', () => {
    expect(p.name).toBe('moonshot');
    expect(p.type).toBe('direct');
  });
});

describe('MoonshotProvider.complete', () => {
  const p = new MoonshotProvider();
  const realFetch = globalThis.fetch;
  const realKey = process.env.MOONSHOT_API_KEY;

  beforeEach(() => { process.env.MOONSHOT_API_KEY = 'test-key'; });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.MOONSHOT_API_KEY;
    else process.env.MOONSHOT_API_KEY = realKey;
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
          model: 'kimi-k2-0711-preview',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{
                id: 'call_1',
                type: 'function',
                function: { name: 'lookup', arguments: '{"q":"kimi"}' },
              }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: {
            prompt_tokens: 200,
            completion_tokens: 12,
            total_tokens: 212,
            prompt_tokens_details: { cached_tokens: 150 },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const result = await p.complete({
      model: 'kimi-k2-0711-preview',
      messages: [{ role: 'user', content: 'search kimi' }],
      tools: [{ type: 'function', function: { name: 'lookup', parameters: {} } }],
    } as any);

    expect(capturedUrl).toContain('api.moonshot.ai/v1/chat/completions');
    expect(result.toolCalls?.[0].name).toBe('lookup');
    expect(result.toolCalls?.[0].arguments).toEqual({ q: 'kimi' });
    expect(result.usage.inputTokens).toBe(200);
    expect(result.usage.cacheReadTokens).toBe(150);
  });
});
