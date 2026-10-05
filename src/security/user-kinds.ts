/**
 * Local accounts and remote members (docs/plans/coworking-spec.md §11, S7;
 * docs/SPACES.md → Across installs).
 *
 * A member of a space hosted here who lives on another install is a `users`
 * row with `kind = 'remote'`: a username with a leading `~`
 * (`~name@<instance-fingerprint>`), no email, no password, never an admin.
 * Such a row exists only so the host can hold its membership and role; it
 * never signs in here. Every sign-in path refuses it (`SessionManager`,
 * `ApiTokenManager`, impersonation, SAML JIT, passkeys), and admin user
 * lists and SCIM leave it out.
 *
 * Local usernames may not start with `~` (`assertLocalUsername`): the
 * registration, admin creation, SCIM and SAML JIT paths reject one, and the
 * `users_kind_chk` CHECK enforces it in the database. `@` stays allowed —
 * SAML NameIDs and SCIM userNames are usually e-mail addresses.
 */
import type { UserKind } from '@/db/schema/users';

export type { UserKind } from '@/db/schema/users';

/** The first character of every remote member's username, and of no local one. */
export const REMOTE_USERNAME_PREFIX = '~';

/** A username a local account may not have. */
export class InvalidUsernameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidUsernameError';
  }
}

/** Throws `InvalidUsernameError` when `username` is reserved for remote members (a leading `~`). */
export function assertLocalUsername(username: string): void {
  if (username.trimStart().startsWith(REMOTE_USERNAME_PREFIX)) {
    throw new InvalidUsernameError(`Usernames may not start with "${REMOTE_USERNAME_PREFIX}": it marks members from other installs`);
  }
}

/** Whether a user row is a remote member (never signs in here). */
export function isRemoteUser(user: { kind?: UserKind | string | null } | null | undefined): boolean {
  return user?.kind === 'remote';
}

/** How a remote member is shown: `~name@<instance>` as `name@instance`. */
export function remoteDisplayName(username: string): string {
  return username.startsWith(REMOTE_USERNAME_PREFIX) ? username.slice(REMOTE_USERNAME_PREFIX.length) : username;
}
