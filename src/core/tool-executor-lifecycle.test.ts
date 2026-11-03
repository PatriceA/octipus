import { toolActionRepository } from '@/db/repositories/tool-action-repository';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { auditRepository } from '@/db/repositories/audit-repository';
import { messageRepository } from '@/db/repositories/message-repository';
import * as permissions from '@/security/permissions';
import * as hooks from '@/hooks/manager';
import { ToolExecutor } from './tool-executor';
import { beginReadOnlyTurn, resetReadOnlyTurns } from '@/security/read-only-turn';
import type { AgentContext, ToolCall } from './types';

const context = (): AgentContext => ({ space: null, trigger: 'user', funding: 'own', 
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

const tool = (name: string, execute: (args?: unknown) => Promise<unknown>, toolId = 'agent') => ({
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
  const completion = events.find(e => e.type === 'tool_call_complete');
  expect(completion?.status).toBe('error');
  expect(completion?.result).toMatchObject({ kind: 'exit', code: 2, tail: 'build failed', ok: false });
  expect(result[0].content).toContain('build failed');
  expect(exec.getSideEffectCounters().toolErrors).toBe(1);
});

describe('consecutive failures block only the failing tool', () => {
  test('a blocked spawn_child cannot execute through a parallel group', async () => {
    const exec = new ToolExecutor(context(), () => {});
    const execute = vi.fn(async () => { throw new Error('spawn unavailable'); });
    exec.registerTools([tool('spawn_child', execute)]);
    for (const id of ['1', '2', '3']) await exec.handleToolCalls([call(id, 'spawn_child')]);
    expect(exec.isToolBlocked('spawn_child')).toBe(true);

    const messages = await exec.handleToolCalls([
      call('4', 'spawn_child', { parallelGroup: 'g' }),
      call('5', 'spawn_child', { parallelGroup: 'g' }),
    ]);
    expect(execute).toHaveBeenCalledTimes(3);
    const replies = messages.filter(m => m.role === 'tool');
    expect(replies).toHaveLength(2);
    for (const reply of replies) expect(String(reply.content)).toMatch(/blocked for this run/);
  });

  test('three failed calls block that tool; others stay available', async () => {
    const exec = new ToolExecutor(context(), () => {});
    exec.registerTools([tool('shell__run', async () => { throw new Error('spawn npx ENOENT'); }), tool('git__diff', async () => 'diff')]);
    for (const id of ['1', '2', '3']) await exec.handleToolCalls([call(id, 'shell__run')]);
    expect(exec.toolsDisabled).toBe(false);
    expect([...exec.getTools().keys()]).toEqual(['git__diff']);
    const [blocked] = await exec.handleToolCalls([call('4', 'shell__run')]);
    expect(String(blocked.content)).toMatch(/blocked for this run/);
  });

  test('script calls (runNestedCall) count too, and the block is announced with the next results', async () => {
    const exec = new ToolExecutor(context(), () => {});
    exec.registerTools([tool('shell__run', async () => { throw new Error('spawn npx ENOENT'); }), tool('git__diff', async () => 'diff')]);
    for (const id of ['1', '2', '3']) await exec.runNestedCall(call(id, 'shell__run'));
    expect(exec.isToolBlocked('shell__run')).toBe(true);
    const messages = await exec.handleToolCalls([call('4', 'git__diff')]);
    expect(messages.some((m) => m.role === 'system' && String(m.content).includes('shell__run'))).toBe(true);
  });

  test('a server that is down never blocks the MCP dispatcher', async () => {
    let up = false;
    const exec = new ToolExecutor(context(), () => {});
    exec.registerTools([tool('mcp_call_tool', async () => { if (!up) throw new Error('MCP server not connected: editor'); return 'ok'; })]);
    for (const id of ['1', '2', '3', '4']) await exec.handleToolCalls([call(id, 'mcp_call_tool')]);
    expect([...exec.getTools().keys()]).toEqual(['mcp_call_tool']);
    up = true;
    const [r] = await exec.handleToolCalls([call('5', 'mcp_call_tool')]);
    expect(String(r.content)).not.toMatch(/blocked/);
  });

  test('a success resets the streak', async () => {
    let fail = true;
    const exec = new ToolExecutor(context(), () => {});
    exec.registerTools([tool('flaky', async () => { if (fail) throw new Error('boom'); return 'ok'; })]);
    await exec.handleToolCalls([call('1', 'flaky')]); await exec.handleToolCalls([call('2', 'flaky')]);
    fail = false; await exec.handleToolCalls([call('3', 'flaky')]);
    fail = true; await exec.handleToolCalls([call('4', 'flaky')]); await exec.handleToolCalls([call('5', 'flaky')]);
    expect(exec.getTools().has('flaky')).toBe(true);
  });

  test('a server that is down counts in neither direction of the failure streak', async () => {
    const exec = new ToolExecutor(context(), () => {});
    exec.registerTools([tool('mcp_call_tool', async () => { throw new Error('MCP server not connected: editor'); }), tool('git__diff', async () => { throw new Error('bad revision'); })]);
    await exec.handleToolCalls([call('1', 'mcp_call_tool')]);
    expect(exec.lastBatchOutcome()).toEqual({ calls: 0, failed: 0, errors: [] });
    await exec.handleToolCalls([call('2', 'mcp_call_tool'), call('3', 'git__diff')]);
    expect(exec.lastBatchOutcome()).toEqual({ calls: 1, failed: 1, errors: [expect.stringContaining('bad revision')] });
  });

  test('different refusals in a row are a model adapting, not a loop', async () => {
    let n = 0;
    const exec = new ToolExecutor(context(), () => {});
    exec.registerTools([tool('shell__run', async () => { throw new Error(`rejected command ${++n}`); })]);
    for (const id of ['1', '2', '3', '4']) await exec.handleToolCalls([call(id, 'shell__run')]);
    expect(exec.isToolBlocked('shell__run')).toBe(false);
  });

  test('the last batch outcome counts calls that returned nothing as failed', async () => {
    const exec = new ToolExecutor(context(), () => {});
    exec.registerTools([tool('shell__run', async () => { throw new Error('rejected command'); }), tool('git__diff', async () => 'diff')]);
    await exec.handleToolCalls([call('1', 'shell__run'), call('2', 'git__diff')]);
    expect(exec.lastBatchOutcome()).toEqual({ calls: 2, failed: 1, errors: [expect.stringContaining('rejected command')] });
    await exec.handleToolCalls([call('3', 'shell__run')]);
    expect(exec.lastBatchOutcome()).toMatchObject({ calls: 1, failed: 1 });
  });
});

describe('a read-only turn', () => {
  afterEach(() => resetReadOnlyTurns());

  test('runs reads, refuses the rest before it executes, delegation included', async () => {
    const ran: string[] = [];
    const exec = new ToolExecutor(context(), () => {});
    exec.registerTools([
      { ...tool('filesystem__read_file', async () => { ran.push('read'); return 'contents'; }, 'filesystem'), permissionAction: 'read' },
      { ...tool('shell__run', async () => { ran.push('shell'); return 'ok'; }, 'shell'), permissionAction: 'execute' },
      tool('spawn_child', async () => { ran.push('spawn'); return 'child'; }),
    ]);
    beginReadOnlyTurn(context().sessionId);
    const [read, shell, spawn] = await exec.handleToolCalls([
      call('1', 'filesystem__read_file'), call('2', 'shell__run'), call('3', 'spawn_child', { parallelGroup: 'g', task: 'x' }),
    ]);
    expect(ran).toEqual(['read']);
    expect(String(read.content)).toBe('contents');
    expect(String(shell.content)).toMatch(/read-only turn: shell.execute is not available/);
    expect(String(spawn.content)).toMatch(/read-only turn: agent.spawn_child/);
  });

  test("the notify step runs without approval even though messaging.send defaults to ASK", async () => {
    vi.spyOn(permissions, 'getPermissionManager').mockReturnValue({
      check: vi.fn().mockResolvedValue({ allowed: false, level: 'ASK', requiresApproval: true }),
    } as unknown as permissions.PermissionManager);
    const sent: unknown[] = [];
    const exec = new ToolExecutor({ ...context(), attended: false }, () => {});
    // As the messaging tool registers it: no permission action, so the call's action is its bare name.
    exec.registerTools([tool('messaging__send_to_user', async (args?: unknown) => { sent.push(args); return 'sent'; }, 'messaging')]);
    beginReadOnlyTurn(context().sessionId);
    const [own] = await exec.handleToolCalls([call('1', 'messaging__send_to_user', { user_id: 'test', message: 'CI red' })]);
    expect(String(own.content)).toBe('sent');
    const [other] = await exec.handleToolCalls([call('2', 'messaging__send_to_user', { user_id: 'someone-else', message: 'x' })]);
    expect(String(other.content)).toMatch(/read-only turn/);
    expect(sent).toHaveLength(1);
  });
});
