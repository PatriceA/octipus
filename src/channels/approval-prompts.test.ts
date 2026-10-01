/**
 * Agent approvals in chat, keyed by the session that raised them: posted
 * whether or not a chat message started the run (background runs, Teams),
 * only where the bot may post, and answered only in the chat they were
 * posted in.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { TurnEvent } from '@/core/agent/service';
import type { UnifiedMessage } from '@/core/types';

const fx = vi.hoisted(() => ({
  pending: [] as Array<{ id: string; userId: string; sessionId: string }>,
  handlers: new Set<(event: unknown) => void>(),
  resolve: vi.fn(async (..._args: unknown[]) => ({ status: 'resolved' }) as { status: string; message?: string }),
  /** `type:id` chats the bot may message unattended. */
  owned: new Set<string>(),
  group: { id: 'g1' } as { id: string } | null,
  active: true,
}));
vi.mock('@/core/agent/service', () => ({
  getAgentService: () => ({
    onEvent: (h: (event: unknown) => void) => { fx.handlers.add(h); return () => fx.handlers.delete(h); },
    getPendingApprovals: () => fx.pending,
    resolveApprovalDetailed: fx.resolve,
  }),
}));
vi.mock('./group-channels', () => ({
  findGroupChannel: async () => fx.group,
  isGroupChannelActive: async () => fx.active,
}));
vi.mock('./ownership', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ownership')>();
  const { getUMI } = await import('./interface');
  return {
    ...actual,
    loadNotifyScope: async (userId: string) => ({ userId, identities: [], owned: new Set(), allowlist: new Set() }),
    resolveTarget: async (_scope: unknown, channelType: string, channelId: string) => {
      const target = `${channelType}:${channelId}`;
      return fx.owned.has(target)
        ? { allowed: true, target, send: async (r: never) => { await getUMI().send(channelType as never, channelId, r); } }
        : { allowed: false, target, reason: 'not_allowed', error: 'not allowed' };
    },
  };
});
import { sessionRepository } from '@/db/repositories/session-repository';
import { userRepository } from '@/db/repositories/user-repository';
import { _resetApprovalPromptsForTests, announceApproval, attendChat, startApprovalPrompts, tryResolveApprovalFromChannel } from './approval-prompts';
import { getUMI } from './interface';

const ANNA = 'u-anna';
const S_DM = '11111111-1111-4111-8111-111111111111';
const S_TEAMS = '22222222-2222-4222-8222-222222222222';
const S_GROUPCHAT = '33333333-3333-4333-8333-333333333333';
const S_THREAD = '44444444-4444-4444-8444-444444444444';
const S_WEB = '55555555-5555-4555-8555-555555555555';

const sessions: Record<string, object> = {
  [S_DM]: { id: S_DM, userId: ANNA, channelType: 'telegram', channelId: '1001' },
  [S_TEAMS]: { id: S_TEAMS, userId: ANNA, channelType: 'teams', channelId: 'a:teams-conv' },
  [S_GROUPCHAT]: { id: S_GROUPCHAT, userId: ANNA, channelType: 'telegram', channelId: '-500' },
  [S_THREAD]: { id: S_THREAD, userId: ANNA, channelType: 'slack', channelId: 'C1', threadId: '90.0', groupChannelId: 'g1' },
  [S_WEB]: { id: S_WEB, userId: ANNA, channelType: 'webchat', channelId: ANNA },
};

let n = 0;
let send: ReturnType<typeof vi.spyOn>;
let sendPrivate: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  _resetApprovalPromptsForTests();
  fx.pending = [];
  fx.handlers.clear();
  fx.resolve.mockReset().mockResolvedValue({ status: 'resolved' });
  fx.owned = new Set(['telegram:1001', 'teams:a:teams-conv']);
  fx.group = { id: 'g1' };
  fx.active = true;
  vi.spyOn(sessionRepository, 'findById').mockImplementation(async (id: string) => (sessions[id] ?? null) as never);
  vi.spyOn(userRepository, 'findById').mockResolvedValue({ id: ANNA, username: 'anna' } as never);
  send = vi.spyOn(getUMI(), 'send').mockResolvedValue('ts');
  sendPrivate = vi.spyOn(getUMI(), 'sendPrivate').mockResolvedValue(true);
});
afterEach(() => vi.restoreAllMocks());

/** Raise an approval in `sessionId` (it is pending until resolved) and let it be announced. */
async function raise(sessionId: string, over: { summary?: string; options?: string[] } = {}) {
  const requestId = `req-${++n}`;
  fx.pending.push({ id: requestId, userId: ANNA, sessionId });
  const event: TurnEvent = {
    type: 'approval_required', sessionId, userId: ANNA, timestamp: new Date(),
    data: { requestId, summary: over.summary ?? 'Pipeline "Payroll" — reviewed salaries.csv', question: 'Proceed with next stage: "Pay"?', options: over.options },
  };
  await announceApproval(event);
  return requestId;
}

const reply = (content: string, over: Partial<UnifiedMessage> = {}): UnifiedMessage => ({
  id: 'm', channelType: 'telegram', channelId: '1001', userId: ANNA, content, timestamp: new Date(), ...over,
});
const sentText = (i = 0) => (send.mock.calls[i]![2] as { content: string }).content;

describe('posting approvals in chat', () => {
  test("an approval from a background run is posted in the session's own chat", async () => {
    await raise(S_DM, { options: ['Approve', 'Skip', 'Stop Pipeline'] });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe('telegram');
    expect(send.mock.calls[0]![1]).toBe('1001');
    expect(sentText()).toContain('salaries.csv');
    expect(sentText()).toContain('Proceed with next stage: "Pay"?');
    expect(sentText()).toContain('Options: Approve / Skip / Stop Pipeline');
  });

  test('Teams gets the prompt too (its messages carry no message id)', async () => {
    await raise(S_TEAMS);
    expect(send).toHaveBeenCalledWith('teams', 'a:teams-conv', expect.objectContaining({ content: expect.stringContaining('Approval Required') }));
  });

  test('a chat the bot may not message unattended gets nothing, unless the user is talking there now', async () => {
    await raise(S_GROUPCHAT);
    expect(send).not.toHaveBeenCalled();

    const leave = attendChat(S_GROUPCHAT);
    await raise(S_GROUPCHAT);
    expect(send).toHaveBeenCalledTimes(1);
    leave();
    leave(); // releasing twice is harmless

    await raise(S_GROUPCHAT);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('sessions without a messaging chat are left to the web app', async () => {
    await raise(S_WEB);
    await announceApproval({ type: 'approval_required', sessionId: 'telegram-1001', userId: ANNA, timestamp: new Date(), data: { requestId: 'x' } });
    expect(send).not.toHaveBeenCalled();
  });

  test('one listener: starting twice does not post an approval twice', async () => {
    await startApprovalPrompts();
    await startApprovalPrompts();
    expect(fx.handlers.size).toBe(1);
    fx.pending.push({ id: 'req-live', userId: ANNA, sessionId: S_DM });
    for (const h of fx.handlers) h({ type: 'approval_required', sessionId: S_DM, userId: ANNA, timestamp: new Date(), data: { requestId: 'req-live' } });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  });

  test('an approval answered in the web app before it is posted is not posted', async () => {
    vi.spyOn(sessionRepository, 'findById').mockImplementation(async (id: string) => {
      fx.pending = []; // answered while the session was looked up
      return (sessions[id] ?? null) as never;
    });
    await raise(S_DM);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('answering an approval in chat', () => {
  test('"yes" in the chat it was posted in approves it', async () => {
    const id = await raise(S_DM);
    expect(await tryResolveApprovalFromChannel(reply('yes please'))).toBe(true);
    expect(fx.resolve).toHaveBeenCalledWith(id, true, 'yes please', { forUserId: ANNA, resolvedBy: ANNA });
    expect(sentText(1)).toBe('Approved. Continuing...');
  });

  test('a reply anywhere else, or from someone else, does not answer it', async () => {
    await raise(S_DM);
    expect(await tryResolveApprovalFromChannel(reply('yes', { channelId: '2002' }))).toBe(false);
    expect(await tryResolveApprovalFromChannel(reply('yes', { userId: 'u-bob' }))).toBe(false);
    expect(await tryResolveApprovalFromChannel(reply('yes', { channelType: 'slack', channelId: 'D-ANNA' }))).toBe(false);
    expect(fx.resolve).not.toHaveBeenCalled();
  });

  test("an option's exact label chooses it; other text is not an answer", async () => {
    const id = await raise(S_DM, { options: ['Approve', 'Skip', 'Stop Pipeline'] });
    expect(await tryResolveApprovalFromChannel(reply('what does skip do?'))).toBe(false);
    expect(await tryResolveApprovalFromChannel(reply('skip.'))).toBe(true);
    expect(fx.resolve).toHaveBeenCalledWith(id, true, 'Skip', { forUserId: ANNA, resolvedBy: ANNA });
    expect(sentText(1)).toBe('Chose "Skip". Continuing...');
  });

  test('"no" declines it', async () => {
    const id = await raise(S_DM);
    expect(await tryResolveApprovalFromChannel(reply('no, stop'))).toBe(true);
    expect(fx.resolve).toHaveBeenCalledWith(id, false, 'no, stop', expect.anything());
    expect(sentText(1)).toBe('Declined.');
  });

  test('the newest posted approval is answered first; one answered in the web app is skipped', async () => {
    const first = await raise(S_DM);
    const second = await raise(S_DM);
    expect(await tryResolveApprovalFromChannel(reply('yes'))).toBe(true);
    expect(fx.resolve).toHaveBeenLastCalledWith(second, true, 'yes', expect.anything());
    expect(sentText(2)).toContain('1 more approval waiting here');

    fx.pending = fx.pending.filter((p) => p.id !== first); // answered in the web app
    expect(await tryResolveApprovalFromChannel(reply('yes'))).toBe(false);
    expect(fx.resolve).toHaveBeenCalledTimes(1);
  });

  test('an approval that expired meanwhile says so and changes nothing', async () => {
    await raise(S_DM);
    fx.resolve.mockResolvedValueOnce({ status: 'timed_out', message: 'This approval request has expired: nobody answered in time.' });
    expect(await tryResolveApprovalFromChannel(reply('yes'))).toBe(true);
    expect(sentText(1)).toContain('has expired');
  });
});

describe('approvals in a group-channel thread', () => {
  const thread = (content: string, over: Partial<UnifiedMessage> = {}) => reply(content, {
    channelType: 'slack', channelId: 'C1', threadId: '90.0', metadata: { groupChannelId: 'g1' }, ...over,
  });

  test('details go privately to the requester; the thread gets a prompt without them', async () => {
    await raise(S_THREAD);
    expect(sendPrivate).toHaveBeenCalledWith('slack', 'C1', ANNA, expect.objectContaining({
      threadId: '90.0', content: expect.stringContaining('salaries.csv'),
    }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![2]).toMatchObject({ threadId: '90.0' });
    expect(sentText()).toContain('anna: a step needs your approval');
    expect(sentText()).not.toContain('salaries.csv');
  });

  test('details that cannot be shown privately are still not posted in the thread', async () => {
    sendPrivate.mockResolvedValue(false);
    await raise(S_THREAD);
    expect(sentText()).toContain('web app');
    expect(sentText()).not.toContain('salaries.csv');
  });

  test('only a bare yes/no from the requester, in that thread, answers it', async () => {
    const id = await raise(S_THREAD);
    expect(await tryResolveApprovalFromChannel(thread('no, let me check with Dana first'))).toBe(false);
    expect(await tryResolveApprovalFromChannel(thread('yes', { userId: 'u-bob' }))).toBe(false);
    expect(await tryResolveApprovalFromChannel(thread('yes', { threadId: '80.0' }))).toBe(false);
    expect(await tryResolveApprovalFromChannel(reply('yes', { channelType: 'slack', channelId: 'D-ANNA' }))).toBe(false);
    expect(fx.resolve).not.toHaveBeenCalled();

    expect(await tryResolveApprovalFromChannel(thread('Yes!'))).toBe(true);
    expect(fx.resolve).toHaveBeenCalledWith(id, true, 'yes', { forUserId: ANNA, resolvedBy: ANNA });
    expect(send.mock.calls[1]![2]).toMatchObject({ threadId: '90.0' });
  });

  test('in a removed or paused channel nothing is posted and the step is declined', async () => {
    fx.active = false;
    const paused = await raise(S_THREAD);
    fx.active = true;
    fx.group = null;
    const removed = await raise(S_THREAD);
    expect(send).not.toHaveBeenCalled();
    expect(sendPrivate).not.toHaveBeenCalled();
    for (const id of [paused, removed]) {
      expect(fx.resolve).toHaveBeenCalledWith(id, false, expect.stringContaining('removed or is paused'), { forUserId: ANNA });
    }
  });
});
