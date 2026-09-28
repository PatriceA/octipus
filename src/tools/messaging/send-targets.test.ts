/**
 * messaging.send_message / send_to_user target rules.
 *
 * send_message: every call, attended or not, may only reach the caller's
 * own chats or admin-approved shared destinations. A permission ALLOW
 * ("always allow") or a client-declared channel means no human necessarily
 * looked at the target. The check runs once, before dedup.
 * send_to_user: only the caller, unless the caller is an admin in an
 * attended session; unattended runs only ever reach the caller.
 *
 * The ownership rules themselves are covered against a real database in
 * src/hooks/notify-ownership.test.ts.
 */
import { beforeEach, expect, test, vi } from 'vitest';
import type { AgentContext } from '@/core/types';
import { MessagingTool } from './index';

const m = vi.hoisted(() => ({
  umiSend: vi.fn(),
  resolve: vi.fn(),
  targetSend: vi.fn(),
  deliver: vi.fn(),
  findById: vi.fn(),
}));
vi.mock('@/security/permissions', () => ({ getPermissionManager: () => ({ check: async () => ({ level: 'ALLOW' }) }) }));
vi.mock('@/db/repositories/audit-repository', () => ({ auditRepository: { log: async () => {} } }));
vi.mock('@/core/action-recovery', () => ({
  actionRecovery: { run: (_c: unknown, _t: unknown, _n: unknown, _a: unknown, fn: () => Promise<unknown>) => fn() },
  isReadOnlyAction: () => false,
}));
vi.mock('@/channels/interface', () => ({ getUMI: () => ({ isChannelAvailable: () => true, send: m.umiSend }) }));
vi.mock('@/db/repositories/user-repository', () => ({ userRepository: { findById: m.findById } }));
vi.mock('@/channels/ownership', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/channels/ownership')>()),
  loadNotifyScope: async (userId: string) => ({ userId, identities: [], owned: new Set(), allowlist: new Set() }),
  resolveTarget: m.resolve,
  deliver: m.deliver,
  ownerTargets: () => [{ channelType: 'telegram', channelId: 'tg-self', label: 'telegram:tg-self' }],
}));

const ctx = (attended: boolean, userId = 'user-1'): AgentContext => ({
  id: 'agent', userId, sessionId: 's', role: 'general', root: false, attended,
  model: '', topic: '', status: 'running', createdAt: new Date(), updatedAt: new Date(), metadata: {},
});

const allow = (_s: unknown, type: string, id: string) => ({ allowed: true, target: `${type}:${id}`, send: m.targetSend });
const refuse = (_s: unknown, type: string, id: string) => ({
  allowed: false, target: `${type}:${id}`, reason: 'not_allowed',
  error: `${type}:${id} is not linked to you and not an approved shared destination; ask an admin to add it under Admin → Notification destinations`,
});

let tool: MessagingTool;
beforeEach(async () => {
  for (const f of Object.values(m)) f.mockReset();
  m.targetSend.mockResolvedValue(undefined);
  m.deliver.mockResolvedValue({ ok: true, target: 'x' });
  m.findById.mockImplementation(async (id: string) => ({ id, isAdmin: id === 'admin-1' }));
  tool = new MessagingTool();
  await tool.initialize();
});

let n = 0;
const msg = () => `hello ${++n}`; // distinct content: the tool dedups identical sends
const sendMessage = (args: Record<string, unknown>, c: AgentContext) =>
  tool.getTool('send_message')!.execute(args, c) as Promise<{ success: boolean; error?: string; deduped?: boolean }>;
const sendToUser = (args: Record<string, unknown>, c: AgentContext) =>
  tool.getTool('send_to_user')!.execute(args, c) as Promise<{ success: boolean; error?: string }>;

test.each([false, true])('send_message to a target the user may not notify is refused (attended=%s)', async (attended) => {
  m.resolve.mockImplementation(async (...a: [unknown, string, string]) => refuse(...a));
  const r = await sendMessage({ channel: 'telegram', target: 'tg-other', message: msg() }, ctx(attended));
  expect(r.success).toBe(false);
  expect(r.error).toMatch(/Admin → Notification destinations/);
  expect(m.targetSend).not.toHaveBeenCalled();
  expect(m.umiSend).not.toHaveBeenCalled();
});

test.each([false, true])('send_message to an allowed target is sent through the resolution (attended=%s)', async (attended) => {
  m.resolve.mockImplementation(async (...a: [unknown, string, string]) => allow(...a));
  const r = await sendMessage({ channel: 'telegram', target: 'tg-self', message: msg() }, ctx(attended));
  expect(r.success).toBe(true);
  expect(m.resolve).toHaveBeenCalledTimes(1);
  expect(m.targetSend).toHaveBeenCalledTimes(1);
});

test('the ownership check runs before dedup: a refused target is never reported as deduped', async () => {
  const text = msg();
  m.resolve.mockImplementation(async (...a: [unknown, string, string]) => allow(...a));
  expect((await sendMessage({ channel: 'telegram', target: 'tg-x', message: text }, ctx(true))).success).toBe(true);
  // same target + text again, but the target is no longer allowed (e.g. unlinked)
  m.resolve.mockImplementation(async (...a: [unknown, string, string]) => refuse(...a));
  const again = await sendMessage({ channel: 'telegram', target: 'tg-x', message: text }, ctx(true));
  expect(again.success).toBe(false);
  expect(again.deduped).toBeUndefined();
});

test.each([false, true])('send_to_user by a non-admin may only target the caller (attended=%s)', async (attended) => {
  const other = await sendToUser({ user_id: 'user-2', message: msg() }, ctx(attended));
  expect(other.success).toBe(false);
  expect(m.deliver).not.toHaveBeenCalled();

  const self = await sendToUser({ user_id: 'user-1', message: msg() }, ctx(attended));
  expect(self.success).toBe(true);
  expect(m.deliver).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }), 'telegram', 'tg-self', expect.anything());
});

test('an admin in an attended session may send_to_user another user, on that user’s own chats', async () => {
  const r = await sendToUser({ user_id: 'user-2', message: msg() }, ctx(true, 'admin-1'));
  expect(r.success).toBe(true);
  expect(m.deliver).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-2' }), 'telegram', 'tg-self', expect.anything());
});

test('an admin’s unattended run may only send_to_user the admin', async () => {
  const other = await sendToUser({ user_id: 'user-2', message: msg() }, ctx(false, 'admin-1'));
  expect(other.success).toBe(false);
  expect(other.error).toMatch(/unattended/);
  expect(m.deliver).not.toHaveBeenCalled();

  const self = await sendToUser({ user_id: 'admin-1', message: msg() }, ctx(false, 'admin-1'));
  expect(self.success).toBe(true);
});
