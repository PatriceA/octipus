/**
 * The platform-neutral group rules beyond Slack's (covered in
 * `slack/group.test.ts`): a reply to the bot addresses it, `take this` takes
 * the message replied to, chats without threads are never "followed", and
 * every message in an enrolled chat reaches `seen`.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { JoinResult } from '@/channels/group-channels';
import type { GroupChannel } from '@/db/schema/group-channels';
import { answerHow, type GroupDeps, type GroupInbound, groupHints, handleGroupMessage, MAIN_THREAD } from './group-handler';

const group: GroupChannel = {
  id: 'g1', channelType: 'telegram', channelId: '-1001', label: 'Release crew',
  ownerUserId: 'owner', createdAt: new Date(), updatedAt: new Date(),
};
const anna = { id: 'u-anna', username: 'anna', isActive: true, isAdmin: false };
const hints = groupHints({ platform: 'Telegram', linkHow: 'send me /link in a private chat', takeAlso: 'or reply', followHow: 'reply to me' });

function makeDeps(over: Partial<GroupDeps> = {}) {
  const calls = { private: [] as string[], posted: [] as string[], dispatched: [] as Array<Parameters<GroupDeps['dispatch']>[0]>, seen: [] as string[] };
  const sent = new Set<string>();
  const deps: GroupDeps = {
    botUserId: '42',
    bot: '@octipus_bot',
    hints,
    findGroup: vi.fn(async () => group),
    isGroupActive: vi.fn(async () => true),
    isThreadActive: vi.fn(async () => true),
    findMember: vi.fn(async (id: string) => (id === '7' ? anna : null)),
    join: vi.fn(async (): Promise<JoinResult> => ({ status: 'enrolled', group })),
    leave: vi.fn(async () => 'left' as const),
    channelLabel: vi.fn(async () => 'Release crew'),
    displayName: vi.fn(async (id: string) => (id === '8' ? 'Bob' : 'Anna')),
    postPrivate: vi.fn(async (_u: string, text: string) => { calls.private.push(text); }),
    postInThread: vi.fn(async (_c: string, _t: string, text: string) => { calls.posted.push(text); }),
    readContext: vi.fn(async () => ''),
    readMessage: vi.fn(async () => null),
    permalink: vi.fn(async () => undefined),
    budgetPause: vi.fn(async () => null),
    shouldSendHint: (key: string) => (sent.has(key) ? false : (sent.add(key), true)),
    seen: (m) => { calls.seen.push(m.messageId); },
    dispatch: (input) => { calls.dispatched.push(input); },
    ...over,
  };
  return { deps, calls };
}

const inbound = (over: Partial<GroupInbound> = {}): GroupInbound => ({
  user: '7', channelId: '-1001', messageId: '50', replyThread: MAIN_THREAD, text: 'when do we ship?', mentioned: true, hasFiles: false, ...over,
});

describe('handleGroupMessage', () => {
  let ctx: ReturnType<typeof makeDeps>;
  beforeEach(() => { ctx = makeDeps(); });

  test('a reply to the bot is addressed without a mention, and answers in the chat thread', async () => {
    expect(await handleGroupMessage(inbound({ mentioned: false, repliedToBot: true }), ctx.deps)).toBe('dispatched');
    expect(ctx.calls.dispatched[0]!.threadId).toBe(MAIN_THREAD);
  });

  test('without a thread there is nothing to follow: unmentioned talk is not addressed', async () => {
    expect(await handleGroupMessage(inbound({ mentioned: false }), ctx.deps)).toBe('not_addressed');
    expect(ctx.deps.isThreadActive).not.toHaveBeenCalled();
    // …but the enrolled chat's message was seen, for the transcript.
    expect(ctx.calls.seen).toEqual(['50']);
  });

  test('nothing is seen in a chat nobody enrolled', async () => {
    ctx = makeDeps({ findGroup: vi.fn(async () => null) });
    await handleGroupMessage(inbound({ mentioned: false }), ctx.deps);
    expect(ctx.calls.seen).toEqual([]);
  });

  test('take this, replying to a message, takes that message, attributed to its author', async () => {
    const replyTo = { id: '40', text: 'The staging DB is slow again', user: '8' };
    expect(await handleGroupMessage(inbound({ text: 'take this', replyTo }), ctx.deps)).toBe('taken');
    expect(ctx.calls.dispatched[0]!.take).toEqual({
      text: 'The staging DB is slow again', author: 'Bob', quoted: true, messageKey: '-1001:40', url: undefined,
    });
    expect(ctx.deps.readMessage).not.toHaveBeenCalled();
  });

  test("take this on the bot's own message attributes it to Octipus; on your own, to nobody", async () => {
    await handleGroupMessage(inbound({ text: 'take this', replyTo: { id: '41', text: 'Draft: release notes', user: '42' } }), ctx.deps);
    expect(ctx.calls.dispatched[0]!.take?.author).toBe('Octipus');
    await handleGroupMessage(inbound({ text: 'take it', messageId: '51', replyTo: { id: '43', text: 'fix the cache', user: '7' } }), ctx.deps);
    expect(ctx.calls.dispatched[1]!.take?.author).toBeUndefined();
  });

  test('take this alone, with nothing replied to and no thread: a private hint', async () => {
    expect(await handleGroupMessage(inbound({ text: 'take this' }), ctx.deps)).toBe('hint');
    expect(ctx.calls.private).toEqual([hints.takeWhat]);
  });

  test('with the budget used up, a bare yes in the chat still goes through, replying or mentioning', async () => {
    ctx = makeDeps({ budgetPause: vi.fn(async () => ({ resetsAt: '2026-11-01T00:00:00.000Z' })) });
    expect(await handleGroupMessage(inbound({ text: 'yes', mentioned: false, repliedToBot: true }), ctx.deps)).toBe('dispatched');
    expect(await handleGroupMessage(inbound({ text: 'yes', messageId: '52' }), ctx.deps)).toBe('dispatched');
    // A post that starts its own thread (a new Teams channel post) has no prompt to answer.
    expect(await handleGroupMessage(inbound({ text: 'yes', messageId: '53', replyThread: '53' }), ctx.deps)).toBe('paused');
    expect(await handleGroupMessage(inbound({ text: 'yes please', messageId: '54' }), ctx.deps)).toBe('paused');
  });

  test('link and join refusals are private and once a day', async () => {
    await handleGroupMessage(inbound({ text: 'link' }), ctx.deps);
    await handleGroupMessage(inbound({ text: 'link', messageId: '55' }), ctx.deps);
    ctx.deps.join = vi.fn(async (): Promise<JoinResult> => ({ status: 'taken', ownerName: 'bob' }));
    await handleGroupMessage(inbound({ text: 'join', messageId: '56' }), ctx.deps);
    await handleGroupMessage(inbound({ text: 'join', messageId: '57' }), ctx.deps);
    expect(ctx.calls.private).toEqual([hints.linkInChannel, hints.taken('bob')]);
  });

  test('prompts say how to answer on each platform', () => {
    expect(answerHow('slack', '90.0')).toBe('in the thread');
    expect(answerHow('teams', MAIN_THREAD)).toBe('mentioning me');
    expect(answerHow('teams', '17000')).toBe('in the thread, mentioning me');
    expect(answerHow('telegram', MAIN_THREAD)).toBe('as a reply to my message, or mentioning me');
  });

  test('enrolling and leaving forget what the adapter kept about the chat', async () => {
    const forget = vi.fn();
    ctx = makeDeps({ findGroup: vi.fn(async () => null), forget });
    await handleGroupMessage(inbound({ text: 'join' }), ctx.deps);
    ctx = makeDeps({ forget });
    await handleGroupMessage(inbound({ text: 'leave' }), ctx.deps);
    expect(forget).toHaveBeenCalledTimes(2);
  });

  test('platform texts: how to link, and how the conversation continues', async () => {
    expect(hints.linkFirst).toBe('Link your Telegram account to Octipus first: send me /link in a private chat and enter the code under Settings → Channels.');
    expect(hints.linkInChannel).toContain('Send me /link in a private chat instead.');
    ctx = makeDeps({ findGroup: vi.fn(async () => null) });
    expect(await handleGroupMessage(inbound({ text: 'join' }), ctx.deps)).toBe('joined');
    expect(ctx.calls.posted[0]).toContain('reply to me.');
    expect(ctx.calls.posted[0]).toContain('`@octipus_bot leave`');
  });
});
