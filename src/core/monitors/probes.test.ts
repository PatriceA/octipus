import { describe, expect, test, vi } from 'vitest';
import { readProbe, probe } from './probes';
import type { AgentContext } from '@/core/types';
import { channelCanPrompt } from '@/security/approval-policy';

const find = vi.hoisted(() => vi.fn());
vi.mock('@/tools/registry', () => ({ getToolRegistry: () => ({ findTool: find }) }));
describe('monitor probe boundaries', () => {
  test('arbitrary shell and browser evaluation cannot be polling probes', () => {
    for (const action of ['execute', 'evaluate', 'write', undefined]) {
      find.mockReturnValue({ permissionAction: action });
      expect(() => readProbe('tool', {})).toThrow('read-only');
    }
  });
  test('resolves per-argument permissions before accepting a tool', () => {
    find.mockReturnValue({ permissionAction: (args: Record<string, unknown>) => args.write ? 'write' : 'read' });
    expect(() => readProbe('tool', { write: true })).toThrow();
    expect(readProbe('tool', { write: false })).toBeTruthy();
  });
  test('browser probe goes through the permission-wrapped read tool with exact identity', async () => {
    const execute = vi.fn().mockResolvedValue({ text: 'Succeeded' });
    find.mockReturnValue({ permissionAction: 'extract', replaySafety: 'read_only', execute });
    const source = { kind: 'browser' as const, tabId: 42, url: 'https://ci.example/123', selector: '#status', condition: { path: 'text', operator: 'equals' as const, value: 'Succeeded' } };
    const context = {} as AgentContext;
    await probe(source, context);
    expect(find).toHaveBeenCalledWith('browser-ext__observe');
    expect(execute).toHaveBeenCalledWith({ tabId: 42, url: source.url, selector: '#status' }, context);
  });
  test('event reconciliation uses its read-only fallback', async () => {
    const execute = vi.fn().mockResolvedValue({ status: 'done' });
    find.mockReturnValue({ permissionAction: 'read', execute });
    await expect(probe({ kind: 'event', type: 'pipeline.done', condition: { path: '', operator: 'equals', value: 'done' }, fallback: { kind: 'tool', name: 'ci__status', args: { id: 123 }, condition: { path: 'status', operator: 'equals', value: 'done' } } }, {} as AgentContext)).resolves.toEqual({ status: 'done' });
    expect(execute).toHaveBeenCalledWith({ id: 123 }, {});
  });
  test('monitor continuations never assume an attended approval channel', () => {
    expect(channelCanPrompt('monitor')).toBe(false);
  });
});
