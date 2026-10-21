import { describe, expect, test } from 'vitest';
import type { MCPServer } from '@/core/types';
import { applyServerEdit, configRevision, configView, mergeServerConfigs } from './config-store';

const server: MCPServer = { id: 'a', name: 'A', command: 'node', args: ['path with spaces.js'], isEnabled: true,
  env: { TOKEN: 'old', KEEP: 'keep' }, headers: { authorization: 'Bearer old', 'X-Key': 'preserved' } };

describe('MCP persistence', () => {
  test('optional undefined fields dropped by JSON storage do not cause false conflicts', () => {
    const snapshot = { ...server, cwd: undefined, description: undefined };
    expect(mergeServerConfigs([snapshot], [], [server])).toEqual([]);
    expect(mergeServerConfigs([], [snapshot], [server])).toEqual([server]);
  });
  test('keeps direct database edits, additions and deletions when saving another field', () => {
    const b = { ...server, id: 'b' };
    const c = { ...server, id: 'c' };
    const current = [{ ...server, command: '/new/path' }, c];
    expect(mergeServerConfigs([server, b], [{ ...server, isEnabled: false }, b], current)).toEqual([
      { ...current[0], isEnabled: false }, c,
    ]);
    expect(current[0].isEnabled).toBe(true);
  });
  test('no-op shutdown/startup persistence cannot overwrite external changes', () => {
    expect(mergeServerConfigs([server], [server], [{ ...server, command: '/external' }])[0].command).toBe('/external');
  });
  test('conflicting edits and deletion of externally edited server fail', () => {
    const current = [{ ...server, command: '/external' }];
    expect(() => mergeServerConfigs([server], [{ ...server, command: '/local' }], current)).toThrow('changed in storage');
    expect(() => mergeServerConfigs([server], [], current)).toThrow('changed in storage');
    expect(() => mergeServerConfigs([server], [{ ...server, command: '/local' }], [])).toThrow('changed in storage');
    expect(() => mergeServerConfigs([], [server], current)).toThrow('changed in storage');
  });
});

describe('MCP editor', () => {
  test('redacts credentials and preserves them on normal edits', () => {
    const view = configView(server);
    expect(view).not.toHaveProperty('headers');
    expect(view).not.toHaveProperty('env');
    expect(view.hasAuthorization).toBe(true);
    expect(applyServerEdit(server, { revision: view.revision, command: '/some path/node' })).toEqual({ ...server, command: '/some path/node' });
  });
  test('replaces/removes authorization without losing custom headers and patches env', () => {
    const next = applyServerEdit(server, { revision: configRevision(server), authorization: 'Bearer new', envPatch: { TOKEN: 'new', KEEP: null } });
    expect(next.headers).toEqual({ Authorization: 'Bearer new', 'X-Key': 'preserved' });
    expect(next.env).toEqual({ TOKEN: 'new' });
    expect(applyServerEdit(next, { revision: configRevision(next), authorization: null }).headers).toEqual({ 'X-Key': 'preserved' });
    expect(server.env?.TOKEN).toBe('old');
    const withCwd = { ...server, cwd: '/old/path' };
    expect(applyServerEdit(withCwd, { revision: configRevision(withCwd), cwd: '' })).not.toHaveProperty('cwd');
  });
  test('rejects stale edits and invalid transports', () => {
    expect(() => applyServerEdit(server, { revision: 'old', name: 'B' })).toThrow('Server changed');
    expect(() => applyServerEdit(server, { revision: configRevision(server), transport: 'sse', sseUrl: 'https://example.com/sse' })).toThrow('valid HTTP URL');
    expect(() => applyServerEdit(server, { revision: configRevision(server), transport: 'streamable-http', sseUrl: 'file:///tmp/token' })).toThrow('HTTP or HTTPS');
  });
});
