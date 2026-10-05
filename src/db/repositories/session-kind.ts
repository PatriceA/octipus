import { eq } from 'drizzle-orm';
import { getDb } from '../postgres';
import { type SessionKind, sessions } from '../schema/sessions';

/**
 * The kind of a session (`chat` or `room`, coworking §6.1), from a bounded
 * in-process cache. A session's kind is set at creation and never changes,
 * so a cached answer never goes stale; a missing row is not cached (it may
 * be created next). Used by the message writers that skip or refuse rows for
 * rooms and by the room fan-out — none of which may import rooms code.
 */
const MAX_CACHED = 10_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const kinds = new Map<string, SessionKind>();

function remember(sessionId: string, kind: SessionKind): void {
  kinds.delete(sessionId);
  kinds.set(sessionId, kind);
  if (kinds.size > MAX_CACHED) kinds.delete(kinds.keys().next().value as string);
}

/** The session's kind, or null when no such session exists. Throws on a failed read. */
export async function sessionKindOf(sessionId: string): Promise<SessionKind | null> {
  const cached = kinds.get(sessionId);
  if (cached) return cached;
  if (!UUID_RE.test(sessionId)) return null;
  // i2: one column of one session by id, for the writers that must know whether it is a room
  const [row] = await getDb().select({ kind: sessions.kind }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  if (!row) return null;
  remember(sessionId, row.kind);
  return row.kind;
}

/** Whether `sessionId` is a room. */
export async function isRoomSession(sessionId: string | undefined | null): Promise<boolean> {
  if (!sessionId) return false;
  return (await sessionKindOf(sessionId)) === 'room';
}

/** Record a kind already read (a create, a full row read): saves the next lookup. */
export function noteSessionKind(sessionId: string, kind: SessionKind): void {
  remember(sessionId, kind);
}

/** Test hook. */
export function _resetSessionKindsForTests(): void {
  kinds.clear();
}
