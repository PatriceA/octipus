import { describe, expect, test } from 'bun:test';
import {
  buildToolShimPrompt,
  parseToolShimResponse,
  type ToolShimSchema,
  translateToToolCall,
} from './toolshim';

const TOOLS: ToolShimSchema[] = [
  {
    name: 'filesystem__write_file',
    description: 'Write a file',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } },
  },
  { name: 'shell__run', description: 'Run a shell command', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } },
];

const registered = (name: string) => TOOLS.some((t) => t.name === name);

describe('buildToolShimPrompt', () => {
  test('includes every tool name and the prose', () => {
    const prompt = buildToolShimPrompt('please write the file', TOOLS);
    expect(prompt).toContain('filesystem__write_file');
    expect(prompt).toContain('shell__run');
    expect(prompt).toContain('please write the file');
  });
});

describe('parseToolShimResponse', () => {
  test('parses a clean JSON tool call', () => {
    const call = parseToolShimResponse(
      '{"name":"filesystem__write_file","arguments":{"path":"/a.txt","content":"hi"}}',
      registered,
    );
    expect(call).not.toBeNull();
    expect(call?.name).toBe('filesystem__write_file');
    expect(call?.arguments).toEqual({ path: '/a.txt', content: 'hi' });
    expect(call?.id).toStartWith('call_shim_');
  });

  test('extracts the JSON object when wrapped in prose/markdown fences', () => {
    const content = 'Sure, here you go:\n```json\n{"name":"shell__run","arguments":{"cmd":"ls"}}\n```\nDone.';
    const call = parseToolShimResponse(content, registered);
    expect(call?.name).toBe('shell__run');
    expect(call?.arguments).toEqual({ cmd: 'ls' });
  });

  test('accepts alternate name/args keys (call/parameters)', () => {
    const call = parseToolShimResponse('{"call":"shell__run","parameters":{"cmd":"pwd"}}', registered);
    expect(call?.name).toBe('shell__run');
    expect(call?.arguments).toEqual({ cmd: 'pwd' });
  });

  test('unregistered tool name ⇒ null', () => {
    expect(parseToolShimResponse('{"name":"made_up_tool","arguments":{}}', registered)).toBeNull();
  });

  test('malformed JSON ⇒ null (fail-soft)', () => {
    expect(parseToolShimResponse('{"name": "shell__run", arguments:', registered)).toBeNull();
    expect(parseToolShimResponse('not json at all', registered)).toBeNull();
    expect(parseToolShimResponse('', registered)).toBeNull();
  });

  test('"none" sentinel ⇒ null', () => {
    expect(parseToolShimResponse('{"none":true}', registered)).toBeNull();
  });

  test('missing name ⇒ null', () => {
    expect(parseToolShimResponse('{"arguments":{"cmd":"ls"}}', registered)).toBeNull();
  });

  test('non-object arguments default to {}', () => {
    const call = parseToolShimResponse('{"name":"shell__run","arguments":"ls"}', registered);
    expect(call?.arguments).toEqual({});
  });
});

describe('translateToToolCall', () => {
  test('prose + schema ⇒ valid ToolCall via injected translator', async () => {
    const call = await translateToToolCall({
      text: 'I will write hello to /a.txt',
      tools: TOOLS,
      isRegistered: registered,
      complete: async () => '{"name":"filesystem__write_file","arguments":{"path":"/a.txt","content":"hello"}}',
    });
    expect(call?.name).toBe('filesystem__write_file');
  });

  test('empty tool list ⇒ null without calling the translator', async () => {
    let called = false;
    const call = await translateToToolCall({
      text: 'do something',
      tools: [],
      isRegistered: registered,
      complete: async () => { called = true; return '{}'; },
    });
    expect(call).toBeNull();
    expect(called).toBe(false);
  });

  test('blank prose ⇒ null without calling the translator', async () => {
    let called = false;
    const call = await translateToToolCall({
      text: '   ',
      tools: TOOLS,
      isRegistered: registered,
      complete: async () => { called = true; return '{}'; },
    });
    expect(call).toBeNull();
    expect(called).toBe(false);
  });

  test('translator throws ⇒ null (fail-soft, no rethrow)', async () => {
    const call = await translateToToolCall({
      text: 'write a file',
      tools: TOOLS,
      isRegistered: registered,
      complete: async () => { throw new Error('provider down'); },
    });
    expect(call).toBeNull();
  });

  test('translator returns unregistered name ⇒ null', async () => {
    const call = await translateToToolCall({
      text: 'write a file',
      tools: TOOLS,
      isRegistered: registered,
      complete: async () => '{"name":"nonexistent","arguments":{}}',
    });
    expect(call).toBeNull();
  });
});
