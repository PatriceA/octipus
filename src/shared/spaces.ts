/**
 * Space shapes the server and the web share (docs/SPACES.md). Dependency-free
 * so `web/` imports it as is.
 */

/**
 * What a guest reaches in a space (S6, docs/SPACES.md → Guests): the rooms
 * they may enter, and the folders — path prefixes of the space's files and
 * note slugs — they may read.
 */
export interface GuestScope {
  rooms: string[];
  folders: string[];
}

/** `security.registration`: who may create an account through the sign-in page. */
export type RegistrationMode = 'open' | 'invite_only' | 'closed';

/** `GET /api/auth/registration`. */
export interface RegistrationInfo {
  mode: RegistrationMode;
  /** No account exists yet: the first registration is open whatever the mode. */
  firstAccount: boolean;
}
