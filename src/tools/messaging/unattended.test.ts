/**
 * messaging.send_message / send_to_user: unattended runs (hooks, cron,
 * heartbeat, execute_tool) may only reach the caller's own chats or approved
 * shared destinations; attended use is unchanged (each send is approved
 * through the permission prompt). The ownership rules themselves are covered
 * against a real database in src/hooks/notify-ownership.test.ts.
 */
import { beforeEach, expect, test, vi } from 'vitest';
import type { AgentContext } from '@/core/types';
import { MessagingTool } from './index';

const m = vi.hoisted(() => ({
  send: vi.fn(),
  deliver: vi.fn(),
  allows: vi.fn(),
  findById: vi.fn(),
}));
vi.mock('@/security/permissions', () => ({ getPermissionManager: () => ({ check: async () => ({ level: 'ALLOW' }) }) }));
vi.mock('@/db/repositories/audit-repository', () => ({ auditRepository: { log: async () => {} } }));
vi.mock('@/core/action-recovery', () => ({
  actionRecovery: { run: (_c: unknown, _t: unknown, _n: unknown, _a: unknown, fn: () => Promise<unknown>) => fn() },
  isReadOnlyAction: () => false,
}));
vi.mock('@/channels/interface', () => ({ getUMI: () => ({ isChannelAvailable: () => true, send: m.send }) }));
vi.mock('@/db/repositories/user-repository', () => ({ userRepository: { findById: m.findById } }));
vi.mock('@/channels/ownership', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/channels/ownership')>()),
  loadNotifyScope: async (userId: string) => ({ userId, identities: [], owned: new Set(), allowlist: new Set() }),
  scopeAllows: m.allows,
  deliver: m.deliver,
  ownerTargets: () => [{ channelType: 'telegram', channelId: 'tg-self', label: 'telegram:tg-self' }],
}));

const ctx = (attended: boolean): AgentContext => ({
  id: 'agent', userId: 'user-1', sessionId: 's', role: 'general', root: false, attended,
  model: '', topic: '', status: 'running', createdAt: new Date(), updatedAt: new Date(), metadata: {},
});

let tool: MessagingTool;
beforeEach(async () => {
  for (const f of Object.values(m)) f.mockReset();
  m.send.mockResolvedValue('mid');
  m.deliver.mockResolvedValue(undefined);
  m.findById.mockImplementation(async (id: string) => ({ id }));
  tool = new MessagingTool();
  await tool.initialize();
});

let n = 0;
const msg = () => `hello ${++n}`; // distinct content: the tool dedups identical sends

test('unattended send_message to a target the user may not notify is refused', async () => {
  m.allows.mockResolvedValue(false);
  const r = await tool.getTool('send_message')!.execute({ channel: 'telegram', target: 'tg-other', message: msg() }, ctx(false)) as { success: boolean; error: string };
  expect(r.success).toBe(false);
  expect(r.error).toMatch(/Admin → Notification destinations/);
  expect(m.send).not.toHaveBeenCalled();
  expect(m.deliver).not.toHaveBeenCalled();
});

test('unattended send_message to an allowed target is delivered through the ownership path', async () => {
  m.allows.mockResolvedValue(true);
  const r = await tool.getTool('send_message')!.execute({ channel: 'telegram', target: 'tg-self', message: msg() }, ctx(false)) as { success: boolean };
  expect(r.success).toBe(true);
  expect(m.deliver).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }), 'telegram', 'tg-self', expect.anything());
});

test('attended send_message is unchanged: no ownership check', async () => {
  const r = await tool.getTool('send_message')!.execute({ channel: 'telegram', target: 'tg-other', message: msg() }, ctx(true)) as { success: boolean };
  expect(r.success).toBe(true);
  expect(m.allows).not.toHaveBeenCalled();
  expect(m.send).toHaveBeenCalledWith('telegram', 'tg-other', expect.anything());
});

test('unattended send_to_user may only target the caller', async () => {
  const other = await tool.getTool('send_to_user')!.execute({ user_id: 'user-2', message: msg() }, ctx(false)) as { success: boolean };
  expect(other.success).toBe(false);
  expect(m.findById).not.toHaveBeenCalled();

  const self = await tool.getTool('send_to_user')!.execute({ user_id: 'user-1', message: msg() }, ctx(false)) as { success: boolean };
  expect(self.success).toBe(true);
  expect(m.deliver).toHaveBeenCalledWith(expect.anything(), 'telegram', 'tg-self', expect.anything());
});

test('attended send_to_user can still message another user', async () => {
  const r = await tool.getTool('send_to_user')!.execute({ user_id: 'user-2', message: msg() }, ctx(true)) as { success: boolean };
  expect(r.success).toBe(true);
});
