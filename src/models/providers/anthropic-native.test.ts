import { afterEach, describe, expect, it, test, vi } from 'vitest';
import type { CompletionOptions } from '../litellm-client';
import { AnthropicProvider } from './anthropic-provider';

// Reach the private native request builder (pure — no network).
const buildBody = (o: CompletionOptions, stream: boolean) =>
  (new AnthropicProvider() as unknown as { buildNativeBody(o: CompletionOptions, s: boolean): Record<string, unknown> })
    .buildNativeBody(o, stream);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('AnthropicProvider native /v1/messages body (Phase A2)', () => {
  // > 8192 chars — Sonnet 4.6's minimum cacheable prefix is 2048 tokens
  // (minCacheableChars); below it the split is correctly skipped.
  const bigStatic = 'You are a helpful assistant. '.repeat(400);
  const system = `${bigStatic}\n\nCURRENT DATE & TIME: 2026-07-16`;

  const opts: CompletionOptions = {
    model: 'claude-sonnet-4-6',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: 'hi' },
    ] as CompletionOptions['messages'],
    maxTokens: 1000,
    tools: [{ type: 'function', function: { name: 'ping', description: 'p', parameters: { type: 'object', properties: {} } } }],
  };

  test('assembles a native body with model, max_tokens, messages, tools', () => {
    const body = buildBody(opts, false);
    expect(body.model).toBe('claude-sonnet-4-6');
    expect(body.max_tokens).toBe(1000);
    expect(body.stream).toBe(false);
    expect(Array.isArray(body.messages)).toBe(true);
    expect(Array.isArray(body.tools)).toBe(true); // converted to Anthropic tool shape
  });

  test('caches the static system prefix as cache_control content blocks', () => {
    const body = buildBody(opts, false);
    const sys = body.system as Array<{ type: string; text: string; cache_control?: unknown }>;
    expect(Array.isArray(sys)).toBe(true); // split at the volatile marker, not a plain string
    expect(sys[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(sys[1].cache_control).toBeUndefined(); // volatile part uncached
  });

  test('stream flag flows through', () => {
    expect(buildBody(opts, true).stream).toBe(true);
  });

  test('never forces a tool call on any Claude model', () => {
    // Forced tool choice is a 400 on current Claude models (and with thinking
    // on older ones); `required` is an escalation, sent as `auto` for all.
    for (const model of ['claude-sonnet-4-6', 'claude-opus-4-7', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-next-9']) {
      expect(buildBody({ ...opts, model, toolChoice: 'required' }, false).tool_choice).toEqual({ type: 'auto' });
    }
    expect(buildBody({ ...opts, toolChoice: 'required', extraBody: { thinking: { type: 'enabled', budget_tokens: 1024 } } }, false).tool_choice).toEqual({ type: 'auto' });
    expect(buildBody({ ...opts, toolChoice: 'none' }, false).tool_choice).toEqual({ type: 'none' });
    expect(buildBody({ ...opts, toolChoice: 'auto' }, false).tool_choice).toEqual({ type: 'auto' });
    expect(buildBody({ ...opts, toolChoice: undefined }, false).tool_choice).toEqual({ type: 'auto' });
  });

  test('sends no sampling parameters to any Claude model', () => {
    for (const model of ['claude-sonnet-4-6', 'claude-haiku-5-5', 'claude-next-9']) {
      const body = buildBody({ ...opts, model, temperature: 0.7, topP: 0.9, extraBody: { top_k: 5 } }, false);
      expect(body).not.toHaveProperty('temperature');
      expect(body).not.toHaveProperty('top_p');
      expect(body).not.toHaveProperty('top_k');
    }
  });

  test("cachePolicy 'session' caches for an hour, on every breakpoint", () => {
    const messages = [...(opts.messages as CompletionOptions['messages']), { role: 'assistant', content: 'a', timestamp: new Date() }, { role: 'user', content: 'b', timestamp: new Date() }] as CompletionOptions['messages'];
    const body = buildBody({ ...opts, messages, cachePolicy: 'session', cacheScope: 'root:' }, false);
    expect((body.system as Array<{ cache_control?: unknown }>)[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    const marked = (body.messages as Array<{ content: unknown }>).flatMap(m => (Array.isArray(m.content) ? m.content : [])).filter((b: any) => b.cache_control);
    expect(marked.map((b: any) => b.cache_control)).toEqual([{ type: 'ephemeral', ttl: '1h' }]);
    expect((buildBody(opts, false).system as Array<{ cache_control?: unknown }>)[0].cache_control).toEqual({ type: 'ephemeral' });
  });
});

describe('replayed thinking on the native API', () => {
  const thinking = { type: 'thinking', thinking: '', signature: 'sig' };
  const conversation = (raw?: unknown[]) => [
    { role: 'user', content: 'q', timestamp: new Date() },
    { role: 'assistant', content: 'a', timestamp: new Date(), ...(raw ? { providerRaw: { anthropicContent: raw } } : {}) },
    { role: 'user', content: 'next', timestamp: new Date() },
  ] as CompletionOptions['messages'];
  const send = async (o: Partial<CompletionOptions>) => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => Response.json({
      id: 'm', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 }, input_transformations: [],
    }));
    vi.stubGlobal('fetch', fetchMock);
    await new AnthropicProvider().complete({ model: 'claude-opus-5-5', messages: [], ...o });
    const init = fetchMock.mock.calls[0][1];
    return { headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) };
  };

  test('asks the API to drop, not reject, thinking whose conversation changed', async () => {
    const { headers, body } = await send({ messages: conversation([thinking, { type: 'text', text: 'a' }]) });
    expect(headers['anthropic-beta']).toBe('thinking-binding-controls-2026-08-01');
    expect(body.thinking).toEqual({ type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
  });

  test('keeps an explicit thinking configuration and adds only the binding', async () => {
    const { body } = await send({ messages: conversation([thinking]), extraBody: { thinking: { type: 'enabled', budget_tokens: 2048 } } });
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 2048, block_binding: { prefix_mismatch_behavior: 'drop_block' } });
  });

  test('leaves requests without replayed thinking, or with thinking off, unchanged', async () => {
    const plain = await send({ messages: conversation() });
    expect(plain.headers['anthropic-beta']).toBeUndefined();
    expect(plain.body.thinking).toBeUndefined();
    const off = await send({ messages: conversation([thinking]), extraBody: { thinking: { type: 'between_tools' } } });
    expect(off.headers['anthropic-beta']).toBeUndefined();
    expect(off.body.thinking).toEqual({ type: 'between_tools' });
  });
});

test('native completion observes usage before malformed content parsing fails', async () => {
  vi.stubEnv('ANTHROPIC_NATIVE_MESSAGES', '1');
  vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    id: 'msg_paid',
    model: 'claude-wire-model',
    content: {},
    usage: { input_tokens: 10, cache_read_input_tokens: 4, output_tokens: 3 },
  })));

  let observed: unknown;
  await expect(new AnthropicProvider().complete({
    model: 'claude-request-model',
    messages: [],
    accountingResponse: (value) => { observed = value; },
  })).rejects.toThrow();

  expect(observed).toMatchObject({
    model: 'claude-wire-model',
    requestId: 'msg_paid',
    usage: { inputTokens: 14, outputTokens: 3, totalTokens: 17, available: true },
  });
});

import { markHistoryCacheBreakpoint, parseAnthropicResponse, parseAnthropicSseStream, toAnthropicMessages } from './custom/anthropic-compat-provider';
test('signed thinking and redacted content survive a tool conversation', () => {
  const content = [{ type: 'thinking', thinking: 'summary', signature: 'signed' }, { type: 'redacted_thinking', data: 'opaque' }, { type: 'tool_use', id: 'call1', name: 'ping', input: {} }];
  const result = parseAnthropicResponse({ content, usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 5, output_tokens: 7 } }, 'claude', 1);
  expect(result.usage).toMatchObject({ inputTokens: 35, outputTokens: 7, cacheReadTokens: 20 });
  const out = toAnthropicMessages([{ role: 'assistant', content: result.content, toolCalls: result.toolCalls, providerRaw: result.providerRaw, timestamp: new Date() }]);
  expect(out.messages.map(message => message.role)).toEqual(['user', 'assistant']);
  expect(out.messages[1].content).toEqual(content);
});
test('native SSE preserves signed thinking and final cumulative usage', async () => {
  const events = [
    { type: 'message_start', message: { id: 'msg1', model: 'claude', usage: { input_tokens: 10, cache_read_input_tokens: 20 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'summary' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
  ];
  const body = new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('')).body!;
  const chunks = [];
  for await (const chunk of parseAnthropicSseStream(body, 'anthropic')) chunks.push(chunk);
  expect(chunks.at(-1)).toMatchObject({ requestId: 'msg1', usage: { inputTokens: 30, outputTokens: 7 }, providerRaw: { anthropicContent: [{ type: 'thinking', thinking: 'summary', signature: 'signed' }] } });
});
test('native JSON schema mapping and cache suppression', () => {
  const body = buildBody({ model: 'claude-sonnet-4-6', messages: [], responseFormat: { type: 'json_schema', json_schema: { name: 'answer', schema: { type: 'object', properties: {} } } } }, false);
  expect(body.output_config).toMatchObject({ format: { type: 'json_schema' } });
});

describe('history cache breakpoint', () => {
  it('marks the latest eligible input for reuse on the next request', () => {
    const { messages } = toAnthropicMessages([
      { role: 'user', content: 'first', timestamp: new Date() },
      { role: 'assistant', content: 'answer', timestamp: new Date() },
      { role: 'user', content: 'second', timestamp: new Date() },
    ]);
    markHistoryCacheBreakpoint(messages, true);
    const marked = messages.flatMap(m => (Array.isArray(m.content) ? m.content : [])).filter((b: any) => b.cache_control);
    expect(marked).toHaveLength(1);
    // The newest turn must stay uncached — it is what changed.
    const newest = messages[messages.length - 1].content as any[];
    expect(newest.some(b => b.cache_control)).toBe(true);
  });

  it('M3 — never marks a thinking block, which Anthropic 400s on', () => {
    const messages = [
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'reasoning...', signature: 'sig' },
        { type: 'text', text: 'answer' },
        { type: 'redacted_thinking', data: 'blob' },
      ] },
    ] as any[];
    expect(markHistoryCacheBreakpoint(messages, true)).toBe(true);
    const blocks = messages[0].content;
    expect(blocks[1].cache_control).toEqual({ type: 'ephemeral' }); // the text block
    expect(blocks[0].cache_control).toBeUndefined();
    expect(blocks[2].cache_control).toBeUndefined();
  });

  it('M3 — places no breakpoint on a turn that is nothing but thinking', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'only reasoning', signature: 'sig' }] },
    ] as any[];
    expect(markHistoryCacheBreakpoint(messages, true)).toBe(false);
    expect(messages[0].content[0].cache_control).toBeUndefined();
  });

  it('marks the first input to warm the next request', () => {
    const { messages } = toAnthropicMessages([{ role: 'user', content: 'only', timestamp: new Date() }]);
    expect(markHistoryCacheBreakpoint(messages, true)).toBe(true);
  });
});

test('cache placement never mutates the saved provider-native blocks', () => {
  const raw = [{ type: 'text', text: 'answer' }];
  const history = [{ role: 'assistant' as const, content: 'answer', timestamp: new Date(), providerRaw: { anthropicContent: raw } }];
  const first = toAnthropicMessages(history); markHistoryCacheBreakpoint(first.messages);
  expect(raw).toEqual([{ type: 'text', text: 'answer' }]);
});
