import { describe, expect, test } from 'vitest';
import { MAIN_THREAD } from '@/channels/group-handler';
import { conversationKind, splitConversationId, type TeamsActivityLike, threadConversationId, toGroupInbound } from './group';

const BOT = '28:app';
const activity = (over: Partial<TeamsActivityLike> = {}): TeamsActivityLike => ({
  id: '1700000000001',
  text: '<at>Octipus</at> when do we ship?',
  from: { id: '29:anna', name: 'Anna Schmidt', aadObjectId: 'aad-anna' },
  recipient: { id: BOT, name: 'Octipus' },
  conversation: { id: '19:abc@thread.tacv2;messageid=1700000000001', conversationType: 'channel' },
  entities: [{ type: 'mention', text: '<at>Octipus</at>', mentioned: { id: BOT } }],
  ...over,
});

describe('Teams group mapping', () => {
  test('conversation ids: the channel and its thread root', () => {
    expect(splitConversationId('19:abc@thread.tacv2;messageid=123')).toEqual({ base: '19:abc@thread.tacv2', root: '123' });
    expect(splitConversationId('19:chat@thread.v2')).toEqual({ base: '19:chat@thread.v2' });
    expect(threadConversationId('19:abc@thread.tacv2', '123')).toBe('19:abc@thread.tacv2;messageid=123');
    expect(threadConversationId('19:abc@thread.tacv2', MAIN_THREAD)).toBe('19:abc@thread.tacv2');
    expect(conversationKind({ conversation: { id: 'a:1' } })).toBe('personal');
  });

  test('a new channel post that mentions the bot starts its own thread', () => {
    expect(toGroupInbound(activity())).toEqual({
      user: 'aad-anna',
      channelId: '19:abc@thread.tacv2',
      messageId: '1700000000001',
      threadId: undefined,
      replyThread: '1700000000001',
      text: 'when do we ship?',
      mentioned: true,
      hasFiles: false,
      raw: undefined,
    });
  });

  test('a reply in a channel thread is in that thread', () => {
    const inbound = toGroupInbound(activity({ id: '1700000000009' }));
    expect(inbound?.threadId).toBe('1700000000001');
    expect(inbound?.replyThread).toBe('1700000000001');
  });

  test('a group chat is one thread; another mention is not the bot', () => {
    const inbound = toGroupInbound(activity({
      conversation: { id: '19:chat@thread.v2', conversationType: 'groupChat' },
      text: '<at>Bob</at> can you check?',
      entities: [{ type: 'mention', text: '<at>Bob</at>', mentioned: { id: '29:bob' } }],
    }));
    expect(inbound).toMatchObject({ channelId: '19:chat@thread.v2', replyThread: MAIN_THREAD, threadId: undefined, mentioned: false });
    expect(inbound?.text).toBe('<at>Bob</at> can you check?');
  });

  test('a 1:1 chat is not a group; HTML is reduced to text', () => {
    expect(toGroupInbound(activity({ conversation: { id: 'a:1', conversationType: 'personal' } }))).toBeNull();
    expect(toGroupInbound(activity({ text: '<p><at>Octipus</at>&nbsp;join</p>' }))?.text).toBe('join');
  });
});
