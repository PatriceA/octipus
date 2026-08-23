import { describe, expect, test } from 'vitest';
import { extractToolPreview, formatToolCall, registerToolPreview } from './tool-preview';
import type { ToolHandler } from './agent-base';

const makeHandler = (extras: Partial<ToolHandler>): ToolHandler => ({
  name: extras.name ?? 't',
  description: '',
  parameters: {},
  execute: async () => null,
  ...extras,
});

describe('extractToolPreview', () => {
  test('explicit previewParam wins', () => {
    const h = makeHandler({ name: 'my-tool', previewParam: 'key' });
    expect(extractToolPreview(h, { key: 'hello', other: 'x' })).toBe('hello');
  });

  test('explicit previewFn wins over previewParam', () => {
    const h = makeHandler({ name: 'my-tool', previewParam: 'key', previewFn: (p) => `fn:${p.key}` });
    expect(extractToolPreview(h, { key: 'hello' })).toBe('fn:hello');
  });

  test('static registry hit for bash', () => {
    expect(extractToolPreview('bash', { command: 'ls -la' })).toBe('ls -la');
  });

  test('static registry hit for grep', () => {
    expect(extractToolPreview('grep', { pattern: 'foo', path: 'src' })).toBe('foo');
  });

  test('oversize truncated to 80 chars with ellipsis', () => {
    const long = 'x'.repeat(200);
    const result = extractToolPreview('bash', { command: long });
    expect(result.length).toBe(80);
    expect(result.endsWith('…')).toBe(true);
  });

  test('no hint + zero params → empty', () => {
    expect(extractToolPreview('unknown_tool', {})).toBe('');
  });

  test('no hint + some params → count fallback', () => {
    expect(extractToolPreview('unknown_tool', { a: 1, b: 2 })).toBe('2 params');
  });

  test('1 param singular', () => {
    expect(extractToolPreview('unknown_tool', { a: 1 })).toBe('1 param');
  });

  test('MCP prefixed name falls through to tail', () => {
    expect(extractToolPreview('mcp__server__bash', { command: 'echo' })).toBe('echo');
  });

  test('object param stringified', () => {
    const h = makeHandler({ name: 't', previewParam: 'body' });
    expect(extractToolPreview(h, { body: { k: 'v' } })).toBe('{"k":"v"}');
  });

  test('undefined/null value falls through', () => {
    expect(extractToolPreview('bash', { command: null })).toBe('1 param');
    expect(extractToolPreview('bash', { command: undefined })).toBe('1 param');
  });

  test('formatToolCall joins name + preview', () => {
    expect(formatToolCall('bash', { command: 'ls' })).toBe('bash(ls)');
    expect(formatToolCall('bash', {})).toBe('bash()');
  });

  test('runtime registration', () => {
    registerToolPreview('custom_xyz', 'target');
    expect(extractToolPreview('custom_xyz', { target: 'foo' })).toBe('foo');
  });
});
