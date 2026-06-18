import { describe, expect, it } from 'bun:test';
import type { AgentMessage } from '@/core/types';
import {
  buildGeminiContents,
  buildStandardEnvelope,
  extractSystemInstruction,
  sanitizeSchemaForGemini,
  type GenericGeminiRequest,
} from './gemini-envelope';

const ts = new Date();

const userMsg = (content: string): AgentMessage => ({ role: 'user', content, timestamp: ts });
const sysMsg = (content: string): AgentMessage => ({ role: 'system', content, timestamp: ts });
const asstMsg = (content: string): AgentMessage => ({ role: 'assistant', content, timestamp: ts });
const toolMsg = (name: string, content: string, id: string): AgentMessage => ({
  role: 'tool', content, name, toolCallId: id, timestamp: ts,
});

describe('buildGeminiContents', () => {
  it('maps user/assistant roles to user/model', () => {
    const out = buildGeminiContents([userMsg('hi'), asstMsg('hello')]);
    expect(out).toEqual([
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ text: 'hello' }] },
    ]);
  });

  it('skips system messages (handled separately)', () => {
    const out = buildGeminiContents([sysMsg('be brief'), userMsg('hi')]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ role: 'user' });
  });

  it('encodes tool messages as functionResponse parts under user role', () => {
    const out = buildGeminiContents([toolMsg('get_weather', '{"temp":12}', 'c1')]);
    expect(out).toEqual([{
      role: 'user',
      parts: [{ functionResponse: { name: 'get_weather', response: { temp: 12 } } }],
    }]);
  });

  it('encodes assistant tool_calls as functionCall parts under model role', () => {
    const out = buildGeminiContents([{
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'get_weather', arguments: { city: 'Berlin' } }],
      timestamp: ts,
    }]);
    expect(out).toEqual([{
      role: 'model',
      parts: [{ functionCall: { name: 'get_weather', args: { city: 'Berlin' } } }],
    }]);
  });

  it('merges consecutive assistant turns so a functionCall follows the user turn', () => {
    // Two back-to-back assistant turns (text-only then tool-call) would emit two
    // adjacent `model` turns — Gemini 400s ("function call turn comes immediately
    // after a user turn…"). They must collapse into one model turn after the user.
    const out = buildGeminiContents([
      userMsg('weather?'),
      asstMsg('let me check'),
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'get_weather', arguments: { city: 'Berlin' } }],
        timestamp: ts,
      },
    ]);
    expect(out).toEqual([
      { role: 'user', parts: [{ text: 'weather?' }] },
      {
        role: 'model',
        parts: [
          { text: 'let me check' },
          { functionCall: { name: 'get_weather', args: { city: 'Berlin' } } },
        ],
      },
    ]);
  });

  it('merges consecutive tool results into one user turn', () => {
    const out = buildGeminiContents([
      toolMsg('get_weather', '{"temp":12}', 'c1'),
      toolMsg('get_time', '{"hour":9}', 'c2'),
    ]);
    expect(out).toEqual([{
      role: 'user',
      parts: [
        { functionResponse: { name: 'get_weather', response: { temp: 12 } } },
        { functionResponse: { name: 'get_time', response: { hour: 9 } } },
      ],
    }]);
  });
});

describe('extractSystemInstruction', () => {
  it('returns undefined when no system messages', () => {
    expect(extractSystemInstruction([userMsg('hi')])).toBeUndefined();
  });

  it('concatenates multiple system messages', () => {
    const out = extractSystemInstruction([sysMsg('one'), userMsg('hi'), sysMsg('two')]);
    expect(out).toEqual({ parts: [{ text: 'one\n\ntwo' }] });
  });
});

describe('buildStandardEnvelope', () => {
  const base: GenericGeminiRequest = {
    model: 'gemini-2.5-flash',
    messages: [userMsg('hi')],
    stream: false,
  };

  it('emits native Gemini shape', () => {
    const body = buildStandardEnvelope({ ...base, temperature: 0.3, maxTokens: 100 });
    expect(body).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 100 },
    });
  });

  it('attaches systemInstruction when system message present', () => {
    const body = buildStandardEnvelope({ ...base, messages: [sysMsg('be brief'), userMsg('hi')] });
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'be brief' }] });
  });

  it('translates tools to functionDeclarations', () => {
    const body = buildStandardEnvelope({
      ...base,
      tools: [{
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      }],
    });
    expect(body.tools).toEqual([{
      functionDeclarations: [{
        name: 'get_weather',
        description: 'Get weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      }],
    }]);
  });

  it('emits thinkingConfig.thinkingBudget=0 when disableThinking is true', () => {
    const body = buildStandardEnvelope({ ...base, disableThinking: true });
    expect((body.generationConfig as any).thinkingConfig).toEqual({ thinkingBudget: 0 });
  });

  it('passes responseSchema through generationConfig', () => {
    const schema = { type: 'OBJECT', properties: { x: { type: 'STRING' } } };
    const body = buildStandardEnvelope({ ...base, responseSchema: schema, responseMimeType: 'application/json' });
    expect((body.generationConfig as any).responseSchema).toEqual(schema);
    expect((body.generationConfig as any).responseMimeType).toBe('application/json');
  });
});

describe('sanitizeSchemaForGemini', () => {
  it('injects items:{type:"string"} for arrays missing items', () => {
    const out = sanitizeSchemaForGemini({
      type: 'object',
      properties: { tags: { type: 'array', description: 'list' } },
    }) as any;
    expect(out.properties.tags.items).toEqual({ type: 'string' });
  });

  it('preserves existing items', () => {
    const out = sanitizeSchemaForGemini({
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'number' } } },
    }) as any;
    expect(out.properties.ids.items).toEqual({ type: 'number' });
  });

  it('injects properties:{} for objects missing properties', () => {
    const out = sanitizeSchemaForGemini({ type: 'object' }) as any;
    expect(out.properties).toEqual({});
  });

  it('strips unsupported keywords (default, additionalProperties)', () => {
    const out = sanitizeSchemaForGemini({
      type: 'object',
      additionalProperties: false,
      properties: { x: { type: 'string', default: 'hi' } },
    }) as any;
    expect(out.additionalProperties).toBeUndefined();
    expect(out.properties.x.default).toBeUndefined();
    expect(out.properties.x.type).toBe('string');
  });

  it('recurses through nested array items', () => {
    const out = sanitizeSchemaForGemini({
      type: 'object',
      properties: {
        wrap: { type: 'array', items: { type: 'array', description: 'nested' } },
      },
    }) as any;
    expect(out.properties.wrap.items.items).toEqual({ type: 'string' });
  });

  it('does not mutate input', () => {
    const input = { type: 'array' as const };
    const out = sanitizeSchemaForGemini(input) as any;
    expect((input as any).items).toBeUndefined();
    expect(out.items).toEqual({ type: 'string' });
  });
});
