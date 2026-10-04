/**
 * Sessions leaving the live set: deleted, or archived (status `completed`).
 *
 * The session repositories call `sessionsRemoved` after such a write; the
 * gateway hub listens and drops the session's replay buffer, so a deleted
 * session's events do not linger in memory (and cannot be replayed).
 *
 * Dependency-free on purpose: the repositories and the gateway both import it.
 */
import { dbLogger } from '@/utils/logger';

type Listener = (sessionIds: readonly string[]) => void;

const listeners = new Set<Listener>();

/** Be told about sessions that were deleted or archived. Returns the unsubscribe. */
export function onSessionsRemoved(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tell the listeners `sessionIds` were deleted or archived. */
export function sessionsRemoved(sessionIds: readonly string[]): void {
  if (sessionIds.length === 0) return;
  for (const listener of listeners) {
    try {
      listener(sessionIds);
    } catch (err) {
      dbLogger.error({ err, count: sessionIds.length }, 'Session removal listener failed');
    }
  }
}
