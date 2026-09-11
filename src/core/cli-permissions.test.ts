import { beforeEach, expect, it, vi } from 'vitest';
import { answerCliPermissionRequest } from './cli-permissions';
import type { AgentContext } from './types';
const mocks = vi.hoisted(() => ({ check: vi.fn(), requestApproval: vi.fn(), waitForApproval: vi.fn() }));
vi.mock('@/security/permissions', () => ({ getPermissionManager: () => mocks }));
const request = { type: 'control_request', request_id: 'r', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'echo hello' }, tool_use_id: 't' } };
const context = (): AgentContext => ({ id: 'a', sessionId: 's', userId: 'u', root: true, attended: true, role: 'general', model: 'cli/claude-code', topic: '', status: 'running', createdAt: new Date(), updatedAt: new Date(), metadata: {} });
beforeEach(() => { vi.resetAllMocks(); mocks.check.mockResolvedValue({ level: 'ASK' }); mocks.requestApproval.mockResolvedValue('approval'); mocks.waitForApproval.mockResolvedValue(true); });
it('relays vendor approval and preserves original user/session identity', async () => {
  const emit = vi.fn();
  expect(await answerCliPermissionRequest(request, context(), emit)).toMatchObject({ response: { request_id: 'r', response: { behavior: 'allow', updatedInput: request.request.input, toolUseID: 't' } } });
  expect(mocks.requestApproval).toHaveBeenCalledWith('u', 'a', 'cli-native:Bash', 'Bash', request.request.input, 's', 'CLI: Bash');
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
it('does not start an approval wait after cancellation during request creation', async () => {
  const ctx = context();
  mocks.requestApproval.mockImplementation(async () => { ctx.status = 'stopped'; return 'approval'; });
  expect(await answerCliPermissionRequest(request, ctx, vi.fn())).toMatchObject({ response: { response: { behavior: 'deny' } } });
  expect(mocks.waitForApproval).not.toHaveBeenCalled();
});
