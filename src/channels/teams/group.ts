/**
 * Teams group chats and team channels, mapped onto the group-channel rules
 * (`src/channels/group-handler.ts`).
 *
 * - **Addressing.** Without resource-specific consent Teams only delivers
 *   messages that @mention the bot, so in practice every message here is a
 *   mention; the mention entity for `recipient.id` is what counts.
 * - **Threads.** A team channel's conversation id carries the thread root:
 *   `19:…@thread.tacv2;messageid=<root>`. The enrolment is keyed by the id
 *   without it; the root is the thread (a new post is its own root). A group
 *   chat has no threads: it is one conversation, `MAIN_THREAD`.
 * - **Context.** The bot cannot read the conversation back without Graph
 *   RSC, so the transcript comes from what it saw (`group-buffer.ts`).
 */
import { type GroupInbound, MAIN_THREAD } from '@/channels/group-handler';

/** As much of a Bot Framework activity as the mapping reads. */
export interface TeamsActivityLike {
  id?: string;
  text?: string;
  replyToId?: string;
  from: { id: string; name?: string; aadObjectId?: string };
  recipient: { id: string; name?: string };
  conversation: { id: string; conversationType?: string; name?: string };
  entities?: Array<{ type?: string; text?: string; mentioned?: { id?: string } }>;
  attachments?: Array<{ contentUrl?: string; contentType?: string }>;
  channelData?: { channel?: { name?: string } };
}

export type TeamsConversationKind = 'personal' | 'groupChat' | 'channel';

export function conversationKind(activity: Pick<TeamsActivityLike, 'conversation'>): TeamsConversationKind {
  const t = activity.conversation.conversationType;
  if (t === 'channel' || t === 'groupChat') return t;
  return 'personal';
}

/** `19:abc@thread.tacv2;messageid=123` → `{ base: '19:abc@thread.tacv2', root: '123' }`. */
export function splitConversationId(id: string): { base: string; root?: string } {
  const m = /^(.*?);messageid=(\d+)$/.exec(id);
  return m ? { base: m[1] as string, root: m[2] } : { base: id };
}

/** The conversation id a reply in `thread` of a channel goes to. */
export function threadConversationId(base: string, thread: string | undefined): string {
  return thread && thread !== MAIN_THREAD ? `${base};messageid=${thread}` : base;
}

/** The Teams user id identities are keyed by: the AAD object id, else the channel account id. */
export function teamsUserKey(from: TeamsActivityLike['from']): string {
  return from.aadObjectId || from.id;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' };

/** Teams sends mentions as `<at>Name</at>` and some HTML; plain text for the handler. */
export function plain(text: string): string {
  return text
    .replace(/<at>([^<]*)<\/at>/gi, '@$1')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?[a-z][^>]*>/gi, ' ')
    .replace(/&(amp|lt|gt|quot|apos|#39|nbsp);/g, (_m, name: string) => ENTITIES[name] ?? '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** A message in a group chat or channel as a `GroupInbound`; null for a 1:1 chat. */
export function toGroupInbound<Raw>(activity: TeamsActivityLike, raw?: Raw): GroupInbound<Raw> | null {
  const kind = conversationKind(activity);
  if (kind === 'personal') return null;
  let text = activity.text ?? '';
  let mentioned = false;
  for (const entity of activity.entities ?? []) {
    if (entity.type === 'mention' && entity.mentioned?.id === activity.recipient.id) {
      mentioned = true;
      if (entity.text) text = text.split(entity.text).join('');
    }
  }
  const messageId = activity.id ?? '';
  const { base, root } = splitConversationId(activity.conversation.id);
  const inThread = kind === 'channel' && root !== undefined && root !== messageId;
  return {
    user: teamsUserKey(activity.from),
    channelId: base,
    messageId,
    threadId: inThread ? root : undefined,
    replyThread: kind === 'channel' ? (root ?? messageId) : MAIN_THREAD,
    text: plain(text),
    mentioned,
    hasFiles: (activity.attachments ?? []).some(a => !!a.contentUrl && a.contentType !== 'text/html'),
    raw,
  };
}
