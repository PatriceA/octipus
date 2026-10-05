/**
 * Slack group-channel rules (docs/plans/group-chat-bot.md, phase 1), driven
 * with fake platform calls: silent unless enrolled and addressed, never a
 * link code in a channel, private hints for unlinked members, the turn runs
 * as the member who asked.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { JoinResult } from '@/channels/group-channels';
import type { GroupChannel } from '@/db/schema/group-channels';
import {
  type GroupMember, HINTS, handleSlackGroupMessage, handleSlackGroupReaction, handleSlackGroupReactionRemoved, parseTake, type SlackGroupDeps,
  type SlackGroupMessage, type SlackPost, type SlackReaction, TAKE_REACTION, TAKE_REACTION_TEXT,
} from './group';

const BOT = 'UBOT';
const group: GroupChannel = {
  id: 'g1', channelType: 'slack', channelId: 'C1', label: '#release',
  ownerUserId: 'owner', createdAt: new Date(), updatedAt: new Date(), mode: 'mention', quietHoursStart: null, quietHoursEnd: null,
  timezone: 'UTC', maxUnpromptedPerDay: 8, minMinutesBetween: 60, lastUnpromptedAt: null, unpromptedDay: null, unpromptedCount: 0, workspaceId: null,
};
const anna: GroupMember = { id: 'u-anna', username: 'anna', isActive: true, isAdmin: false };
/** Messages `readMessage` finds, by ts. */
const posts: Record<string, SlackPost> = {
  '90.0': { text: 'Can someone fix the flaky deploy test?\nIt failed twice today.', user: 'U-BOB', botId: null },
  '95.5': { text: 'The staging DB is slow again', user: 'U-BOB', botId: null },
  '96.1': { text: 'and the cache too', user: 'U-BOB', botId: null, threadTs: '90.0' },
  '97.0': { text: 'I will look at the cache', user: 'U-ANNA', botId: null },
  '98.0': { text: 'The cache is cold after the deploy.', user: 'UBOT', botId: 'B1', threadTs: '90.0' },
};

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
    join: vi.fn(async (): Promise<JoinResult> => ({ status: 'enrolled', group })),
    leave: vi.fn(async () => 'left' as const),
    channelLabel: vi.fn(async () => '#release'),
    displayName: vi.fn(async () => 'Anna Schmidt'),
    postEphemeral: vi.fn(async (_c: string, user: string, text: string) => { calls.ephemeral.push({ user, text }); }),
    postInThread: vi.fn(async (_c: string, threadTs: string, text: string) => { calls.thread.push({ threadTs, text }); }),
    readContext: vi.fn(async () => '--- GROUP CHANNEL CONTEXT ---'),
    readMessage: vi.fn(async (_c: string, ts: string): Promise<SlackPost | null> => posts[ts] ?? null),
    permalink: vi.fn(async (_c: string, ts: string) => `https://x.slack.com/archives/C1/p${ts.replace('.', '')}`),
    budgetPause: vi.fn(async () => null),
    shouldSendHint: (key: string) => (hints.has(key) ? false : (hints.add(key), true)),
    dispatch: (input) => { calls.dispatched.push(input); },
    feedback: vi.fn(async () => {}),
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
    expect(ctx.calls.thread[0]!.text).toContain('*anna* enrolled it');
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
      join: vi.fn(async (): Promise<JoinResult> => ({ status: 'took_over', group, previousOwner: 'bob' })),
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

describe('taking work on', () => {
  let ctx: ReturnType<typeof makeDeps>;
  beforeEach(() => { ctx = makeDeps(); });

  test('parseTake: "take this — …", "take it: …", "take this on"; not "take a look"', () => {
    expect(parseTake('take this — draft the notes')).toBe('draft the notes');
    expect(parseTake('Take it: fix the flaky test')).toBe('fix the flaky test');
    expect(parseTake('take this on')).toBe('');
    expect(parseTake('take this')).toBe('');
    expect(parseTake('take a look at the logs')).toBeNull();
    expect(parseTake('takeaway from the meeting?')).toBeNull();
    expect(parseTake('take thisx')).toBeNull();
    // Ordinary phrasing that starts with "take it" is not a command.
    expect(parseTake('take it easy on the wording, but review this')).toBeNull();
    expect(parseTake('take this into account: we ship Friday')).toBeNull();
    expect(parseTake('take this on - write the summary')).toBe('write the summary');
    expect(parseTake('take this, please draft it')).toBe('please draft it');
    expect(parseTake('take this\nthe release notes')).toBe('the release notes');
    expect(parseTake('take this on.')).toBe('');
  });

  test("take this — <what>: the member's own words are the request", async () => {
    expect(await handleSlackGroupMessage(msg({ text: `<@${BOT}> take this — draft the release notes` }), ctx.deps)).toBe('taken');
    const d = ctx.calls.dispatched[0]!;
    expect(d.text).toBe('take this — draft the release notes'); // stored as typed
    expect(d.take).toEqual({ text: 'draft the release notes', messageKey: 'C1:100.1', url: 'https://x.slack.com/archives/C1/p1001' });
    expect(d.threadTs).toBe('100.1');
  });

  test("take this alone in a thread takes the thread's first message, attributed to its author", async () => {
    expect(await handleSlackGroupMessage(msg({ text: `<@${BOT}> take this`, thread_ts: '90.0', ts: '100.2' }), ctx.deps)).toBe('taken');
    const d = ctx.calls.dispatched[0]!;
    expect(d.take).toMatchObject({ text: posts['90.0']!.text, author: 'Anna Schmidt', messageKey: 'C1:90.0' });
    expect(ctx.deps.displayName).toHaveBeenCalledWith('U-BOB');
    expect(d.threadTs).toBe('90.0');
  });

  test('take this alone at the top level, or an unreadable first message: a private hint, no task', async () => {
    expect(await handleSlackGroupMessage(msg({ text: `<@${BOT}> take this` }), ctx.deps)).toBe('hint');
    expect(ctx.calls.ephemeral[0]!.text).toBe(HINTS.takeWhat);
    expect(await handleSlackGroupMessage(msg({ text: `<@${BOT}> take it`, thread_ts: '11.1', ts: '100.4' }), ctx.deps)).toBe('hint');
    expect(ctx.calls.ephemeral[1]!.text).toBe(HINTS.takeUnreadable);
    expect(ctx.calls.dispatched).toEqual([]);
  });

  test('without a mention, "take this" in a bot thread is an ordinary message', async () => {
    ctx = makeDeps({ isThreadActive: vi.fn(async () => true) });
    expect(await handleSlackGroupMessage(msg({ text: 'take this — whatever', thread_ts: '90.0', ts: '100.3' }), ctx.deps)).toBe('dispatched');
    expect(ctx.calls.dispatched[0]!.take).toBeUndefined();
  });

  test('an unlinked member cannot take work on', async () => {
    expect(await handleSlackGroupMessage(msg({ user: 'U-STRANGER', text: `<@${BOT}> take this — x` }), ctx.deps)).toBe('hint');
    expect(ctx.calls.dispatched).toEqual([]);
  });
});

describe('the 🐙 reaction', () => {
  let ctx: ReturnType<typeof makeDeps>;
  beforeEach(() => { ctx = makeDeps(); });
  const react = (over: Partial<SlackReaction> = {}): SlackReaction =>
    ({ user: 'U-ANNA', reaction: TAKE_REACTION, item: { type: 'message', channel: 'C1', ts: '95.5' }, ...over });

  test('takes the reacted message on, in its own thread, as the member who reacted', async () => {
    expect(await handleSlackGroupReaction(react(), ctx.deps)).toBe('taken');
    const d = ctx.calls.dispatched[0]!;
    expect(d.member.id).toBe('u-anna');
    expect(d.text).toBe(TAKE_REACTION_TEXT);
    expect(d.threadTs).toBe('95.5');
    expect(d.message.ts).toBe('95.5'); // progress reactions go on the taken message
    expect(d.take).toEqual({
      text: 'The staging DB is slow again', author: 'Anna Schmidt', quoted: true, messageKey: 'C1:95.5',
      url: 'https://x.slack.com/archives/C1/p955',
    });
    // The taken message is the request, not part of the transcript.
    expect(ctx.deps.readContext).toHaveBeenCalledWith({ channelId: 'C1', ts: '95.5', threadTs: undefined, label: '#release' });
  });

  test('a reply in a thread is taken on in that thread; your own message is not attributed', async () => {
    expect(await handleSlackGroupReaction(react({ item: { type: 'message', channel: 'C1', ts: '96.1' } }), ctx.deps)).toBe('taken');
    expect(ctx.calls.dispatched[0]!.threadTs).toBe('90.0');
    await handleSlackGroupReaction(react({ item: { type: 'message', channel: 'C1', ts: '97.0' } }), ctx.deps);
    // Not attributed, but still passed on: the turn's own text is only "Take this on."
    expect(ctx.calls.dispatched[1]!.take).toMatchObject({ quoted: true });
    expect(ctx.calls.dispatched[1]!.take?.author).toBeUndefined();
    expect(ctx.calls.dispatched[1]!.take?.text).toBeTruthy();
  });

  test("other reactions, the bot's own, files and unenrolled channels are ignored, silently", async () => {
    expect(await handleSlackGroupReaction(react({ reaction: 'eyes' }), ctx.deps)).toBe('ignored');
    expect(await handleSlackGroupReaction(react({ user: BOT }), ctx.deps)).toBe('ignored');
    expect(await handleSlackGroupReaction(react({ item: { type: 'file', channel: 'C1', ts: '95.5' } }), ctx.deps)).toBe('ignored');
    ctx = makeDeps({ findGroup: vi.fn(async () => null) });
    expect(await handleSlackGroupReaction(react(), ctx.deps)).toBe('ignored');
    expect(ctx.calls).toEqual({ ephemeral: [], thread: [], dispatched: [] });
  });

  test('an unlinked member gets one private hint; a paused channel one public notice', async () => {
    expect(await handleSlackGroupReaction(react({ user: 'U-STRANGER' }), ctx.deps)).toBe('hint');
    expect(await handleSlackGroupReaction(react({ user: 'U-STRANGER' }), ctx.deps)).toBe('hint');
    expect(ctx.calls.ephemeral).toEqual([{ user: 'U-STRANGER', text: HINTS.linkFirst }]);

    ctx = makeDeps({ isGroupActive: vi.fn(async () => false) });
    expect(await handleSlackGroupReaction(react(), ctx.deps)).toBe('paused');
    expect(ctx.calls.thread[0]!.text).toContain('paused');
    expect(ctx.calls.dispatched).toEqual([]);
  });
});

describe("the channel's spend budget", () => {
  test('used up: one notice a day in the thread, no turn and no task', async () => {
    const ctx = makeDeps({ budgetPause: vi.fn(async () => ({ resetsAt: '2026-11-01T00:00:00.000Z' })) });
    expect(await handleSlackGroupMessage(msg(), ctx.deps)).toBe('paused');
    expect(await handleSlackGroupMessage(msg({ text: `<@${BOT}> take this — x`, ts: '100.9' }), ctx.deps)).toBe('paused');
    expect(await handleSlackGroupReaction({ user: 'U-ANNA', reaction: TAKE_REACTION, item: { type: 'message', channel: 'C1', ts: '95.5' } }, ctx.deps)).toBe('paused');
    expect(ctx.calls.thread).toHaveLength(1);
    expect(ctx.calls.thread[0]!.text).toContain('spend budget is used up until 2026-11-01 00:00 UTC');
    expect(ctx.calls.dispatched).toEqual([]);
  });

  test('used up: a bare yes/no in a thread still goes through, to answer a prompt raised before', async () => {
    const ctx = makeDeps({ budgetPause: vi.fn(async () => ({ resetsAt: '2026-11-01T00:00:00.000Z' })) });
    expect(await handleSlackGroupMessage(msg({ text: `<@${BOT}> yes`, thread_ts: '90.0' }), ctx.deps)).toBe('dispatched');
    expect(ctx.calls.dispatched[0]!.text).toBe('yes');
    // Talk in the thread, or a yes at the top level, is still held back.
    expect(await handleSlackGroupMessage(msg({ text: `<@${BOT}> yes please`, thread_ts: '90.0', ts: '100.2' }), ctx.deps)).toBe('paused');
    expect(await handleSlackGroupMessage(msg({ text: `<@${BOT}> yes`, ts: '100.3' }), ctx.deps)).toBe('paused');
    expect(ctx.calls.dispatched).toHaveLength(1);
  });
});


describe('✅ / ❌ feedback on the bot\'s replies', () => {
  const react = (reaction: string, ts = '98.0', user = 'U-ANNA'): SlackReaction =>
    ({ user, reaction, item: { type: 'message', channel: 'C1', ts } });

  test('recorded for a linked member, on the bot\'s own message, with its thread', async () => {
    const ctx = makeDeps();
    expect(await handleSlackGroupReaction(react('white_check_mark'), ctx.deps)).toBe('feedback');
    expect(await handleSlackGroupReaction(react('-1::skin-tone-3'), ctx.deps)).toBe('feedback');
    expect(ctx.deps.feedback).toHaveBeenNthCalledWith(1, { groupChannelId: 'g1', messageId: '98.0', threadId: '90.0', userId: 'u-anna', value: 1, removed: false });
    expect(vi.mocked(ctx.deps.feedback!).mock.calls[1]![0]).toMatchObject({ value: -1, removed: false });
    expect(await handleSlackGroupReactionRemoved(react('x'), ctx.deps)).toBe('feedback');
    expect(vi.mocked(ctx.deps.feedback!).mock.calls[2]![0]).toMatchObject({ value: -1, removed: true });
    expect(ctx.calls).toEqual({ ephemeral: [], thread: [], dispatched: [] });
  });

  test('ignored on members\' messages, from unlinked members, in unenrolled channels, and for other emoji', async () => {
    let ctx = makeDeps();
    expect(await handleSlackGroupReaction(react('white_check_mark', '97.0'), ctx.deps)).toBe('ignored');
    expect(await handleSlackGroupReaction(react('white_check_mark', '98.0', 'U-STRANGER'), ctx.deps)).toBe('ignored');
    expect(await handleSlackGroupReactionRemoved(react('eyes'), ctx.deps)).toBe('ignored');

    ctx = makeDeps({ findGroup: vi.fn(async () => null) });
    expect(await handleSlackGroupReaction(react('white_check_mark'), ctx.deps)).toBe('ignored');
    expect(ctx.deps.feedback).not.toHaveBeenCalled();
    expect(ctx.calls).toEqual({ ephemeral: [], thread: [], dispatched: [] });
  });

  test('Slack names the message\'s author: a 👍 on a member\'s message is dropped without reading it back', async () => {
    const ctx = makeDeps();
    expect(await handleSlackGroupReaction({ ...react('+1', '97.0'), item_user: 'U-ANNA' }, ctx.deps)).toBe('ignored');
    expect(await handleSlackGroupReactionRemoved({ ...react('+1', '97.0'), item_user: 'U-ANNA' }, ctx.deps)).toBe('ignored');
    expect(ctx.deps.readMessage).not.toHaveBeenCalled();
    expect(await handleSlackGroupReaction({ ...react('+1'), item_user: BOT }, ctx.deps)).toBe('feedback');
  });
});
