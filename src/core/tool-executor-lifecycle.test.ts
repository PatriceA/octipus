import { toolActionRepository } from '@/db/repositories/tool-action-repository';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { auditRepository } from '@/db/repositories/audit-repository';
import { messageRepository } from '@/db/repositories/message-repository';
import * as permissions from '@/security/permissions';
import * as hooks from '@/hooks/manager';
import { ToolExecutor } from './tool-executor';
import type { AgentContext, ToolCall } from './types';

const context = (): AgentContext => ({
  id: 'lifecycle-agent', sessionId: '00000000-0000-0000-0000-000000000000',
  userId: 'test', model: 'test', topic: '', role: 'general', root: true,
  status: 'running', createdAt: new Date(), updatedAt: new Date(), metadata: {},
});
const call = (id: string, name: string, args = {}): ToolCall => ({ id, name, arguments: args });

beforeEach(() => {
  vi.spyOn(toolActionRepository, 'pending').mockResolvedValue([]);
  vi.spyOn(toolActionRepository, 'start').mockResolvedValue();
  vi.spyOn(toolActionRepository, 'finish').mockResolvedValue();
  vi.spyOn(messageRepository, 'create').mockResolvedValue({} as never);
  vi.spyOn(auditRepository, 'logToolExecuted').mockResolvedValue(undefined as never);
  vi.spyOn(permissions, 'getPermissionManager').mockReturnValue({
    check: vi.fn().mockResolvedValue({ allowed: true, level: 'ALLOW', requiresApproval: false }),
  } as unknown as permissions.PermissionManager);
});
afterEach(() => vi.restoreAllMocks());

const tool = (name: string, execute: () => Promise<unknown>, toolId = 'agent') => ({
  name, execute, toolId, parameters: {}, description: '',
});

describe('tool dispatch lifecycle', () => {
  test.each(['stopped', 'failed'] as const)('a %s worker executes no internal or parallel tools', async status => {
    const ctx = context(); ctx.status = status;
    const exec = new ToolExecutor(ctx, () => {});
    const execute = vi.fn().mockResolvedValue('ran');
    exec.registerTools([tool('spawn_child', execute), tool('internal', execute)]);
    await expect(exec.handleToolCalls([
      call('1', 'spawn_child', { parallelGroup: 'g' }), call('2', 'spawn_child', { parallelGroup: 'g' }), call('3', 'internal'),
    ])).rejects.toThrow(/stopped/);
    expect(execute).not.toHaveBeenCalled();
  });

  test('cancellation during one tool prevents the next internal tool', async () => {
    const ctx = context(); const controller = new AbortController();
    const exec = new ToolExecutor(ctx, () => {}, undefined, controller.signal);
    const next = vi.fn().mockResolvedValue('should not run');
    exec.registerTools([tool('first', async () => { controller.abort(); return 'done'; }), tool('next', next)]);
    await expect(exec.handleToolCalls([call('1', 'first'), call('2', 'next')])).rejects.toThrow(/stopped/);
    expect(next).not.toHaveBeenCalled();
  });

  test('cancellation while a pre-tool hook awaits prevents the side effect', async () => {
    const ctx = context();
    vi.spyOn(hooks, 'getHookManager').mockReturnValue({ triggerToolHooks: async () => {
      ctx.status = 'stopped'; return { decision: 'allow' };
    } } as unknown as hooks.HookManager);
    const execute = vi.fn().mockResolvedValue('written');
    const exec = new ToolExecutor(ctx, () => {});
    exec.registerTool(tool('custom__write', execute, 'custom'));
    await expect(exec.handleToolCalls([call('1', 'custom__write')])).rejects.toThrow(/stopped/);
    expect(execute).not.toHaveBeenCalled();
  });

  test('an audit failure does not turn an executed action into a retryable tool failure', async () => {
    vi.spyOn(auditRepository, 'logToolExecuted').mockRejectedValue(new Error('audit unavailable'));
    const events: Array<Record<string, unknown>> = [];
    const exec = new ToolExecutor(context(), (_, data) => events.push(data as Record<string, unknown>));
    const execute = vi.fn().mockResolvedValue('written successfully');
    exec.registerTool(tool('custom__write', execute, 'custom'));
    const messages = await exec.handleToolCalls([call('write-1', 'custom__write')]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(messages.filter(m => m.role === 'tool')).toHaveLength(1);
    expect(messages[0].content).toBe('written successfully');
    expect(events.filter(e => e.type === 'tool_call_complete').map(e => e.status)).toEqual(['ok']);
    expect(exec.getSideEffectCounters().toolErrors).toBe(0);
  });

  test('settlement remains pending until the tool actually returns', async () => {
    let finish!: () => void;
    const ctx = context(); const exec = new ToolExecutor(ctx, () => {});
    exec.registerTool(tool('waiting', () => new Promise<void>(resolve => { finish = resolve; })));
    const run = exec.handleToolCalls([call('1', 'waiting')]);
    await vi.waitFor(() => expect(finish).toBeDefined());
    ctx.status = 'stopped';
    expect(exec.isExecuting()).toBe(true);
    finish(); await run;
    expect(exec.isExecuting()).toBe(false);
  });
});


test('a failed shell command is shown as failed and keeps its diagnostic output', async () => {
  const events: Array<Record<string, unknown>> = [];
  const exec = new ToolExecutor(context(), (_, data) => events.push(data as Record<string, unknown>));
  exec.registerTool(tool('shell__run', async () => ({ outcome: 'error', exitCode: 2, stderr: 'build failed' }), 'shell'));
  const result = await exec.handleToolCalls([call('shell-fail', 'shell__run')]);
  expect(events.find(e => e.type === 'tool_call_complete')?.status).toBe('error');
  expect(result[0].content).toContain('build failed');
  expect(exec.getSideEffectCounters().toolErrors).toBe(1);
});
