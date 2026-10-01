/**
 * The dispatcher's half of taking work on (docs/plans/group-chat-bot.md §5)
 * and the line a taken task posts in its thread when it closes.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { UnifiedMessage } from '@/core/types';
import type { GroupChannel } from '@/db/schema/group-channels';
import type { Task } from '@/db/schema/tasks';

const fx = vi.hoisted(() => ({
  take: vi.fn(),
  group: { id: 'g1' } as { id: string } | null,
  active: true,
}));
vi.mock('@/core/channels/taken-tasks', () => ({ takeChannelTask: fx.take }));
vi.mock('./group-channels', () => ({
  findGroupChannel: async () => fx.group,
  isGroupChannelActive: async () => fx.active,
}));
import { sessionRepository } from '@/db/repositories/session-repository';
import { getUMI } from './interface';
import { startTakenWork, takeRequestOf } from './take-work';
import { announceTakenTaskClosed } from './taken-task-notices';

const SESSION = '11111111-1111-4111-8111-111111111111';
const group = { id: 'g1', channelType: 'slack', channelId: 'C1', label: '#release', ownerUserId: 'owner' } as GroupChannel;
const message: UnifiedMessage = {
  id: 'm', channelType: 'slack', channelId: 'C1', userId: 'u-anna', userName: 'Anna Schmidt',
  content: 'take this — draft the notes', threadId: '90.0', timestamp: new Date(),
};
const task = (over: Partial<Task> = {}) => ({
  id: 't1', userId: 'u-anna', title: 'Draft the *notes*', status: 'in_progress', source: 'channel',
  sourceRef: { sessionId: SESSION }, ...over,
}) as Task;

let send: ReturnType<typeof vi.spyOn>;
let sendPrivate: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fx.take.mockReset();
  fx.group = { id: 'g1' };
  fx.active = true;
  vi.spyOn(sessionRepository, 'findById').mockResolvedValue({
    id: SESSION, userId: 'u-anna', workspaceId: 'ws', channelType: 'slack', channelId: 'C1', threadId: '90.0', groupChannelId: 'g1',
  } as never);
  send = vi.spyOn(getUMI(), 'send').mockResolvedValue('ts');
  sendPrivate = vi.spyOn(getUMI(), 'sendPrivate').mockResolvedValue(true);
});
afterEach(() => vi.restoreAllMocks());

describe('takeRequestOf', () => {
  test('accepts what the adapter wrote; refuses anything else', () => {
    expect(takeRequestOf({ text: 'x', messageKey: 'C1:1', author: 'Bob', url: 'https://x.slack.com/p1' }))
      .toEqual({ text: 'x', messageKey: 'C1:1', author: 'Bob', url: 'https://x.slack.com/p1' });
    expect(takeRequestOf({ text: 'x', messageKey: 'C1:1', url: 'javascript:alert(1)' })).toEqual({ text: 'x', messageKey: 'C1:1' });
    for (const bad of [undefined, 'take', { text: '', messageKey: 'k' }, { text: 'x' }]) expect(takeRequestOf(bad)).toBeUndefined();
  });
});

describe('startTakenWork', () => {
  test("puts it on the member's board in their workspace and says so in the thread", async () => {
    fx.take.mockResolvedValue({ task: task(), created: true });
    const taken = await startTakenWork({ message, sessionId: SESSION, group, request: { text: 'draft the notes', messageKey: 'C1:100.1' } });
    expect(taken).toEqual({ taskId: 't1', title: 'Draft the *notes*' });
    expect(fx.take).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u-anna', workspaceId: 'ws', sessionId: SESSION, requester: 'Anna Schmidt', where: '#release',
    }));
    expect(send).toHaveBeenCalledWith('slack', 'C1', { content: "On it — added *Draft the notes* to Anna Schmidt's tasks.", threadId: '90.0' });
  });

  test("someone else's message travels with the task to the turn", async () => {
    fx.take.mockResolvedValue({ task: task(), created: true });
    const taken = await startTakenWork({ message, sessionId: SESSION, group, request: { text: 'fix it', author: 'Bob', messageKey: 'C1:90.0' } });
    expect(taken).toMatchObject({ author: 'Bob', text: 'fix it' });
  });

  test('taken already: told privately, no turn', async () => {
    fx.take.mockResolvedValue({ task: task({ status: 'done' }), created: false });
    expect(await startTakenWork({ message, sessionId: SESSION, group, request: { text: 'x', messageKey: 'C1:1' } })).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(sendPrivate).toHaveBeenCalledWith('slack', 'C1', 'u-anna', expect.objectContaining({ content: expect.stringContaining('(done)') }));
  });
});

describe('announceTakenTaskClosed', () => {
  test('done, archived or deleted: one line in its thread', async () => {
    await announceTakenTaskClosed({ task: task({ status: 'done' }), previousStatus: 'in_progress', cause: 'closed' });
    await announceTakenTaskClosed({ task: task({ status: 'archived' }), previousStatus: 'open', cause: 'closed' });
    await announceTakenTaskClosed({ task: task(), previousStatus: 'in_progress', cause: 'deleted' });
    expect(send.mock.calls.map((c: unknown[]) => (c[2] as { content: string }).content)).toEqual([
      '✅ Done: *Draft the notes*',
      'Archived: *Draft the notes*. Nobody is working on it now.',
      'Removed from the board: *Draft the notes*.',
    ]);
    expect(send.mock.calls[0]![2]).toMatchObject({ threadId: '90.0' });
  });

  test('a broadcast mention in the title is not repeated as one', async () => {
    await announceTakenTaskClosed({ task: task({ status: 'done', title: 'Tell <!channel> about it' }), previousStatus: 'open', cause: 'closed' });
    expect((send.mock.calls[0]![2] as { content: string }).content).toBe('✅ Done: *Tell @channel about it*');
  });

  test('silent for other tasks, other owners, and removed or paused channels', async () => {
    await announceTakenTaskClosed({ task: task({ source: 'agent' }), previousStatus: 'open', cause: 'closed' });
    await announceTakenTaskClosed({ task: task({ userId: 'u-bob' }), previousStatus: 'open', cause: 'closed' });
    await announceTakenTaskClosed({ task: task({ sourceRef: { sessionId: 'not-a-uuid' } }), previousStatus: 'open', cause: 'closed' });
    fx.active = false;
    await announceTakenTaskClosed({ task: task({ status: 'done' }), previousStatus: 'open', cause: 'closed' });
    fx.active = true;
    fx.group = null;
    await announceTakenTaskClosed({ task: task({ status: 'done' }), previousStatus: 'open', cause: 'closed' });
    expect(send).not.toHaveBeenCalled();
  });
});
