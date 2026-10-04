/**
 * Per-user change marks for sockets that authenticate across awaits.
 *
 * A deactivation or an admin change closes the sockets a user holds
 * (`onUserChanged`, `closeUserSockets`), but those sweeps only see sockets that
 * are already registered. A socket whose credential was checked before the
 * change and that registers after the sweep would keep stale rights. So an
 * endpoint takes `userChangeMark()` before it checks the credential, and once
 * the socket is registered asks `userChangedSince(userId, mark)`: if the user
 * changed in between, it closes the socket and the client re-authenticates
 * against the current row.
 *
 * Dependency-free on purpose: the gateway connection manager and the socket
 * registry both import it.
 */

let counter = 0;
const changedAt = new Map<string, number>();

/** The current mark. Take it before validating a credential. */
export function userChangeMark(): number {
  return counter;
}

/** Record that `userId`'s active or admin flag just changed. Call before sweeping their sockets. */
export function markUserChanged(userId: string): void {
  counter += 1;
  changedAt.set(userId, counter);
}

/** Whether `userId` changed after `mark` was taken. */
export function userChangedSince(userId: string, mark: number): boolean {
  return (changedAt.get(userId) ?? 0) > mark;
}
