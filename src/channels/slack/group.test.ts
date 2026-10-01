/**
 * Slack group-channel rules (docs/plans/group-chat-bot.md, phase 1), driven
 * with fake platform calls: silent unless enrolled and addressed, never a
 * link code in a channel, private hints for unlinked members, the turn runs
 * as the member who asked.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { JoinResult } from '@/channels/group-channels';
import type { GroupChannel } from '@/db/schema/group-channels';
import { type GroupMember, HINTS, handleSlackGroupMessage, type SlackGroupDeps, type SlackGroupMessage } from './group';

const BOT = 'UBOT';
const group: GroupChannel = {
  id: 'g1', channelType: 'slack', channelId: 'C1', label: '#release',
  ownerUserId: 'owner', workspaceId: 'w1', createdAt: new Date(), updatedAt: new Date(),
};
const anna: GroupMember = { id: 'u-anna', username: 'anna', isActive: true, isAdmin: false };

function makeDeps(over: Partial<SlackGroupDeps> = {}) {
  const calls = {
    ephemeral: [] as Array<{ user: string; text: string }>,
    thread: [] as Array<{ threadTs: string; text: string }>,
    dispatched: [] as Array<Parameters<SlackGroupDeps['dispatch']>[0]>,
  };
  const hints = new Set<string>();
  const deps: SlackGroupDeps = {
    botUserId: BOT,
    findGroup: vi.fn(async () => group),
    isGroupActive: vi.fn(async () => true),
    isThreadActive: vi.fn(async () => false),
    findMember: vi.fn(async (id: string) => (id === 'U-ANNA' ? anna : null)),
    join: vi.fn(async (): Promise<JoinResult> => ({ status: 'enrolled', group, workspaceName: 'Default' })),
    leave: vi.fn(async () => 'left' as const),
    channelLabel: vi.fn(async () => '#release'),
    displayName: vi.fn(async () => 'Anna Schmidt'),
    postEphemeral: vi.fn(async (_c: string, user: string, text: string) => { calls.ephemeral.push({ user, text }); }),
    postInThread: vi.fn(async (_c: string, threadTs: string, text: string) => { calls.thread.push({ threadTs, text }); }),
    readContext: vi.fn(async () => '--- GROUP CHANNEL CONTEXT ---'),
    shouldSendHint: (key: string) => (hints.has(key) ? false : (hints.add(key), true)),
    dispatch: (input) => { calls.dispatched.push(input); },
    ...over,
  };
  return { deps, calls };
}

const msg = (over: Partial<SlackGroupMessage> = {}): SlackGroupMessage =>
  ({ user: 'U-ANNA', channel: 'C1', ts: '100.1', text: `<@${BOT}> when do we ship?`, ...over });

describe('handleSlackGroupMessage', () => {
  let ctx: ReturnType<typeof makeDeps>;
  beforeEach(() => { ctx = makeDeps(); });

  test('enrolled + mentioned: dispatches as the member, in a thread on their message, with context', async () => {
    expect(await handleSlackGroupMessage(msg(), ctx.deps)).toBe('dispatched');
    expect(ctx.calls.dispatched).toHaveLength(1);
    const d = ctx.calls.dispatched[0]!;
    expect(d.member.id).toBe('u-anna');
    expect(d.text).toBe('when do we ship?');
    expect(d.threadTs).toBe('100.1');
    expect(d.userName).toBe('Anna Schmidt');
    expect(d.context).toContain('GROUP CHANNEL CONTEXT');
    expect(ctx.deps.readContext).toHaveBeenCalledWith({ channelId: 'C1', ts: '100.1', threadTs: undefined, label: '#release' });
  });

  test('enrolled, not mentioned, not in a bot thread: nothing at all', async () => {
    const out = await handleSlackGroupMessage(msg({ text: 'lunch?' }), ctx.deps);
    expect(out).toBe('not_addressed');
    expect(ctx.calls).toEqual({ ephemeral: [], thread: [], dispatched: [] });
    expect(ctx.deps.readContext).not.toHaveBeenCalled();
  });

  test('a reply in a thread the bot is part of counts as addressed, and stays in that thread', async () => {
    ctx = makeDeps({ isThreadActive: vi.fn(async (_g: string, ts: string) => ts === '90.0') });
    const out = await handleSlackGroupMessage(msg({ text: 'and the changelog?', thread_ts: '90.0', ts: '100.2' }), ctx.deps);
    expect(out).toBe('dispatched');
    expect(ctx.calls.dispatched[0]!.threadTs).toBe('90.0');
  });

  test('a reply in some other thread is not addressed', async () => {
    expect(await handleSlackGroupMessage(msg({ text: 'sure', thread_ts: '80.0' }), ctx.deps)).toBe('not_addressed');
  });

  test('only the bot mention is stripped; other mentions stay', async () => {
    await handleSlackGroupMessage(msg({ text: `<@${BOT}> ask <@U-BOB> about it` }), ctx.deps);
    expect(ctx.calls.dispatched[0]!.text).toBe('ask <@U-BOB> about it');
  });

  test('not enrolled: silent without a mention, one private hint per day with one', async () => {
    ctx = makeDeps({ findGroup: vi.fn(async () => null) });
    expect(await handleSlackGroupMessage(msg({ text: 'hello all' }), ctx.deps)).toBe('ignored');
    expect(await handleSlackGroupMessage(msg(), ctx.deps)).toBe('hint');
    expect(await handleSlackGroupMessage(msg(), ctx.deps)).toBe('hint');
    expect(ctx.calls.ephemeral).toHaveLength(1);
    expect(ctx.calls.ephemeral[0]!.text).toContain('join');
    expect(ctx.calls.thread).toEqual([]);
    expect(ctx.calls.dispatched).toEqual([]);
  });

  test('link in a channel never posts a code, only a private pointer to DMs', async () => {
    expect(await handleSlackGroupMessage(msg({ text: `<@${BOT}> link` }), ctx.deps)).toBe('hint');
    expect(ctx.calls.ephemeral).toEqual([{ user: 'U-ANNA', text: HINTS.linkInChannel }]);
    expect(ctx.calls.thread).toEqual([]);
  });

  test('unlinked member: one private hint a day, no turn', async () => {
    const stranger = msg({ user: 'U-STRANGER' });
    expect(await handleSlackGroupMessage(stranger, ctx.deps)).toBe('hint');
    expect(await handleSlackGroupMessage(stranger, ctx.deps)).toBe('hint');
    expect(ctx.calls.ephemeral).toEqual([{ user: 'U-STRANGER', text: HINTS.linkFirst }]);
    expect(ctx.calls.dispatched).toEqual([]);
  });

  test('deactivated member is treated as unlinked', async () => {
    ctx = makeDeps({ findMember: vi.fn(async () => ({ ...anna, isActive: false })) });
    expect(await handleSlackGroupMessage(msg(), ctx.deps)).toBe('hint');
    expect(ctx.calls.dispatched).toEqual([]);
  });

  test('paused channel (owner deactivated): one public notice, no turn', async () => {
    ctx = makeDeps({ isGroupActive: vi.fn(async () => false) });
    expect(await handleSlackGroupMessage(msg(), ctx.deps)).toBe('paused');
    expect(await handleSlackGroupMessage(msg({ ts: '100.5' }), ctx.deps)).toBe('paused');
    expect(ctx.calls.thread).toHaveLength(1);
    expect(ctx.calls.thread[0]!.text).toContain('paused');
    expect(ctx.calls.dispatched).toEqual([]);
  });

  test('join from a linked member enrols and announces it publicly', async () => {
    ctx = makeDeps({ findGroup: vi.fn(async () => null) });
    expect(await handleSlackGroupMessage(msg({ text: `<@${BOT}> join` }), ctx.deps)).toBe('joined');
    expect(ctx.deps.join).toHaveBeenCalledWith({ channelId: 'C1', label: '#release', userId: 'u-anna' });
    expect(ctx.calls.thread[0]!.text).toContain("*anna*'s workspace *Default*");
  });

  test('join from an unlinked member does not enrol', async () => {
    ctx = makeDeps({ findGroup: vi.fn(async () => null) });
    expect(await handleSlackGroupMessage(msg({ user: 'U-STRANGER', text: `<@${BOT}> join` }), ctx.deps)).toBe('hint');
    expect(ctx.deps.join).not.toHaveBeenCalled();
  });

  test('join on a channel someone else holds says who, privately', async () => {
    ctx = makeDeps({ join: vi.fn(async (): Promise<JoinResult> => ({ status: 'taken', ownerName: 'bob' })) });
    expect(await handleSlackGroupMessage(msg({ text: `<@${BOT}> join` }), ctx.deps)).toBe('hint');
    expect(ctx.calls.ephemeral[0]!.text).toContain('*bob*');
    expect(ctx.calls.thread).toEqual([]);
  });

  test('a member can take over a paused channel with join', async () => {
    ctx = makeDeps({
      isGroupActive: vi.fn(async () => false),
      join: vi.fn(async (): Promise<JoinResult> => ({ status: 'took_over', group, workspaceName: 'Default', previousOwner: 'bob' })),
    });
    expect(await handleSlackGroupMessage(msg({ text: `<@${BOT}> join` }), ctx.deps)).toBe('joined');
    expect(ctx.calls.thread[0]!.text).toContain('took over this channel from *bob*');
  });

  test('leave by a non-owner is refused privately; by the owner it is announced', async () => {
    ctx = makeDeps({ leave: vi.fn(async () => 'not_owner' as const) });
    expect(await handleSlackGroupMessage(msg({ text: `<@${BOT}> leave` }), ctx.deps)).toBe('hint');
    expect(ctx.calls.ephemeral[0]!.text).toBe(HINTS.notOwner);

    ctx = makeDeps();
    expect(await handleSlackGroupMessage(msg({ text: `<@${BOT}> leave` }), ctx.deps)).toBe('left');
    expect(ctx.deps.leave).toHaveBeenCalledWith({ channelId: 'C1', userId: 'u-anna', isAdmin: false });
    expect(ctx.calls.thread[0]!.text).toContain('left this channel');
  });

  test('bot posts, edits and joins are ignored', async () => {
    for (const m of [msg({ bot_id: 'B1' }), msg({ subtype: 'message_changed' }), msg({ subtype: 'channel_join' }), msg({ user: undefined })]) {
      expect(await handleSlackGroupMessage(m, ctx.deps)).toBe('ignored');
    }
    expect(ctx.calls.dispatched).toEqual([]);
  });

  test('without the bot id nothing counts as a mention', async () => {
    ctx = makeDeps({ botUserId: null });
    expect(await handleSlackGroupMessage(msg(), ctx.deps)).toBe('not_addressed');
  });

  test('a bare mention gets a private nudge, not a turn', async () => {
    expect(await handleSlackGroupMessage(msg({ text: `<@${BOT}>` }), ctx.deps)).toBe('hint');
    expect(ctx.calls.ephemeral[0]!.text).toBe(HINTS.emptyMention);
    expect(ctx.calls.dispatched).toEqual([]);
  });
});
