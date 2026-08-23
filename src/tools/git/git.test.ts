import { beforeEach, describe, expect, test, vi } from 'vitest';
import { gitTool } from './index';

// The stub lives in a hoisted block because `vi.mock` factories run before
// ordinary top-level statements: a plain `const` here would not exist yet when
// the factory below asks for it.
//
// gitTool only spawns the `git` binary; anything else falls through to the real
// spawn, so a suite that shares this module still gets a working child_process.
// The stub handle carries stdin and kill on top of what gitTool reads, so a
// caller that closes or kills it does not trip over an undefined field.
const { realSpawn, mockSpawn } = vi.hoisted(() => {
  const realSpawn: { current: typeof import('node:child_process').spawn | null } = { current: null };
  const mockSpawn = vi.fn((command: string, args?: readonly string[], options?: object) => {
    if (command !== 'git') {
      return realSpawn.current?.(command, (args as string[]) ?? [], options ?? {});
    }
    return {
      stdout: { on: vi.fn(() => {}) },
      stderr: { on: vi.fn(() => {}) },
      stdin: { write: vi.fn(() => {}), end: vi.fn(() => {}) },
      kill: vi.fn(() => {}),
      on: vi.fn((event: string, callback: (code: number) => void) => {
        if (event === 'close') {
          callback(0);
        }
      }),
    };
  });
  return { realSpawn, mockSpawn };
});

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  realSpawn.current = actual.spawn;
  return { ...actual, spawn: mockSpawn };
});

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

  test('should register all expected tools', async () => {
    await gitTool.initialize();

    const expected = [
      'status', 'log', 'diff', 'add', 'commit', 'branch',
      'checkout', 'pull', 'push', 'stash', 'reset', 'clone',
    ];

    // Every advertised subcommand resolves to a handler, namespaced under
    // the container id (`git__<name>`) and tagged with `toolId: 'git'` so
    // the swarm's permission intersection can match it.
    for (const name of expected) {
      const handler = gitTool.getTool(name);
      expect(handler).toBeDefined();
      expect(handler?.name).toBe(`git__${name}`);
      expect(handler?.toolId).toBe('git');
      expect(typeof handler?.execute).toBe('function');
      expect(handler?.description).toBeTruthy();
    }

    // No stray tools beyond the expected set.
    const registered = gitTool.getToolHandlers().map((h) => h.name).sort();
    expect(registered).toEqual(expected.map((n) => `git__${n}`).sort());
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
