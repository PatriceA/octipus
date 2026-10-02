import { describe, expect, test } from 'vitest';
import { MAIN_THREAD } from '@/channels/group-handler';
import { isGroupChat, type TelegramMessageLike, telegramName, telegramPermalink, toTelegramGroupInbound } from './group';

const me = { id: 42, username: 'octipus_bot' };
const anna = { id: 7, first_name: 'Anna', last_name: 'Schmidt', username: 'anna' };
const message = (over: Partial<TelegramMessageLike> = {}): TelegramMessageLike => ({
  message_id: 50,
  chat: { id: -1001, type: 'supergroup', title: 'Release crew' },
  from: anna,
  text: '@octipus_bot when do we ship?',
  entities: [{ type: 'mention', offset: 0, length: 12 }],
  ...over,
});

describe('Telegram group mapping', () => {
  test('a mention addresses the bot and is removed from the text', () => {
    expect(toTelegramGroupInbound(message(), me)).toEqual({
      user: '7', channelId: '-1001', messageId: '50', replyThread: MAIN_THREAD, text: 'when do we ship?',
      mentioned: true, repliedToBot: false, replyTo: undefined, hasFiles: false, raw: undefined,
    });
  });

  test('a mention in the middle, case-insensitively; another @name is not the bot', () => {
    const mid = toTelegramGroupInbound(message({ text: 'hey @Octipus_Bot ship it', entities: [{ type: 'mention', offset: 4, length: 12 }] }), me);
    expect(mid).toMatchObject({ mentioned: true, text: 'hey ship it' });
    const other = toTelegramGroupInbound(message({ text: '@bob ship it', entities: [{ type: 'mention', offset: 0, length: 4 }] }), me);
    expect(other).toMatchObject({ mentioned: false, text: '@bob ship it' });
  });

  test('commands: /join and /leave@bot are the group commands; another bot\'s command is not ours', () => {
    expect(toTelegramGroupInbound(message({ text: '/join', entities: [{ type: 'bot_command', offset: 0, length: 5 }] }), me))
      .toMatchObject({ mentioned: true, text: 'join' });
    expect(toTelegramGroupInbound(message({ text: '/leave@octipus_bot', entities: [{ type: 'bot_command', offset: 0, length: 18 }] }), me))
      .toMatchObject({ mentioned: true, text: 'leave' });
    expect(toTelegramGroupInbound(message({ text: '/link', entities: [{ type: 'bot_command', offset: 0, length: 5 }] }), me))
      .toMatchObject({ mentioned: true, text: 'link' });
    expect(toTelegramGroupInbound(message({ text: '/stop@octipus_bot now', entities: [{ type: 'bot_command', offset: 0, length: 17 }] }), me))
      .toMatchObject({ mentioned: true, text: '/stop now' });
    expect(toTelegramGroupInbound(message({ text: '/join@otherbot', entities: [{ type: 'bot_command', offset: 0, length: 14 }] }), me))
      .toMatchObject({ mentioned: false });
  });

  test('a reply to the bot addresses it; the replied-to message is handed over for take this', () => {
    const inbound = toTelegramGroupInbound(message({
      text: 'yes', entities: [],
      reply_to_message: { message_id: 49, chat: { id: -1001, type: 'supergroup' }, from: { id: 42, is_bot: true }, text: 'Shall I post it?' },
    }), me);
    expect(inbound).toMatchObject({ mentioned: false, repliedToBot: true, replyTo: { id: '49', text: 'Shall I post it?', user: '42' } });
  });

  test('a forum topic is a thread; its opening message is not a reply', () => {
    const inbound = toTelegramGroupInbound(message({
      is_topic_message: true, message_thread_id: 30,
      reply_to_message: { message_id: 30, chat: { id: -1001, type: 'supergroup' }, from: { id: 42 }, text: 'Topic' },
    }), me);
    expect(inbound).toMatchObject({ replyThread: '30', repliedToBot: false, replyTo: undefined });
  });

  test('private chats, other bots and channels are not group messages', () => {
    expect(toTelegramGroupInbound(message({ chat: { id: 7, type: 'private' } }), me)).toBeNull();
    expect(toTelegramGroupInbound(message({ from: { id: 9, is_bot: true } }), me)).toBeNull();
    expect(isGroupChat({ type: 'group' })).toBe(true);
    expect(isGroupChat({ type: 'channel' })).toBe(false);
  });

  test('a captioned photo: the caption is the text, the photo a file', () => {
    const inbound = toTelegramGroupInbound(message({
      text: undefined, caption: '@octipus_bot what is this?', caption_entities: [{ type: 'mention', offset: 0, length: 12 }], photo: [{}],
    }), me);
    expect(inbound).toMatchObject({ mentioned: true, text: 'what is this?', hasFiles: true });
  });

  test('names and links', () => {
    expect(telegramName(anna)).toBe('Anna Schmidt');
    expect(telegramName({ id: 3, username: 'zed' })).toBe('zed');
    expect(telegramPermalink('-1001234', '50')).toBe('https://t.me/c/1234/50');
    expect(telegramPermalink('-4321', '50')).toBeUndefined();
  });
});
