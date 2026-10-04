/**
 * Every non-gateway socket a signed-in user holds: legacy `/ws`,
 * `/ws/permissions`, `/ws/browser-bridge` and `/voice`. Each endpoint checks
 * its credential once, at open, so without this list a deactivated user's open
 * socket would keep streaming until it dropped on its own. The gateway keeps
 * its own per-user index (ConnectionManager.closeUserConnections).
 */
import { apiLogger } from '@/utils/logger';

interface ClosableSocket {
  close(code?: number, reason?: string): void;
}

const byUser = new Map<string, Set<ClosableSocket>>();

/** Remember `ws` as one of `userId`'s sockets. Returns the untrack function for its close handler. */
export function trackUserSocket(userId: string, ws: ClosableSocket): () => void {
  let set = byUser.get(userId);
  if (!set) {
    set = new Set();
    byUser.set(userId, set);
  }
  set.add(ws);
  return () => {
    const current = byUser.get(userId);
    if (!current) return;
    current.delete(ws);
    if (current.size === 0) byUser.delete(userId);
  };
}

/** Close every tracked socket of `userId`. Returns how many were closed. */
export function closeUserSockets(userId: string, code: number, reason: string): number {
  const set = byUser.get(userId);
  if (!set) return 0;
  byUser.delete(userId);
  let closed = 0;
  for (const ws of set) {
    try {
      ws.close(code, reason);
      closed++;
    } catch (err) {
      apiLogger.warn({ err, userId }, 'Could not close a user socket');
    }
  }
  return closed;
}

/** Live socket count for `userId` (tests and diagnostics). */
export function userSocketCount(userId: string): number {
  return byUser.get(userId)?.size ?? 0;
}
