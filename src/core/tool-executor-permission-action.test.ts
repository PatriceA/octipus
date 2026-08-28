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
  return {
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
});
