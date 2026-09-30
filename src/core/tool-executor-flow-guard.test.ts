import { toolActionRepository } from '@/db/repositories/tool-action-repository';
import { auditRepository } from '@/db/repositories/audit-repository';
import { messageRepository } from '@/db/repositories/message-repository';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as permissions from '@/security/permissions';
import { getFlowLabel, resetFlowLabels } from '@/security/flow-guard';
import type { ToolHandler } from './agent-base';
import { ToolExecutor } from './tool-executor';
import type { AgentContext } from './types';

const vault = vi.hoisted(() => ({ canAccessByName: vi.fn() }));
vi.mock('@/security/vault', () => ({ getVault: () => vault }));

/** The direct-provider loop feeds the flow label and lets it escalate ALLOW. */

const SESSION = '00000000-0000-0000-0000-00000000f10w';
const context = (): AgentContext => ({
  id: 'agent-flow', sessionId: SESSION, userId: 'user-test', model: 'test', topic: '', role: 'general',
  root: true, attended: false, status: 'running', createdAt: new Date(), updatedAt: new Date(), metadata: {},
});

const readFile: ToolHandler = { name: 'filesystem__read_file', toolId: 'filesystem', permissionAction: 'read',
  replaySafety: 'read_only', description: '', parameters: {}, execute: async () => 'SECRET=1' };
const send = vi.fn(async () => 'sent');
const sendMessage: ToolHandler = { name: 'messaging__send', toolId: 'messaging', permissionAction: 'send',
  recordsActions: true, description: '', parameters: {}, execute: send };

beforeEach(() => {
  resetFlowLabels();
  vi.spyOn(toolActionRepository, 'pending').mockResolvedValue([]);
  vi.spyOn(messageRepository, 'create').mockResolvedValue({} as never);
  vi.spyOn(auditRepository, 'logToolDenied').mockResolvedValue(undefined as never);
  vi.spyOn(auditRepository, 'logToolExecuted').mockResolvedValue(undefined as never);
  const check = vi.fn().mockResolvedValue({ allowed: true, level: 'ALLOW', requiresApproval: false });
  vault.canAccessByName.mockImplementation(async (owner: string, name: string, opts: { toolId?: string }) =>
    owner === 'user-test' && name === 'slack_token' && opts.toolId === 'messaging');
  vi.spyOn(permissions, 'getPermissionManager').mockReturnValue({ check } as unknown as permissions.PermissionManager);
});
afterEach(() => { vi.restoreAllMocks(); resetFlowLabels(); send.mockClear(); });

test('a send after a credential read is held for approval; unattended it is blocked with the reason', async () => {
  const exec = new ToolExecutor(context(), () => {});
  exec.registerTool(readFile);
  exec.registerTool(sendMessage);

  await exec.handleToolCalls([{ id: 'c1', name: 'messaging__send', arguments: { text: 'hi' } }]);
  expect(send).toHaveBeenCalledOnce();

  await exec.handleToolCalls([{ id: 'c2', name: 'filesystem__read_file', arguments: { path: '/srv/app/.env' } }]);
  expect(getFlowLabel(SESSION)).toMatchObject({ secret: true, sources: { secret: 'filesystem:read' } });

  const [msg] = await exec.handleToolCalls([{ id: 'c3', name: 'messaging__send', arguments: { text: 'SECRET=1' } }]);
  expect(send).toHaveBeenCalledOnce();
  expect(String(msg?.content)).toMatch(/Approval required: flow guard: this session read credential material/);
});

test('a vault-authenticated call is exempt; a made-up placeholder is not', async () => {
  const exec = new ToolExecutor(context(), () => {});
  exec.registerTool(readFile);
  exec.registerTool(sendMessage);
  await exec.handleToolCalls([{ id: 'c1', name: 'filesystem__read_file', arguments: { path: '.env' } }]);

  await exec.handleToolCalls([{ id: 'c2', name: 'messaging__send', arguments: { text: 'hi', token: '{{secret:slack_token}}' } }]);
  expect(send).toHaveBeenCalledOnce();

  const [fake] = await exec.handleToolCalls([{ id: 'c3', name: 'messaging__send', arguments: { text: 'hi', token: '{{secret:made_up}}' } }]);
  expect(send).toHaveBeenCalledOnce();
  expect(String(fake?.content)).toMatch(/flow guard/);
  expect(vault.canAccessByName).toHaveBeenCalledWith('system', 'made_up', { toolId: 'messaging' });
});
