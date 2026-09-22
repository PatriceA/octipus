import { beforeEach, expect, it, vi } from 'vitest';
import { answerCliPermissionRequest } from './cli-permissions';
import type { AgentContext } from './types';
const mocks = vi.hoisted(() => ({ check: vi.fn(), requestApproval: vi.fn(), waitForApproval: vi.fn(), cancelWaits: vi.fn() }));
vi.mock('@/security/permissions', () => ({ getPermissionManager: () => mocks }));
const request = { type: 'control_request', request_id: 'r', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'echo hello' }, tool_use_id: 't' } };
const context = (): AgentContext => ({ id: 'a', sessionId: 's', userId: 'u', root: true, attended: true, role: 'general', model: 'cli/claude-code', topic: '', status: 'running', createdAt: new Date(), updatedAt: new Date(), metadata: {} });
beforeEach(() => { vi.resetAllMocks(); mocks.check.mockResolvedValue({ level: 'ASK' }); mocks.requestApproval.mockResolvedValue('approval'); mocks.waitForApproval.mockResolvedValue(true); });
it('relays vendor approval and preserves original user/session identity', async () => {
  const emit = vi.fn();
  expect(await answerCliPermissionRequest(request, context(), emit)).toMatchObject({ response: { request_id: 'r', response: { behavior: 'allow', updatedInput: request.request.input, toolUseID: 't' } } });
  expect(mocks.requestApproval).toHaveBeenCalledWith('u', 'a', 'cli-native:Bash', 'Bash', request.request.input, 's', 'CLI: Bash', undefined);
  expect(emit).toHaveBeenCalledWith('permission_request', expect.objectContaining({ requestId: 'approval' }));
});
it('denies unattended ASK and explicit DENY without requesting approval', async () => {
  expect(await answerCliPermissionRequest(request, { ...context(), attended: false }, vi.fn())).toMatchObject({ response: { response: { behavior: 'deny' } } });
  mocks.check.mockResolvedValue({ level: 'DENY' });
  expect(await answerCliPermissionRequest(request, context(), vi.fn())).toMatchObject({ response: { response: { behavior: 'deny' } } });
  expect(mocks.requestApproval).not.toHaveBeenCalled();
});
it('honors a deny rule added while approval was pending', async () => {
  mocks.check.mockResolvedValueOnce({ level: 'ASK' }).mockResolvedValueOnce({ level: 'DENY' });
  expect(await answerCliPermissionRequest(request, context(), vi.fn())).toMatchObject({ response: { response: { behavior: 'deny' } } });
});
it('consumes and cancels the prepared wait after cancellation during request creation', async () => {
  const ctx = context();
  mocks.requestApproval.mockImplementation(async () => { ctx.status = 'stopped'; return 'approval'; });
  expect(await answerCliPermissionRequest(request, ctx, vi.fn())).toMatchObject({ response: { response: { behavior: 'deny' } } });
  expect(mocks.cancelWaits).toHaveBeenCalledWith(ctx.id);
  expect(mocks.waitForApproval).toHaveBeenCalledWith('approval', { agentId: ctx.id });
});

it('passes cancellation to the approval insert', async () => {
  const controller = new AbortController();
  mocks.requestApproval.mockImplementation(async (...args) => {
    expect(args[7]).toBe(controller.signal);
    controller.abort();
    throw new Error('Agent stopped while creating approval request');
  });
  await expect(answerCliPermissionRequest(request, context(), vi.fn(), controller.signal)).rejects.toThrow(/stopped/);
  expect(mocks.waitForApproval).not.toHaveBeenCalled();
});

const profileTools = () => [{ name: 'profiles__search_profiles', toolId: 'profiles', permissionAction: 'manage', description: '', parameters: {}, execute: async () => null }];
const mcpRequest = (name: string, input: Record<string, unknown> = { query: 'wife' }) => ({ ...request, request: { ...request.request, tool_name: name, input } });
it('routes registered Octipus MCP calls to the canonical executor without synthetic approvals', async () => {
  const result = await answerCliPermissionRequest(mcpRequest('mcp__octipus__profiles__search_profiles'), context(), vi.fn(), undefined, profileTools);
  expect(result).toMatchObject({ response: { response: { behavior: 'allow', updatedInput: { query: 'wife' } } } });
  expect(mocks.check).toHaveBeenCalledWith('u', 'cli-native:mcp__octipus__profiles__search_profiles', 'mcp__octipus__profiles__search_profiles', { query: 'wife' }, expect.anything(), { revalidate: true });
  expect(mocks.requestApproval).not.toHaveBeenCalled();
});
it.each([
  ['mcp__octipus__profiles__delete_profile', {}],
  ['mcp__octipus__call_discovered_tool', { name: 'profiles__delete_profile' }],
  ['mcp__octipus__call_discovered_tool', { name: 'profiles__search_profiles', arguments: 'invalid' }],
])('rejects unavailable or malformed Octipus calls: %s', async (name, input) => {
  const result = await answerCliPermissionRequest(mcpRequest(name, input), context(), vi.fn(), undefined, profileTools);
  expect(result).toMatchObject({ response: { response: { behavior: 'deny' } } });
  expect(mocks.requestApproval).not.toHaveBeenCalled();
});
it('unwraps discovered tools but preserves the vendor input envelope', async () => {
  const input = { name: 'profiles__search_profiles', arguments: { query: 'wife' } };
  const result = await answerCliPermissionRequest(mcpRequest('mcp__octipus__call_discovered_tool', input), context(), vi.fn(), undefined, profileTools);
  expect(result).toMatchObject({ response: { response: { behavior: 'allow', updatedInput: input } } });
});
it('does not trust other MCP servers or an Octipus server outside the run bridge', async () => {
  await answerCliPermissionRequest(mcpRequest('mcp__other__profiles__search_profiles'), context(), vi.fn(), undefined, profileTools);
  expect(mocks.check.mock.calls[0][1]).toBe('cli-native:mcp__other__profiles__search_profiles');
  mocks.check.mockClear();
  await answerCliPermissionRequest(mcpRequest('mcp__octipus__profiles__search_profiles'), context(), vi.fn());
  expect(mocks.check.mock.calls[0][1]).toBe('cli-native:mcp__octipus__profiles__search_profiles');
});
it('rechecks active tool membership and cancellation', async () => {
  const call = mcpRequest('mcp__octipus__profiles__search_profiles');
  for (const [ctx, tools, signal] of [
    [context(), () => [], undefined],
    [{ ...context(), status: 'stopped' }, profileTools, undefined],
    [context(), profileTools, AbortSignal.abort()],
  ] as const) {
    expect(await answerCliPermissionRequest(call, ctx, vi.fn(), signal, tools)).toMatchObject({ response: { response: { behavior: 'deny' } } });
  }
});

it('retains an explicit legacy CLI denial for an Octipus MCP call', async () => {
  mocks.check.mockResolvedValue({ level: 'DENY' });
  expect(await answerCliPermissionRequest(mcpRequest('mcp__octipus__profiles__search_profiles'), context(), vi.fn(), undefined, profileTools))
    .toMatchObject({ response: { response: { behavior: 'deny' } } });
  expect(mocks.requestApproval).not.toHaveBeenCalled();
});
