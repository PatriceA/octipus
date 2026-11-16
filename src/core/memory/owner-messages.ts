/**
 * Which messages are the owner's own words — the only evidence long-term
 * memory may learn from (`quote-basis.ts`).
 *
 * `role='user'` is not enough: Companion handoffs, monitors, schedules and
 * heartbeats are stored as user rows too. An owner message is a stored
 * `role='user'` row
 *  - in a session that belongs to this user, written by them (a room post by
 *    another member is not);
 *  - typed by a person: `metadata.trigger` absent or `'user'` (not `schedule`,
 *    `monitor`, `listen`, `remote`, `room`, …), and not text the service
 *    composed for the agent (`metadata.synthetic`, e.g. the plan brief run on
 *    "go");
 *  - visible: not an internal coordination input (`visibleMessages`);
 *  - in the session's current conversation generation, the same rule the
 *    transcript read uses (`contextFilters` in message-repository.ts), so a
 *    row from before a clear is not cited as if it were the live
 *    conversation.
 * The text is read from the database here, never taken from the caller, so a
 * quote is checked against what was actually stored.
 */

import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { visibleMessages } from '@/db/repositories/message-visibility';
import { type MessageMetadata, messages } from '@/db/schema/messages';
import { sessions } from '@/db/schema/sessions';
import { coreLogger } from '@/utils/logger';
import type { CandidateFact } from './extractor';
import { type OwnerMessage, verifyQuotes } from './quote-basis';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Mirrors `sessionGeneration(context)` in schema/sessions.ts, in SQL over the joined session. */
const currentGeneration = sql`coalesce(${sessions.context}->>'conversationGeneration', ${sessions.context}->>'clearedAt', '')`;

function ownerConditions(userId: string) {
  return [
    eq(messages.role, 'user'),
    eq(sessions.userId, userId),
    or(isNull(messages.authorUserId), eq(messages.authorUserId, userId)),
    visibleMessages,
    sql`coalesce(${messages.metadata}->>'trigger', 'user') = 'user'`,
    sql`${messages.metadata}->>'synthetic' IS NULL`,
    // A row stamped with a generation must carry the current one; an older
    // unstamped row counts only if it is after the last clear.
    sql`(${messages.metadata}->>'sessionGeneration' = ${currentGeneration}
      OR (${messages.metadata}->>'sessionGeneration' IS NULL
        AND (${sessions.context}->>'clearedAt' IS NULL OR ${messages.createdAt} > (${sessions.context}->>'clearedAt')::timestamptz)))`,
  ];
}

/**
 * The same rule over a row already in hand (no session or generation check):
 * whether a stored user row is worth sending to the extractor at all. The
 * database check in `loadOwnerMessages` still decides what may be cited.
 */
export function isTypedOwnerRow(row: { role: string; metadata?: MessageMetadata | null }): boolean {
  const meta = row.metadata ?? {};
  return row.role === 'user' && (meta.trigger ?? 'user') === 'user' && meta.visibility !== 'internal' && !meta.synthetic;
}

/** The cited messages that are this user's own words. Unknown, foreign and malformed ids are simply absent. */
export async function loadOwnerMessages(userId: string, ids: readonly string[]): Promise<OwnerMessage[]> {
  const wanted = [...new Set(ids)].filter((id) => UUID.test(id));
  if (wanted.length === 0) return [];
  return getDb()
    .select({ id: messages.id, text: messages.content })
    .from(messages)
    .innerJoin(sessions, eq(messages.sessionId, sessions.id))
    .where(and(inArray(messages.id, wanted), ...ownerConditions(userId)));
}

/** The owner's latest messages in one of their sessions, newest first — what `remember_this` may quote. */
export async function loadRecentOwnerMessages(userId: string, sessionId: string, limit = 20): Promise<OwnerMessage[]> {
  if (!UUID.test(sessionId)) return [];
  return getDb()
    .select({ id: messages.id, text: messages.content })
    .from(messages)
    .innerJoin(sessions, eq(messages.sessionId, sessions.id))
    .where(and(eq(messages.sessionId, sessionId), ...ownerConditions(userId)))
    .orderBy(desc(messages.createdAt))
    .limit(limit);
}

/**
 * Keep the candidates whose quote is found in a cited owner message. Rejections
 * are logged with their reason (never the quote: it may hold what made it a
 * rejection) so "the agent forgot what I said" can be traced.
 */
export async function verifyOwnerQuotes<T extends CandidateFact>(
  userId: string,
  candidates: readonly T[],
): Promise<ReturnType<typeof verifyQuotes<T>>> {
  if (candidates.length === 0) return { accepted: [], rejected: [] };
  const owner = await loadOwnerMessages(userId, candidates.flatMap((c) => c.sourceMessageIds ?? []));
  const result = verifyQuotes(candidates, owner);
  if (result.rejected.length > 0) {
    coreLogger.info(
      { userId, rejected: result.rejected.map((r) => r.reason), kept: result.accepted.length },
      'memory: dropped candidates not backed by a quote from the owner\'s own messages',
    );
  }
  return result;
}
