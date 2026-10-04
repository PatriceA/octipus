/**
 * Recent messages of group chats on platforms where the bot cannot read the
 * conversation back (Teams without Graph RSC, Telegram — the Bot API has no
 * history call). The adapter records what it sees — members' messages that
 * reach the bot and the bot's own replies — and the next turn's transcript is
 * rendered from it (`renderGroupContext`). Slack records here too while a
 * channel is in listen or proactive mode: the unprompted-post probe
 * (`group-listen.ts`) looks for unanswered questions in it.
 *
 * Kept in memory only, bounded per thread and in total, and dropped after a
 * day: it is a short-term view of the conversation, not a store. A restart
 * empties it; the next turn then sees only what follows.
 */
import type { ChannelMessage } from '@/core/channels/messages';

/** The author id the bot's own messages are recorded under. */
export const BUFFER_BOT_ID = 'octipus:bot';

/** A recorded message; `addressed` when it mentioned or replied to the bot (a turn handles it). */
export type BufferedMessage = ChannelMessage & { addressed?: boolean };

const MAX_PER_THREAD = 40;
const MAX_THREADS = 2_000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Longer messages are cut: the transcript clips each one to 1,200 characters anyway. */
const MAX_TEXT_CHARS = 1_500;

const threads = new Map<string, BufferedMessage[]>();
const key = (channelType: string, channelId: string, thread: string) => `${channelType}\u0000${channelId}\u0000${thread}`;

/** Record one message in a thread (or a chat's single thread). A repeat of the same id replaces it. */
export function recordGroupMessage(
  channelType: string, channelId: string, thread: string, message: BufferedMessage, now = Date.now(),
): void {
  const k = key(channelType, channelId, thread);
  const cutoff = new Date(now - MAX_AGE_MS).toISOString();
  const list = (threads.get(k) ?? []).filter(m => m.id !== message.id && m.at >= cutoff);
  list.push(message.text.length > MAX_TEXT_CHARS ? { ...message, text: message.text.slice(0, MAX_TEXT_CHARS) } : message);
  if (list.length > MAX_PER_THREAD) list.splice(0, list.length - MAX_PER_THREAD);
  threads.delete(k); // re-insert: Map order doubles as LRU order
  threads.set(k, list);
  if (threads.size > MAX_THREADS) threads.delete(threads.keys().next().value as string);
}

/** The thread's recorded messages, oldest first, without the ones past a day. */
export function groupMessages(channelType: string, channelId: string, thread: string, now = Date.now()): BufferedMessage[] {
  const list = threads.get(key(channelType, channelId, thread));
  if (!list) return [];
  const cutoff = new Date(now - MAX_AGE_MS).toISOString();
  return list.filter(m => m.at >= cutoff);
}

/** One recorded message by id, in that thread. */
export function findGroupMessage(channelType: string, channelId: string, thread: string, id: string): BufferedMessage | undefined {
  return groupMessages(channelType, channelId, thread).find(m => m.id === id);
}

/** Every thread of a chat with its recorded messages (none past a day), keyed by thread. */
export function groupThreads(channelType: string, channelId: string, now = Date.now()): Map<string, BufferedMessage[]> {
  const prefix = key(channelType, channelId, '');
  const out = new Map<string, BufferedMessage[]>();
  for (const k of threads.keys()) {
    if (!k.startsWith(prefix)) continue;
    const thread = k.slice(prefix.length);
    const list = groupMessages(channelType, channelId, thread, now);
    if (list.length > 0) out.set(thread, list);
  }
  return out;
}

/** One recorded message by id in any thread of the chat, with the thread it is in. */
export function findGroupMessageAnywhere(
  channelType: string, channelId: string, id: string,
): { message: BufferedMessage; thread: string } | undefined {
  for (const [thread, list] of groupThreads(channelType, channelId)) {
    const message = list.find(m => m.id === id);
    if (message) return { message, thread };
  }
  return undefined;
}

/** Forget a chat's threads (it was enrolled afresh, or left). */
export function forgetGroupChat(channelType: string, channelId: string): void {
  const prefix = key(channelType, channelId, '');
  for (const k of [...threads.keys()]) if (k.startsWith(prefix)) threads.delete(k);
}

/** Test seam. */
export function clearGroupBuffer(): void {
  threads.clear();
}
