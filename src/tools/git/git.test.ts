import { describe, test, expect, mock, beforeEach } from 'bun:test';
import * as realChildProcess from 'node:child_process';
import { gitTool } from './index';

// Snapshot the real child_process exports BEFORE mock.module replaces them.
// Bun's mock.module is process-wide and mutates the module-namespace bindings
// in place, so reading `realChildProcess.spawn` at call time would resolve
// back to our mock and cause infinite recursion when we try to delegate.
const realSpawn = realChildProcess.spawn;
const realChildProcessSnapshot = { ...realChildProcess };

// gitTool only spawns the `git` binary. For any other command (e.g.
// StdioTransport's `cat`/`sh` smoke tests in src/mcp/transports/) fall
// through to the real spawn so the rest of the suite keeps a working
// child_process. The mocked `git` handle includes stdin and kill on top of
// the fields gitTool consumes, again so other tests that share this mocked
// module don't trip over `undefined.write` / `undefined.kill`.
const mockSpawn = mock((command: string, args?: readonly string[], options?: object) => {
  if (command !== 'git') {
    return realSpawn(command, (args as string[]) ?? [], options ?? {});
  }
  return {
    stdout: { on: mock(() => {}) },
    stderr: { on: mock(() => {}) },
    stdin: { write: mock(() => {}), end: mock(() => {}) },
    kill: mock(() => {}),
    on: mock((event: string, callback: (code: number) => void) => {
      if (event === 'close') {
        callback(0);
      }
    }),
  };
});

mock.module('child_process', () => ({
  ...realChildProcessSnapshot,
  spawn: mockSpawn,
}));

describe('GitTool', () => {
  beforeEach(() => {
    mockSpawn.mockClear();
  });

  test('should have correct tool metadata', () => {
    const manifest = gitTool.getManifest();
    
    expect(manifest.id).toBe('git');
    expect(manifest.name).toBe('Git');
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.description).toBe('Git version control operations');
    
    // Check permissions
    expect(manifest.permissions).toBeDefined();
    expect(Array.isArray(manifest.permissions)).toBe(true);
    
    const readPermission = manifest.permissions?.find(p => p.action === 'read');
    expect(readPermission).toBeDefined();
    expect(readPermission?.defaultLevel).toBe('ALLOW');
    
    const writePermission = manifest.permissions?.find(p => p.action === 'write');
    expect(writePermission).toBeDefined();
    expect(writePermission?.defaultLevel).toBe('ASK');
    
    const pushPermission = manifest.permissions?.find(p => p.action === 'push');
    expect(pushPermission).toBeDefined();
    expect(pushPermission?.defaultLevel).toBe('ASK');
    expect(pushPermission?.dangerous).toBe(true);
  });

  test('should register all expected tools', () => {
    // This test would normally check the registered tools
    // For now, we'll just verify the class structure
    expect(gitTool).toBeDefined();
    expect(typeof gitTool.getManifest).toBe('function');
  });

  test('parseStatus should handle empty output', () => {
    const result = (gitTool as any).parseStatus('');
    
    expect(result.branch).toBe('');
    expect(result.staged).toEqual([]);
    expect(result.modified).toEqual([]);
    expect(result.untracked).toEqual([]);
  });

  test('parseStatus should parse branch information', () => {
    const output = '## main\n';
    const result = (gitTool as any).parseStatus(output);
    
    expect(result.branch).toBe('main');
  });

  test('parseStatus should parse ahead/behind information', () => {
    const output = '## main...origin/main [ahead 2, behind 1]\n';
    const result = (gitTool as any).parseStatus(output);
    
    expect(result.branch).toBe('main');
    expect((result as any).ahead).toBe(2);
    expect((result as any).behind).toBe(1);
  });

  test('parseStatus should parse file statuses', () => {
    const output = `## main
A  staged-file.txt
 M modified-file.txt
?? untracked-file.txt`;
    
    const result = (gitTool as any).parseStatus(output);
    
    expect(result.staged).toContain('staged-file.txt');
    expect(result.modified).toContain('modified-file.txt');
    expect(result.untracked).toContain('untracked-file.txt');
  });
});
