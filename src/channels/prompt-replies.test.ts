/**
 * A permission prompt and an agent approval waiting in the same chat: a typed
 * reply answers the one posted last — the one on screen — and the other only
 * when the reply does not answer that one.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { UnifiedMessage } from '@/core/types';

const fx = vi.hoisted(() => ({
  pending: [] as Array<{ id: string; userId: string; sessionId: string }>,
  resolve: vi.fn(async (..._args: unknown[]) => ({ status: 'resolved' })),
}));
vi.mock('@/core/agent/service', () => ({
  getAgentService: () => ({
    onEvent: () => () => {},
    getPendingApprovals: () => fx.pending,
    resolveApprovalDetailed: fx.resolve,
  }),
}));
vi.mock('./group-channels', () => ({ findGroupChannel: async () => null, isGroupChannelActive: async () => false }));
vi.mock('./ownership', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ownership')>();
  const { getUMI } = await import('./interface');
  return {
    ...actual,
    loadNotifyScope: async (userId: string) => ({ userId }),
    resolveTarget: async (_scope: unknown, channelType: string, channelId: string) => ({
      allowed: true, target: `${channelType}:${channelId}`,
      send: async (r: never) => { await getUMI().send(channelType as never, channelId, r); },
    }),
  };
});
import { sessionRepository } from '@/db/repositories/session-repository';
import { getPermissionManager } from '@/security/permissions';
import { _resetApprovalPromptsForTests, announceApproval } from './approval-prompts';
import { _resetPendingChannelPermissionsForTests, forwardPermissionRequestToChannel, tryResolvePromptReply } from './index';
import { getUMI } from './interface';

const ANNA = 'u-anna';
const SESSION = '11111111-1111-4111-8111-111111111111';
const reply = (content: string): UnifiedMessage => ({
  id: 'm', channelType: 'telegram', channelId: '1001', userId: ANNA, content, timestamp: new Date(),
});

async function askPermission(requestId: string) {
  await forwardPermissionRequestToChannel({
    requestId, userId: ANNA, agentId: 'a', toolId: 'shell', action: 'run', toolName: 'shell__run', args: { command: 'ls' }, sessionId: SESSION,
  });
}

async function askApproval(requestId: string) {
  fx.pending.push({ id: requestId, userId: ANNA, sessionId: SESSION });
  await announceApproval({
    type: 'approval_required', sessionId: SESSION, userId: ANNA, timestamp: new Date(),
    data: { requestId, summary: 'Stage done.', question: 'Next stage?' },
  });
}

describe('a permission prompt and an approval in one chat', () => {
  let approve: ReturnType<typeof vi.spyOn>;
  let deny: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    _resetPendingChannelPermissionsForTests();
    _resetApprovalPromptsForTests();
    fx.pending = [];
    fx.resolve.mockClear();
    vi.spyOn(sessionRepository, 'findById').mockResolvedValue({ id: SESSION, userId: ANNA, channelType: 'telegram', channelId: '1001' } as never);
    vi.spyOn(getUMI(), 'send').mockResolvedValue('ts');
    approve = vi.spyOn(getPermissionManager(), 'approve').mockResolvedValue(true);
    deny = vi.spyOn(getPermissionManager(), 'deny').mockResolvedValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('the approval posted after the permission prompt is answered first', async () => {
    await askPermission('perm-1');
    vi.setSystemTime(Date.now() + 1_000);
    await askApproval('appr-1');

    expect(await tryResolvePromptReply(reply('no'))).toBe(true);
    expect(fx.resolve).toHaveBeenCalledWith('appr-1', false, 'no', expect.anything());
    expect(deny).not.toHaveBeenCalled();

    fx.pending = [];
    expect(await tryResolvePromptReply(reply('no'))).toBe(true);
    expect(deny).toHaveBeenCalledWith('perm-1', ANNA);
  });

  test('the permission prompt posted after the approval is answered first', async () => {
    await askApproval('appr-2');
    vi.setSystemTime(Date.now() + 1_000);
    await askPermission('perm-2');

    expect(await tryResolvePromptReply(reply('yes'))).toBe(true);
    expect(approve).toHaveBeenCalledWith('perm-2', ANNA);
    expect(fx.resolve).not.toHaveBeenCalled();
  });

  test('a reply only the older prompt understands still answers it', async () => {
    await askPermission('perm-3');
    vi.setSystemTime(Date.now() + 1_000);
    await askApproval('appr-3');
    // "ok" answers a permission prompt, not an approval.
    expect(await tryResolvePromptReply(reply('ok'))).toBe(true);
    expect(approve).toHaveBeenCalledWith('perm-3', ANNA);
    expect(fx.resolve).not.toHaveBeenCalled();
  });
});
