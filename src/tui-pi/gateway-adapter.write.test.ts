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

  test('apply_patch via str_replace_editor with new_str works', () => {
    const out = decodeGatewayEvent({
      type: 'agent.action',
      payload: { data: { type: 'tool_call', toolName: 'str_replace_editor', args: { file_path: '/a.ts', new_str: 'patched' } } },
    });
    expect(out.length).toBe(2);
    if (out[1].kind === 'agent.write') {
      expect(out[1].path).toBe('/a.ts');
      expect(out[1].newText).toBe('patched');
    }
  });
});
