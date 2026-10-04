/**
 * Every non-gateway socket a signed-in user holds: legacy `/ws`,
 * `/ws/permissions`, `/ws/browser-bridge` and `/voice`. Each endpoint checks
 * its credential once, at open, so without this list a deactivated user's open
 * socket would keep streaming until it dropped on its own. The gateway keeps
 * its own per-user index (ConnectionManager.closeUserConnections).
 */
import { userChangedSince } from '@/security/user-change-marks';
import { apiLogger } from '@/utils/logger';

/** Same code and reason as the gateway's (USER_CHANGED_CLOSE_CODE): re-authenticate. */
const USER_CHANGED_CLOSE_CODE = 4004;

interface ClosableSocket {
  close(code?: number, reason?: string): void;
}

const byUser = new Map<string, Set<ClosableSocket>>();

/**
 * Remember `ws` as one of `userId`'s sockets. `mark` is the
 * `userChangeMark()` taken before the credential was checked: if the user was
 * deactivated or their admin flag changed since, the sweep may already have
 * run without this socket, so it is closed here instead. Returns the untrack
 * function for its close handler, or null when the socket was closed.
 */
export function trackUserSocket(userId: string, ws: ClosableSocket, mark: number): (() => void) | null {
  let set = byUser.get(userId);
  if (!set) {
    set = new Set();
    byUser.set(userId, set);
  }
  set.add(ws);
  const untrack = () => {
    const current = byUser.get(userId);
    if (!current) return;
    current.delete(ws);
    if (current.size === 0) byUser.delete(userId);
  };
  if (userChangedSince(userId, mark)) {
    untrack();
    ws.close(USER_CHANGED_CLOSE_CODE, 'Account changed');
    return null;
  }
  return untrack;
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
