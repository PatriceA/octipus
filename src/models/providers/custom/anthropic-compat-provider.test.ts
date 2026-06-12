import { describe, expect, it } from 'bun:test';
import type { AgentMessage } from '@/core/types';
import { toAnthropicMessages, toAnthropicTools } from './anthropic-compat-provider';

type AnthropicBlockLike = { type: string; id?: string; tool_use_id?: string; [k: string]: unknown };

const ts = new Date();
const userMsg = (content: string): AgentMessage => ({ role: 'user', content, timestamp: ts });
const sysMsg = (content: string): AgentMessage => ({ role: 'system', content, timestamp: ts });
const asstMsg = (content: string): AgentMessage => ({ role: 'assistant', content, timestamp: ts });

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
    expect(messages).toEqual([{
      role: 'assistant',
      content: [
        { type: 'text', text: 'let me check' },
        { type: 'tool_use', id: 'c1', name: 'get_weather', input: { city: 'Berlin' } },
      ],
    }]);
  });

  it('parses stringified tool-call arguments into an object', () => {
    const { messages } = toAnthropicMessages([{
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'f', arguments: '{"a":1}' as unknown as Record<string, unknown> }],
      timestamp: ts,
    }]);
    const blocks = messages[0].content as unknown as Array<Record<string, unknown>>;
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
    const asstBlocks = messages[0].content as AnthropicBlockLike[];
    const toolUse = asstBlocks.find((b) => b.type === 'tool_use');
    const userBlocks = messages[1].content as AnthropicBlockLike[];
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
