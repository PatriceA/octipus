import { sessionGeneration } from '@/db/schema/sessions';
import { messageRepository } from '@/db/repositories/message-repository';
import { sessionRepository } from '@/db/repositories/session-repository';
import type { Message } from '@/db/schema/messages';
import type { SessionContext } from '@/db/schema/sessions';
import type { AgentMessage } from './types';
import { omitGroupTranscripts } from '@/core/channels/group-context';

/** A history row, with its author's display name in a room (null in a chat). */
export type HistoryRow = Message & { authorName: string | null };

/** The current request of a room turn: it is never part of the history (each consumer appends it). */
export interface RoomRequest {
  requesterId: string;
  /** The posted message the turn answers; without it, a trailing post of the requester with `content` is the request. */
  postedMessageId?: string;
  content?: string;
}

/**
 * One ordering and boundary contract for cold launches and compaction.
 *
 * For a room (`kind = 'room'`, coworking §6.4) the history is ONE fenced
 * block (`src/core/rooms/room-context.ts`): the checkpoint summary, then the
 * attributed transcript from `checkpoint.through` on, then — given `room` —
 * who asked and that everyone reads the reply. `rows` are the same rows with
 * author names. The current request is never included.
 */
export async function readSessionHistory(sessionId: string, opts: { room?: RoomRequest } = {}) {
  const session = await sessionRepository.findById(sessionId);
  const context: SessionContext = session?.context ?? {};
  const generation = sessionGeneration(context);
  const checkpoint = context.checkpoint?.generation === generation ? context.checkpoint : undefined;
  const found = await messageRepository.findContextMessages(sessionId, context.clearedAt, checkpoint?.through, generation);
  if (session?.kind === 'room') {
    const rows = await withAuthorNames(withoutRequest(found, opts.room));
    const { renderRoomTranscript } = await import('@/core/rooms/room-context');
    const requesterName = opts.room ? (await displayNames([opts.room.requesterId])).get(opts.room.requesterId) ?? null : null;
    const block = renderRoomTranscript({ roomTitle: session.title ?? 'Room', rows, summary: checkpoint?.summary, requesterName });
    const at = rows.at(-1)?.createdAt ?? (checkpoint ? new Date(checkpoint.through.createdAt) : session.createdAt);
    return { session, generation, checkpoint, rows, messages: [{ role: 'user' as const, content: block, timestamp: at }] as AgentMessage[] };
  }
  const rows: HistoryRow[] = found.map((row) => ({ ...row, authorName: null }));
  return { session, generation, checkpoint, rows, messages: [
    ...(checkpoint ? [{ role: 'user' as const, content: `[Conversation checkpoint]\n${checkpoint.summary}`, timestamp: new Date(checkpoint.through.createdAt) }] : []),
    ...rows.map(toContextMessage),
  ] as AgentMessage[] };
}

/** The room rows before the current request (by id, else the requester's trailing post of the same text). */
function withoutRequest(rows: Message[], request: RoomRequest | undefined): Message[] {
  if (!request) return rows;
  if (request.postedMessageId) {
    const at = rows.findIndex((row) => row.id === request.postedMessageId);
    return at < 0 ? rows : rows.slice(0, at);
  }
  const last = rows.at(-1);
  if (last && last.role === 'user' && last.authorUserId === request.requesterId && (request.content === undefined || last.content === request.content)) {
    return rows.slice(0, -1);
  }
  return rows;
}

/**
 * The room request a root agent of a room turn answers, from its context
 * metadata (`room`, set by the room turn); undefined elsewhere.
 */
export function roomRequestOf(context: { userId: string; metadata?: Record<string, unknown> }): RoomRequest | undefined {
  const room = context.metadata?.room as { postedMessageId?: unknown } | undefined;
  if (!room) return undefined;
  return { requesterId: context.userId, ...(typeof room.postedMessageId === 'string' ? { postedMessageId: room.postedMessageId } : {}) };
}

/** Display names (usernames) of `userIds`. */
export async function displayNames(userIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const [{ getDb }, { users }, { inArray }] = await Promise.all([
    import('@/db/postgres'), import('@/db/schema/users'), import('drizzle-orm'),
  ]);
  const rows = await getDb().select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, ids));
  return new Map(rows.map((row) => [row.id, row.username]));
}

async function withAuthorNames(rows: Message[]): Promise<HistoryRow[]> {
  const names = await displayNames(rows.map((row) => row.authorUserId).filter((id): id is string => !!id));
  return rows.map((row) => ({ ...row, authorName: row.authorUserId ? names.get(row.authorUserId) ?? null : null }));
}

export function toContextMessage(row: Message): AgentMessage {
  const promptContext = typeof row.metadata?.promptContext === 'string'
    ? omitGroupTranscripts(row.metadata.promptContext)
    : row.metadata?.promptContext;
  return { sourceMessageId: row.id, role: row.role as AgentMessage['role'],
    content: [promptContext, row.content].filter(Boolean).join('\n\n'), timestamp: row.createdAt };
}

/**
 * Ceiling on the serialized native-conversation snapshot kept in
 * `sessions.context`. That column is read and rewritten on every turn, and the
 * snapshot carries tool results and provider-native blocks, so it grows much
 * faster than the text transcript. Past this we keep the newest turns: the
 * durable record is the `messages` table, and the snapshot only exists to
 * preserve native state the transcript cannot express.
 * ponytail: char budget, not tokens — this is a storage guard, not a context
 * guard; swap in a token count if it ever needs to be exact.
 */
export const NATIVE_SNAPSHOT_MAX_CHARS = 256_000;

export function capNativeSnapshot<T extends { role: string; content: string }>(messages: T[]): T[] {
  const size = (m: T) => JSON.stringify(m).length;
  let total = messages.reduce((n, m) => n + size(m), 0);
  if (total <= NATIVE_SNAPSHOT_MAX_CHARS) return messages;
  const kept = [...messages];
  // Head is oldest. Drop from the head, then discard tool results whose calling
  // assistant turn went with them — a leading orphan `tool` message is rejected
  // by every provider.
  while (kept.length > 1 && total > NATIVE_SNAPSHOT_MAX_CHARS) total -= size(kept.shift()!);
  while (kept.length > 1 && kept[0].role === 'tool') total -= size(kept.shift()!);
  return kept;
}

/** Serialize maintenance and CLI runs for a session inside the server process. */
const locks = new Map<string, Promise<void>>();
export async function withSessionConversation<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
  const prior = locks.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const tail = prior.then(() => held);
  locks.set(sessionId, tail);
  await prior;
  try { return await run(); }
  finally { release(); if (locks.get(sessionId) === tail) locks.delete(sessionId); }
}
