/**
 * Telegram groups, mapped onto the group-channel rules
 * (`src/channels/group-handler.ts`).
 *
 * - **Addressing.** `@botname`, a text mention of the bot, a command for it
 *   (`/join@botname` — a bare `/join` goes to every bot in the group), or a
 *   reply to one of the bot's messages.
 *   With privacy mode on (BotFather's default) that is all the bot receives.
 * - **Threads.** Telegram groups have reply chains, not threads: a group is
 *   one conversation (`MAIN_THREAD`), and replies answer the message that
 *   addressed the bot. In a forum supergroup each topic is a thread.
 * - **Context.** The Bot API cannot read history, so the transcript comes
 *   from what the bot saw (`group-buffer.ts`).
 * - **`take this`** alone takes the message it replies to.
 */
import { type GroupInbound, MAIN_THREAD } from '@/channels/group-handler';

interface Entity { type: string; offset: number; length: number; user?: { id: number } }

/** As much of a Telegram message as the mapping reads. */
export interface TelegramMessageLike {
  message_id: number;
  date?: number;
  text?: string;
  caption?: string;
  from?: { id: number; is_bot?: boolean; username?: string; first_name?: string; last_name?: string };
  chat: { id: number; type: string; title?: string };
  message_thread_id?: number;
  is_topic_message?: boolean;
  entities?: Entity[];
  caption_entities?: Entity[];
  reply_to_message?: TelegramMessageLike;
  photo?: unknown[];
  document?: unknown;
  voice?: unknown;
}

export interface BotIdentity {
  id: number;
  username: string;
}

export function isGroupChat(chat: { type: string } | undefined): boolean {
  return chat?.type === 'group' || chat?.type === 'supergroup';
}

/** How the group shows a member: first and last name, else the username. */
export function telegramName(from: TelegramMessageLike['from']): string {
  if (!from) return 'a member';
  return [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || String(from.id);
}

/** The commands the group rules handle themselves (`/join` reads as `join`). */
const GROUP_COMMANDS = new Set(['join', 'leave', 'link']);

/** The forum topic a message is in, or the group's single thread. */
export function telegramThread(msg: Pick<TelegramMessageLike, 'is_topic_message' | 'message_thread_id'>): string {
  return msg.is_topic_message && msg.message_thread_id ? String(msg.message_thread_id) : MAIN_THREAD;
}

/** A link to a message in a supergroup (`t.me/c/…`); undefined for a basic group. */
export function telegramPermalink(chatId: string, messageId: string): string | undefined {
  return chatId.startsWith('-100') ? `https://t.me/c/${chatId.slice(4)}/${messageId}` : undefined;
}

/** A group message as a `GroupInbound`; null when it is not in a group or has no sender. */
export function toTelegramGroupInbound<Raw>(msg: TelegramMessageLike, me: BotIdentity, raw?: Raw): GroupInbound<Raw> | null {
  if (!isGroupChat(msg.chat) || !msg.from || msg.from.is_bot) return null;
  const source = msg.text ?? msg.caption ?? '';
  const entities = msg.text !== undefined ? msg.entities ?? [] : msg.caption_entities ?? [];
  const botName = `@${me.username}`.toLowerCase();

  // Remove the bot's mentions, from the end so earlier offsets stay valid.
  let text = source;
  let mentioned = false;
  for (const e of [...entities].sort((a, b) => b.offset - a.offset)) {
    const part = source.slice(e.offset, e.offset + e.length);
    if ((e.type === 'mention' && part.toLowerCase() === botName) || (e.type === 'text_mention' && e.user?.id === me.id)) {
      mentioned = true;
      text = text.slice(0, e.offset) + text.slice(e.offset + e.length);
    } else if (e.type === 'bot_command' && e.offset === 0) {
      // In a group a bare `/help` goes to every bot in it: only `/cmd@thisbot` is ours.
      const [name, target] = part.slice(1).split('@') as [string, string | undefined];
      if (target === undefined || `@${target}`.toLowerCase() !== botName) continue;
      mentioned = true;
      // `/join` → `join`; other commands (`/stop`) stay commands, without the @botname.
      const replacement = GROUP_COMMANDS.has(name.toLowerCase()) ? name.toLowerCase() : `/${name}`;
      text = replacement + text.slice(e.offset + e.length);
    }
  }

  const reply = msg.reply_to_message;
  // In a forum every message "replies" to the topic's first message; that is not a reply.
  const realReply = reply && !(msg.is_topic_message && reply.message_id === msg.message_thread_id) ? reply : undefined;
  return {
    user: String(msg.from.id),
    channelId: String(msg.chat.id),
    messageId: String(msg.message_id),
    replyThread: telegramThread(msg),
    text: text.replace(/[ \t]+/g, ' ').trim(),
    mentioned,
    repliedToBot: realReply?.from?.id === me.id,
    replyTo: realReply ? {
      id: String(realReply.message_id),
      text: realReply.text ?? realReply.caption ?? '',
      user: realReply.from ? String(realReply.from.id) : null,
    } : undefined,
    hasFiles: Boolean(msg.photo?.length || msg.document || msg.voice),
    raw,
  };
}
