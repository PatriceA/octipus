import { describe, expect, test } from 'vitest';
import { decodeGatewayEvent } from './gateway-adapter';

describe('decodeGatewayEvent — agent.write extraction', () => {
  test('write_file with content emits agent.write alongside the tool event', () => {
    const out = decodeGatewayEvent({
      type: 'agent.action',
      payload: { data: { type: 'tool_call', toolName: 'write_file', args: { path: '/tmp/x.ts', content: 'hello' } } },
    });
    expect(out.length).toBe(2);
    expect(out[0].kind).toBe('tool');
    expect(out[1].kind).toBe('agent.write');
    if (out[1].kind === 'agent.write') {
      expect(out[1].path).toBe('/tmp/x.ts');
      expect(out[1].newText).toBe('hello');
    }
  });

  test('non-write tool calls do not emit agent.write', () => {
    const out = decodeGatewayEvent({
      type: 'agent.action',
      payload: { data: { type: 'tool_call', toolName: 'read_file', args: { path: '/tmp/x.ts' } } },
    });
    expect(out.length).toBe(1);
    expect(out[0].kind).toBe('tool');
  });

  test('write tools without a path are skipped', () => {
    const out = decodeGatewayEvent({
      type: 'agent.action',
      payload: { data: { type: 'tool_call', toolName: 'write_file', args: { content: 'no path' } } },
    });
    expect(out.length).toBe(1);
  });

  // `new_str` is the replacement for `old_str`, not the file: reporting it as
  // the whole new text made the editor offer to replace the file with it.
  test('str_replace_editor str_replace is an edit of a fragment, never the whole file', () => {
    const out = decodeGatewayEvent({
      type: 'agent.action',
      payload: { data: { type: 'tool_call', toolName: 'str_replace_editor', args: { command: 'str_replace', file_path: '/a.ts', old_str: 'before', new_str: 'patched' } } },
    });
    expect(out.map(e => e.kind)).toEqual(['tool', 'agent.edit']);
    expect(out[1]).toEqual({ kind: 'agent.edit', path: '/a.ts', oldText: 'before', newText: 'patched' });
  });

  test('a lone fragment with nothing to replace is not reported as a write', () => {
    for (const args of [{ path: '/a.ts', new_str: 'patched' }, { path: '/a.ts', command: 'insert', insert_line: 3, new_str: 'x' }, { path: '/a.ts', replacement: 'y' }]) {
      const out = decodeGatewayEvent({ type: 'agent.action', payload: { data: { type: 'tool_call', toolName: 'str_replace_editor', args } } });
      expect(out.map(e => e.kind)).toEqual(['tool']);
    }
  });

  test('str_replace_editor create carries the whole file', () => {
    const out = decodeGatewayEvent({
      type: 'agent.action',
      payload: { data: { type: 'tool_call', toolName: 'str_replace_editor', args: { command: 'create', path: '/new.ts', file_text: 'whole file\n' } } },
    });
    expect(out[1]).toEqual({ kind: 'agent.write', path: '/new.ts', newText: 'whole file\n' });
  });

  test('edit with old_string/new_string is an edit', () => {
    const out = decodeGatewayEvent({
      type: 'agent.action',
      payload: { data: { type: 'tool_call', toolName: 'edit', args: { file_path: '/b.ts', old_string: 'a', new_string: 'b' } } },
    });
    expect(out[1]).toEqual({ kind: 'agent.edit', path: '/b.ts', oldText: 'a', newText: 'b' });
  });
});
