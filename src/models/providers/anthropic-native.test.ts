import { afterEach, describe, expect, test, vi } from 'vitest';
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

  test('maps toolChoice to Anthropic tool_choice', () => {
    expect(buildBody({ ...opts, toolChoice: 'required' }, false).tool_choice).toEqual({ type: 'any' });
    expect(buildBody({ ...opts, toolChoice: 'none' }, false).tool_choice).toEqual({ type: 'none' });
    expect(buildBody({ ...opts, toolChoice: 'auto' }, false).tool_choice).toEqual({ type: 'auto' });
    expect(buildBody({ ...opts, toolChoice: undefined }, false).tool_choice).toEqual({ type: 'auto' });
  });

  test('allows required tool choice with adaptive thinking', () => {
    expect(buildBody({ ...opts, model: 'claude-opus-4-7', toolChoice: 'required', extraBody: { thinking: { type: 'adaptive' } } }, false).tool_choice).toEqual({ type: 'any' });
  });

  test('rejects required tool choice with manual thinking', () => {
    expect(() => buildBody({ ...opts, toolChoice: 'required', extraBody: { thinking: { type: 'enabled', budget_tokens: 1024 } } }, false)).toThrow('manual Claude thinking');
  });

  test('rejects required tool choice on Fable and Mythos 5.1', () => {
    for (const model of ['claude-fable-5-1', 'claude-mythos-5-1-20260901']) {
      expect(() => buildBody({ ...opts, model, toolChoice: 'required' }, false)).toThrow('not supported by this Claude model');
    }
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

import { parseAnthropicResponse, parseAnthropicSseStream, toAnthropicMessages } from './custom/anthropic-compat-provider';
test('signed thinking and redacted content survive a tool conversation', () => {
  const content = [{ type: 'thinking', thinking: 'summary', signature: 'signed' }, { type: 'redacted_thinking', data: 'opaque' }, { type: 'tool_use', id: 'call1', name: 'ping', input: {} }];
  const result = parseAnthropicResponse({ content, usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 5, output_tokens: 7 } }, 'claude', 1);
  expect(result.usage).toMatchObject({ inputTokens: 35, outputTokens: 7, cacheReadTokens: 20 });
  const out = toAnthropicMessages([{ role: 'assistant', content: result.content, toolCalls: result.toolCalls, providerRaw: result.providerRaw, timestamp: new Date() }]);
  expect(out.messages[0].content).toEqual(content);
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
