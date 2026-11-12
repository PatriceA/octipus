import { afterEach, expect, it, vi } from 'vitest';
import { getConfig } from '@/config';
import { executionEnvironmentSchema } from '@/shared/execution-environment';
import { routeApprovalFor } from './approval-route';
vi.mock('./approved-calls', () => ({ isApprovedCall: async () => false }));
vi.mock('./workspace-fs', () => ({ isSharedWorkspaceId: async () => false }));
vi.mock('@/core/companion/permissions', () => ({ companionCoordinationAllowed: async () => false, companionActivationAllowed: async () => false, companionMaintenanceAllowed: async () => false, companionMaintenanceProfile: async () => null, companionGoalProfile: async () => null }));
const userId = '11111111-1111-4111-8111-111111111111';
const original = getConfig().security.executionEnvironments;
afterEach(() => { getConfig().security.executionEnvironments = original; });
function set(extra = {}) { getConfig().security.executionEnvironments = [executionEnvironmentSchema.parse({ id: 'host', name: 'Computer', userId, backend: 'host', roots: ['/projects'], isDefault: true, ...extra })]; }
const caller = { userId, sessionId: 'test-session', attended: false, role: 'general' };
const call = { toolId: 'shell', action: 'execute', toolName: 'run', args: { command: 'git push' } };
it('applies broad background approval without a per-command list', async () => {
  set({ background: 'automatic' });
  expect(await routeApprovalFor(caller, call, { level: 'ASK' })).toMatchObject({ route: 'execute', source: 'execution-environment:host:0' });
  expect(await routeApprovalFor(caller, { ...call, args: { command: 'curl http://server/health' } }, { level: 'ASK' })).toMatchObject({ route: 'execute' });
});
it('explicit DENY wins over environment automatic access', async () => {
  set({ background: 'automatic' });
  expect(await routeApprovalFor(caller, call, { level: 'DENY' })).toMatchObject({ route: 'deny' });
});
it('background ASK has an owner inbox instead of a missing approval channel', async () => {
  set({ background: 'ask' });
  expect(await routeApprovalFor(caller, call, { level: 'ASK' })).toMatchObject({ route: 'ask_human' });
});
it('a background read-only policy blocks changes even if tool permission is ALLOW', async () => {
  set({ background: 'deny' });
  expect(await routeApprovalFor(caller, call, { level: 'ALLOW' })).toMatchObject({ route: 'deny' });
});
it('private-data transfer requires the explicit environment transfer grant', async () => {
  set({ background: 'automatic', network: true });
  expect((await routeApprovalFor(caller, call, { level: 'ASK', source: 'flow-guard' })).route).not.toBe('execute');
  set({ background: 'automatic', network: true, allowDataTransfer: true });
  expect((await routeApprovalFor(caller, call, { level: 'ASK', source: 'flow-guard' })).route).toBe('execute');
});
it('background policy is separate from interactive approval', async () => {
  set({ approval: 'automatic', background: 'ask' });
  expect((await routeApprovalFor({ ...caller, attended: true }, call, { level: 'ASK' })).route).toBe('execute');
  expect((await routeApprovalFor(caller, call, { level: 'ASK' })).route).toBe('ask_human');
});
