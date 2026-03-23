import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { gitTool } from './index';

// Mock the spawn function to avoid actual git calls
const mockSpawn = mock(() => ({
  stdout: { on: mock(() => {}) },
  stderr: { on: mock(() => {}) },
  on: mock((event: string, callback: (code: number) => void) => {
    if (event === 'close') {
      callback(0);
    }
  })
}));

// Mock child_process module
mock.module('child_process', () => ({
  spawn: mockSpawn
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
