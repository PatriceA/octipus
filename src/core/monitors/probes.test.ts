import { describe, expect, test, vi } from 'vitest';
import { readProbe, probe } from './probes';
import type { AgentContext } from '@/core/types';
import { channelCanPrompt } from '@/security/approval-policy';

const find = vi.hoisted(() => vi.fn());
const pipeline = vi.hoisted(() => ({ findById: vi.fn(), getNodes: vi.fn(), getPlanItems: vi.fn() }));
vi.mock('@/tools/registry', () => ({ getToolRegistry: () => ({ findTool: find }) }));
vi.mock('@/db/repositories/pipeline-repository', () => ({ pipelineRepository: pipeline }));
describe('monitor probe boundaries', () => {
  const context = { userId: 'owner', sessionId: 'session', workspaceId: 'workspace' } as AgentContext;
  const source = { kind: 'tool' as const, name: 'get_pipeline_status', args: { id: 'pipeline' }, condition: { path: 'status', operator: 'in' as const, value: ['completed', 'failed', 'paused'] } };
  test('reads an active pipeline without waiting for completion or registry registration', async () => {
    find.mockReturnValue(undefined);
    pipeline.findById.mockResolvedValue({ ...context, id: 'pipeline', status: 'running' });
    pipeline.getNodes.mockResolvedValue([{ nodeKey: 'qa', name: 'QA', status: 'running' }]);
    pipeline.getPlanItems.mockResolvedValue([{ title: 'Phase 1', status: 'running' }]);
    expect(readProbe(source.name, source.args)).toMatchObject({ toolId: 'monitor', permissionAction: 'read' });
    await expect(probe(source, context)).resolves.toMatchObject({ status: 'running', remainingItems: ['Phase 1'] });
    pipeline.findById.mockResolvedValue({ ...context, id: 'pipeline', status: 'completed' });
    await expect(probe(source, context)).resolves.toMatchObject({ status: 'completed' });
  });
  test.each([{ userId: 'other' }, { sessionId: 'other' }, { workspaceId: 'other' }])('pipeline probes preserve caller scope: %o', async mismatch => {
    pipeline.findById.mockResolvedValue({ ...context, id: 'pipeline', status: 'running' });
    await expect(probe(source, { ...context, ...mismatch })).rejects.toThrow('Pipeline not found');
  });
  test('does not expose agent mutations or blocking collection as probes', () => {
    find.mockReturnValue(undefined);
    for (const name of ['resume_pipeline', 'create_pipeline', 'collect_children']) {
      expect(() => readProbe(name, {})).toThrow('Unknown monitor probe');
    }
  });
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
