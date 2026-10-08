import { toolActionRepository } from '@/db/repositories/tool-action-repository';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { auditRepository } from '@/db/repositories/audit-repository';
import { messageRepository } from '@/db/repositories/message-repository';
import * as permissions from '@/security/permissions';
import { buildCodemodeHandler } from '@/tools/codemode';
import type { ToolHandler } from './agent-base';
import { ToolExecutor } from './tool-executor';
import type { AgentContext } from './types';

/**
 * A codemode script's calls take the same pipeline as a model-issued call:
 * the permission manager sees the nested tool (not `codemode`), a DENY keeps
 * the tool from running, and only the outer `codemode` call is persisted as a
 * transcript row — the nested results reach the script, never the model.
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

let check: ReturnType<typeof vi.fn>;
let create: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.spyOn(toolActionRepository, 'pending').mockResolvedValue([]);
  vi.spyOn(toolActionRepository, 'start').mockResolvedValue();
  vi.spyOn(toolActionRepository, 'finish').mockResolvedValue();
  vi.spyOn(auditRepository, 'logToolExecuted').mockResolvedValue(undefined as never);
  vi.spyOn(auditRepository, 'logToolDenied').mockResolvedValue(undefined as never);
  create = vi.fn().mockResolvedValue({});
  vi.spyOn(messageRepository, 'create').mockImplementation(create);
  check = vi.fn().mockResolvedValue({ allowed: true, level: 'ALLOW', requiresApproval: false });
  vi.spyOn(permissions, 'getPermissionManager').mockReturnValue({
    check,
  } as unknown as permissions.PermissionManager);
});
afterEach(() => {
  vi.restoreAllMocks();
});

function executorWith(tool: ToolHandler) {
  const exec = new ToolExecutor(makeContext(), () => {});
  exec.registerTool(tool);
  exec.registerTool(buildCodemodeHandler({
    tools: () => Array.from(exec.getTools().values()),
    call: (c) => exec.runNestedCall(c),
  }));
  return exec;
}

const readFile = (execute = vi.fn().mockResolvedValue('line 1\nneedle\nline 3')): ToolHandler => ({
  name: 'filesystem__read_file',
  toolId: 'filesystem',
  permissionAction: 'read',
  description: 'Read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } } },
  execute,
});

const script = (code: string) => [{ id: 'call-cm', name: 'codemode', arguments: { code } }];

describe('codemode nested calls run through the executor pipeline', () => {
  test('the nested tool is permission-checked and only the codemode call is persisted', async () => {
    const execute = vi.fn().mockResolvedValue('line 1\nneedle\nline 3');
    const exec = executorWith(readFile(execute));

    const [msg] = await exec.handleToolCalls(script(`
      const src = await tools.filesystem__read_file({ path: "a.txt" });
      return src.split("\\n").filter((l) => l === "needle");
    `));

    expect(check).toHaveBeenCalledTimes(1);
    expect(check.mock.calls[0]?.[1]).toBe('filesystem');
    expect(check.mock.calls[0]?.[2]).toBe('read');
    expect(execute).toHaveBeenCalledWith({ path: 'a.txt' }, expect.anything());
    expect(msg.content).toContain('needle');
    expect(msg.content).not.toContain('line 1');
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toMatchObject({ toolCallId: 'call-cm' });
    expect(exec.getSideEffectCounters().byName).toMatchObject({ codemode: 1, filesystem__read_file: 1 });
  });

  test('a denied nested call never runs its tool and rejects inside the script', async () => {
    check.mockResolvedValue({ allowed: false, level: 'DENY', requiresApproval: false, reason: 'blocked in test' });
    const execute = vi.fn();
    const exec = executorWith(readFile(execute));

    const [msg] = await exec.handleToolCalls(script(`
      try { await tools.filesystem__read_file({ path: "a.txt" }); return "read"; }
      catch (e) { return "refused: " + e.message; }
    `));

    expect(execute).not.toHaveBeenCalled();
    expect(msg.content).toContain('refused: Permission denied');
  });
});
