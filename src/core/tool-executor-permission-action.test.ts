import { auditRepository } from '@/db/repositories/audit-repository';
import { toolActionRepository } from '@/db/repositories/tool-action-repository';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { messageRepository } from '@/db/repositories/message-repository';
import * as permissions from '@/security/permissions';
import type { ToolHandler } from './agent-base';
import { ToolExecutor } from './tool-executor';
import type { AgentContext, ToolCall } from './types';

/**
 * Which action the agent loop checks a tool call under.
 *
 * Manifests declare coarse verbs (`read`, `write`, `execute`) and each tool
 * registers the verb it belongs to. The loop used to look permissions up by the
 * namespaced call name instead, which matches no declared permission — so a
 * tool whose manifest says ALLOW fell through to the ASK default, and an
 * API-driven run stalled on an approval prompt it had no channel to answer.
 *
 * The assertion is on the arguments the permission manager was actually called
 * with, because that is the thing that was wrong.
 */

function makeContext(): AgentContext {
  return { space: null, trigger: 'user', funding: 'own', 
    id: 'agent-test',
    sessionId: '00000000-0000-0000-0000-000000000000',
    userId: 'user-test',
    model: 'test',
    topic: '',
    role: 'general',
    root: true,
    status: 'running',
    createdAt: new Date(),
    updatedAt: new Date(),
    metadata: {},
  };
}

const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({
  id: `call-${name}`,
  name,
  arguments: args,
});

let check: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.spyOn(auditRepository, 'logToolExecuted').mockResolvedValue();
  vi.spyOn(auditRepository, 'logToolDenied').mockResolvedValue();
  vi.spyOn(toolActionRepository, 'pending').mockResolvedValue([]);
  vi.spyOn(toolActionRepository, 'start').mockResolvedValue();
  vi.spyOn(toolActionRepository, 'finish').mockResolvedValue();
  vi.spyOn(messageRepository, 'create').mockResolvedValue({} as never);
  check = vi.fn().mockResolvedValue({ allowed: true, level: 'ALLOW', requiresApproval: false });
  vi.spyOn(permissions, 'getPermissionManager').mockReturnValue({
    check,
  } as unknown as permissions.PermissionManager);
});
afterEach(() => {
  vi.restoreAllMocks();
});

function run(handler: ToolHandler, args: Record<string, unknown> = {}) {
  const exec = new ToolExecutor(makeContext(), () => {});
  exec.registerTool(handler);
  return exec.handleToolCalls([call(handler.name, args)]);
}

const base = {
  toolId: 'task_state',
  description: 'x',
  parameters: {},
  execute: async () => 'ok',
};

describe('the agent loop resolves a tool call to its declared permission action', () => {
  test("a tool's permissionAction is what gets checked, not the call name", async () => {
    await run({ ...base, name: 'task_state__list_recent_session_tasks', permissionAction: 'read' });

    expect(check).toHaveBeenCalledTimes(1);
    expect(check.mock.calls[0]?.[1]).toBe('task_state');
    expect(check.mock.calls[0]?.[2]).toBe('read');
  });

  test('a per-call permissionAction is resolved against the live arguments', async () => {
    await run(
      {
        ...base,
        toolId: 'shell',
        name: 'shell__run',
        permissionAction: (args) => (args.sudo ? 'execute_elevated' : 'execute'),
      },
      { sudo: true },
    );

    expect(check.mock.calls[0]?.[2]).toBe('execute_elevated');
  });

  test('a tool that declares no action falls back to the BARE name, as base-tool does', async () => {
    // Not `custom__do_thing`: the other dispatch path checks `do_thing`, and a
    // stored ALLOW/DENY has to mean the same thing on both.
    await run({ ...base, toolId: 'custom', name: 'custom__do_thing' });

    expect(check.mock.calls[0]?.[2]).toBe('do_thing');
  });

  test('an un-namespaced tool name is passed through unchanged', async () => {
    // Not `toolId: 'agent'` — meta-tools take a fast path that skips the
    // permission check entirely, so nothing would be asserted.
    await run({ ...base, toolId: 'custom', name: 'do_thing' });

    expect(check.mock.calls[0]?.[2]).toBe('do_thing');
  });

  test('a handler that declares itself read-only defaults to ALLOW; anything else leaves the default alone', async () => {
    // An ad-hoc handler has no manifest, so without this the discovery
    // meta-tools (`list_tools`, `capabilities`, `mcp_list_tools`) fell to ASK
    // and an unattended channel refused them outright.
    await run({ ...base, toolId: 'custom', name: 'list_things', replaySafety: 'read_only' });
    expect(check.mock.calls[0]?.[5]).toEqual({ defaultLevel: 'ALLOW' });

    await run({ ...base, toolId: 'custom', name: 'do_thing' });
    expect(check.mock.calls[1]?.[5]).toEqual({ defaultLevel: undefined });
  });
});


test('per-call recovery safety skips journaling without granting permission', async () => {
  const handler: ToolHandler = { ...base, toolId: 'mcp', name: 'mcp_call_tool',
    permissionAction: args => `server.${args.tool_name}`,
    recoverySafety: args => args.tool_name === 'verified_read' ? 'read_only' : undefined };
  await run(handler, { tool_name: 'verified_read' });
  expect(toolActionRepository.pending).not.toHaveBeenCalled();
  expect(toolActionRepository.start).not.toHaveBeenCalled();
  expect(check.mock.calls[0]?.[5]).toEqual({ defaultLevel: undefined });
  await run(handler, { tool_name: 'write' });
  expect(toolActionRepository.start).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'server.write' }));
});


test('a read-only recovery hint never bypasses an explicit permission denial', async () => {
  check.mockResolvedValue({ allowed: false, level: 'DENY', requiresApproval: false });
  const execute = vi.fn();
  await run({ ...base, name: 'mcp_call_tool', toolId: 'mcp', permissionAction: 'server.read',
    recoverySafety: () => 'read_only', execute });
  expect(execute).not.toHaveBeenCalled();
  expect(toolActionRepository.start).not.toHaveBeenCalled();
});


test('a registered shell no-match logs info and contributes no tool error (#73)', async () => {
  const { ShellTool } = await import('@/tools/shell');
  const { toolLogger } = await import('@/utils/logger');
  const info = vi.spyOn(toolLogger, 'info').mockImplementation(() => {});
  const warn = vi.spyOn(toolLogger, 'warn').mockImplementation(() => {});
  vi.spyOn(auditRepository, 'log').mockResolvedValue(undefined as never);
  const command = "git grep -l -I -E '(BEGIN PRIVATE KEY|AKIA[0-9]+|gh[pousr]_)'";
  const operations = { exec: vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: '', killed: false })) };
  const shell = new ShellTool(operations as never);
  await shell.initialize();
  const context = { ...makeContext(), userId: '33333333-3333-3333-3333-333333333333' };
  const exec = new ToolExecutor(context, () => {});
  exec.registerTool(shell.getTool('run')!);
  const response = await exec.handleToolCalls([call('shell__run', { command })]);
  expect(operations.exec).toHaveBeenCalledOnce();
  expect(response[0].content).toContain('no_match');
  expect(exec.getSideEffectCounters()).toMatchObject({ commandsRun: 1, toolErrors: 0 });
  expect(info).toHaveBeenCalledWith(expect.objectContaining({ semantic: 'no_match', exitCode: 1 }), 'Shell search completed with no matches');
  expect(warn.mock.calls.some(args => args[1] === 'Shell command failed')).toBe(false);
});
