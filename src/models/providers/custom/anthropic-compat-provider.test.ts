import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@/core/types';
import type { CompletionOptions } from '../../litellm-client';
import {
  buildCachedSystem,
  CustomAnthropicCompatProvider,
  toAnthropicMessages,
  toAnthropicTools,
} from './anthropic-compat-provider';

type AnthropicBlockLike = { type: string; id?: string; tool_use_id?: string; [k: string]: unknown };

const ts = new Date();
const userMsg = (content: string): AgentMessage => ({ role: 'user', content, timestamp: ts });
const sysMsg = (content: string): AgentMessage => ({ role: 'system', content, timestamp: ts });
const asstMsg = (content: string): AgentMessage => ({ role: 'assistant', content, timestamp: ts });

afterEach(() => vi.unstubAllGlobals());

describe('buildCachedSystem (Phase 2b breakpoints)', () => {
  const bigStatic = 'S'.repeat(5000); // over the ~1024-token cache minimum

  it('splits at the worker date marker and caches the static prefix', () => {
    const sys = `${bigStatic}\n\nCURRENT DATE/TIME: Tue\n\nmemory block`;
    const out = buildCachedSystem(sys) as Array<{ text: string; cache_control?: unknown }>;
    expect(Array.isArray(out)).toBe(true);
    expect(out[0].text).toBe(bigStatic);
    expect(out[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(out[1].text.startsWith('\n\nCURRENT DATE/TIME:')).toBe(true);
    expect(out[1].cache_control).toBeUndefined(); // volatile part not cached
  });

  it('also matches the rootAgent "DATE & TIME" phrasing', () => {
    const sys = `${bigStatic}\n\nCURRENT DATE & TIME: Tue`;
    const out = buildCachedSystem(sys);
    expect(Array.isArray(out)).toBe(true);
  });

  it('caches an entirely stable system', () => {
    expect(buildCachedSystem(bigStatic)).toEqual([{ type: 'text', text: bigStatic, cache_control: { type: 'ephemeral' } }]);
  });

  it('delegates full-prefix token eligibility to the provider', () => {
    const sys = `tiny static\n\nCURRENT DATE/TIME: Tue`;
    expect(Array.isArray(buildCachedSystem(sys))).toBe(true);
  });
});

describe('toAnthropicMessages', () => {
  it('extracts system messages into the top-level system field', () => {
    const { system, messages } = toAnthropicMessages([sysMsg('be brief'), userMsg('hi')]);
    expect(system).toBe('be brief');
    expect(messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  });

  it('concatenates multiple system messages', () => {
    const { system } = toAnthropicMessages([sysMsg('one'), userMsg('hi'), sysMsg('two')]);
    expect(system).toBe('one\n\ntwo');
  });

  it('omits system when there are no system messages', () => {
    const { system } = toAnthropicMessages([userMsg('hi')]);
    expect(system).toBeUndefined();
  });

  it('encodes assistant tool calls as tool_use blocks', () => {
    const { messages } = toAnthropicMessages([{
      role: 'assistant',
      content: 'let me check',
      toolCalls: [{ id: 'c1', name: 'get_weather', arguments: { city: 'Berlin' } }],
      timestamp: ts,
    }]);
    expect(messages).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: '[Continue from the compacted conversation context.]' }],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'let me check' },
          { type: 'tool_use', id: 'c1', name: 'get_weather', input: { city: 'Berlin' } },
        ],
      },
    ]);
  });

  it('parses stringified tool-call arguments into an object', () => {
    const { messages } = toAnthropicMessages([{
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'f', arguments: '{"a":1}' as unknown as Record<string, unknown> }],
      timestamp: ts,
    }]);
    const blocks = messages[1].content as unknown as Array<Record<string, unknown>>;
    expect(blocks[0]).toEqual({ type: 'tool_use', id: 'c1', name: 'f', input: { a: 1 } });
  });

  it('encodes tool results as tool_result blocks on a user turn', () => {
    const { messages } = toAnthropicMessages([{
      role: 'tool', content: '{"temp":12}', name: 'get_weather', toolCallId: 'c1', timestamp: ts,
    }]);
    expect(messages).toEqual([{
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'c1', content: '{"temp":12}' }],
    }]);
  });

  it('merges a tool result into the preceding user turn to keep roles alternating', () => {
    // assistant tool_use → tool result must stay one user turn, not two.
    const { messages } = toAnthropicMessages([
      userMsg('weather?'),
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'get_weather', arguments: {} }], timestamp: ts },
      { role: 'tool', content: '12C', name: 'get_weather', toolCallId: 'c1', timestamp: ts },
      { role: 'tool', content: 'sunny', name: 'get_sky', toolCallId: 'c2', timestamp: ts },
    ]);
    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe('user');
    expect(messages[1].role).toBe('assistant');
    // Both tool results merged into a single user turn.
    expect(messages[2].role).toBe('user');
    expect(messages[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 'c1', content: '12C' },
      { type: 'tool_result', tool_use_id: 'c2', content: 'sunny' },
    ]);
  });

  it('aligns tool_use fallback ids with tool_result fallback ids when upstream omits ids', () => {
    // No explicit ids + a leading text block: the tool_use id must be call_0
    // (ordinal), not call_1 (block index), so it matches the tool_result that
    // also falls back to call_0.
    const { messages } = toAnthropicMessages([
      { role: 'assistant', content: 'checking', toolCalls: [{ id: '', name: 'f', arguments: {} }], timestamp: ts },
      { role: 'tool', content: 'ok', name: 'f', toolCallId: '', timestamp: ts },
    ]);
    const asstBlocks = messages[1].content as AnthropicBlockLike[];
    const toolUse = asstBlocks.find((b) => b.type === 'tool_use');
    const userBlocks = messages[2].content as AnthropicBlockLike[];
    expect(toolUse?.id).toBe('call_0');
    expect(userBlocks[0].tool_use_id).toBe('call_0');
  });

  it('maps a plain assistant turn to assistant role', () => {
    const { messages } = toAnthropicMessages([userMsg('hi'), asstMsg('hello')]);
    expect(messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    ]);
  });

  it('anchors an already-sliced leading assistant tool call with a user turn', () => {
    const { messages } = toAnthropicMessages([
      sysMsg('Earlier turns were compacted.'),
      {
        role: 'assistant', content: '', timestamp: ts,
        toolCalls: [{ id: 'c1', name: 'get_weather', arguments: { city: 'Berlin' } }],
      },
      { role: 'tool', content: '12C', name: 'get_weather', toolCallId: 'c1', timestamp: ts },
    ]);
    expect(messages.map(message => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(messages[0].content).toEqual([{
      type: 'text', text: '[Continue from the compacted conversation context.]',
    }]);
    expect((messages[1].content as AnthropicBlockLike[])[0]).toMatchObject({
      type: 'tool_use', id: 'c1', name: 'get_weather',
    });
    expect((messages[2].content as AnthropicBlockLike[])[0]).toMatchObject({
      type: 'tool_result', tool_use_id: 'c1',
    });
  });
});

it('sends the repaired compacted history through complete and stream', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (bodies.length === 1) {
      return Response.json({
        id: 'complete-1', model: 'gemini-wire', stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'complete' }],
        usage: { input_tokens: 3, output_tokens: 1 },
      });
    }
    const events = [
      { type: 'message_start', message: { id: 'stream-1', model: 'gemini-wire', usage: { input_tokens: 3 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'streamed' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    ];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
      headers: { 'content-type': 'text/event-stream' },
    });
  }));

  const options: CompletionOptions = {
    model: 'gemini-3.8-flash',
    messages: [
      sysMsg('Earlier turns were compacted.'),
      {
        role: 'assistant', content: '', timestamp: ts,
        toolCalls: [{ id: 'c1', name: 'search', arguments: { q: 'recent' } }],
      },
      { role: 'tool', content: 'result', name: 'search', toolCallId: 'c1', timestamp: ts },
    ],
    tools: [{
      type: 'function',
      function: { name: 'search', description: 'Search', parameters: { type: 'object', properties: {} } },
    }],
    customProviderOverride: {
      baseUrl: 'https://example.test', apiKey: 'test-key', modelId: 'gemini-wire',
      custom: { auth: { type: 'bearer' } },
    },
  };
  const provider = new CustomAnthropicCompatProvider();
  await provider.complete(options);
  const chunks = [];
  for await (const chunk of provider.stream(options)) chunks.push(chunk);

  expect(bodies).toHaveLength(2);
  for (const body of bodies) {
    expect((body.messages as Array<{ role: string }>).map(message => message.role))
      .toEqual(['user', 'assistant', 'user']);
  }
  expect(bodies.map(body => body.stream)).toEqual([false, true]);
  expect(chunks.some(chunk => chunk.content === 'streamed')).toBe(true);
});

describe('toAnthropicTools', () => {
  it('translates OpenAI function tools to Anthropic input_schema shape', () => {
    const out = toAnthropicTools([{
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    }]);
    expect(out).toEqual([{
      name: 'get_weather',
      description: 'Get weather',
      input_schema: { type: 'object', properties: { city: { type: 'string' } } },
    }]);
  });

  it('defaults input_schema when parameters are absent', () => {
    const out = toAnthropicTools([{
      type: 'function',
      function: { name: 'noop', description: 'd' },
    }]) as Array<Record<string, unknown>>;
    expect(out[0].input_schema).toEqual({ type: 'object', properties: {} });
  });
});
