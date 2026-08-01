import { describe, expect, spyOn, test } from 'bun:test';
import { modelLogger } from '@/utils/logger';
import {
  buildToolShimPrompt,
  parseToolShimResponse,
  proseShowsToolIntent,
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

  test('translator throws ⇒ null (fail-soft, no rethrow) AND warns with elapsed time', async () => {
    const warnSpy = spyOn(modelLogger, 'warn').mockImplementation(() => {});
    try {
      const err = new Error('provider down');
      const call = await translateToToolCall({
        text: 'write a file',
        tools: TOOLS,
        isRegistered: registered,
        complete: async () => { throw err; },
      });
      expect(call).toBeNull();
      // The thrown-error path must NOT be silent, and must NOT be debug-only:
      // a slow/stuck translator burns wall-clock on a turn whose answer is
      // already written, so the elapsed time has to be in the record.
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [ctx, msg] = warnSpy.mock.calls[0] as [{ error: unknown; elapsedMs: number }, string];
      expect(ctx.error).toBe(err);
      expect(ctx.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(msg).toContain('tool-translation failed');
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('successful translation does NOT log a failure breadcrumb', async () => {
    const warnSpy = spyOn(modelLogger, 'warn').mockImplementation(() => {});
    try {
      const call = await translateToToolCall({
        text: 'I will write hello to /a.txt',
        tools: TOOLS,
        isRegistered: registered,
        complete: async () => '{"name":"filesystem__write_file","arguments":{"path":"/a.txt","content":"hello"}}',
      });
      expect(call?.name).toBe('filesystem__write_file');
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
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

describe('proseShowsToolIntent', () => {
  const NAMES = ['filesystem__write_file', 'shell__run', 'spawn_child', 'collect_children'];

  test('a plain final answer shows no tool intent', () => {
    // Verbatim from run 4f88751a, whose orchestrator sat 845s past this answer
    // paying for a translator call that had nothing to translate.
    expect(
      proseShowsToolIntent(
        'The daily update task for WM 2026 has been disabled. It is currently in a dormant state; ' +
          'state your preference if you want it deleted permanently or re-enabled later.',
        NAMES,
      ),
    ).toBe(false);
  });

  test('prose naming an advertised tool does show intent', () => {
    expect(proseShowsToolIntent('Next I will use shell__run to list the directory.', NAMES)).toBe(true);
  });

  test('a half-serialized call envelope shows intent even without a known name', () => {
    expect(proseShowsToolIntent('{"name": "some_tool", "arguments": {"a": 1}', NAMES)).toBe(true);
    expect(proseShowsToolIntent('<tool_call>{"tool":"x"}</tool_call>', NAMES)).toBe(true);
    expect(proseShowsToolIntent('```tool_code\nprint(1)\n```', NAMES)).toBe(true);
  });

  test('tool names match on identifier boundaries, not substrings', () => {
    expect(proseShowsToolIntent('I will respawn_children later.', ['spawn_child'])).toBe(false);
    expect(proseShowsToolIntent('calling spawn_child now', ['spawn_child'])).toBe(true);
  });

  test('regex metacharacters in a tool name cannot break the match', () => {
    expect(proseShowsToolIntent('ran a.b(c)', ['a.b(c)'])).toBe(true);
    expect(proseShowsToolIntent('ran axb(c)', ['a.b(c)'])).toBe(false);
  });

  test('empty prose or no tools ⇒ no intent', () => {
    expect(proseShowsToolIntent('', NAMES)).toBe(false);
    expect(proseShowsToolIntent('   ', NAMES)).toBe(false);
    expect(proseShowsToolIntent('a perfectly ordinary sentence', [])).toBe(false);
  });
});
