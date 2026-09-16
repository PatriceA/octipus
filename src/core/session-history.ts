import { sessionGeneration } from '@/db/schema/sessions';
import { messageRepository } from '@/db/repositories/message-repository';
import { sessionRepository } from '@/db/repositories/session-repository';
import type { Message } from '@/db/schema/messages';
import type { SessionContext } from '@/db/schema/sessions';
import type { AgentMessage } from './types';

/** One ordering and boundary contract for cold launches and compaction. */
export async function readSessionHistory(sessionId: string) {
  const session = await sessionRepository.findById(sessionId);
  const context: SessionContext = session?.context ?? {};
  const generation = sessionGeneration(context);
  const checkpoint = context.checkpoint?.generation === generation ? context.checkpoint : undefined;
  const rows = await messageRepository.findContextMessages(sessionId, context.clearedAt, checkpoint?.through, generation);
  return { session, generation, checkpoint, rows, messages: [
    ...(checkpoint ? [{ role: 'user' as const, content: `[Conversation checkpoint]\n${checkpoint.summary}`, timestamp: new Date(checkpoint.through.createdAt) }] : []),
    ...rows.map(toContextMessage),
  ] };
}

export function toContextMessage(row: Message): AgentMessage {
  return { sourceMessageId: row.id, role: row.role as AgentMessage['role'],
    content: [row.metadata?.promptContext, row.content].filter(Boolean).join('\n\n'), timestamp: row.createdAt };
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
