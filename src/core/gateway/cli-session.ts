/**
 * The signed-in user for local CLI clients (TUI, editor).
 *
 * Without one, a terminal client authenticates with `~/.octipus/local-token`
 * and the gateway hands it the synthetic `'local'` principal: it is nobody's
 * account, so it reads none of your memories, none of your user-scoped vault
 * secrets, and none of the settings you changed in the web UI. Storing a real
 * session token here makes the terminal the same principal as the browser.
 *
 * The file holds a bearer token — same power as the browser's session cookie —
 * so it is written 0600 and never logged.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const OCTIPUS_DIR = join(homedir(), '.octipus');
const SESSION_FILE = join(OCTIPUS_DIR, 'session.json');

export interface CliSession {
  token: string;
  userId: string;
  username: string;
  isAdmin: boolean;
  /** ISO timestamp. Absent on a server that didn't report one. */
  expiresAt?: string;
}

/** Where the session file lives — surfaced so `/whoami` can name it. */
export const CLI_SESSION_PATH = SESSION_FILE;

/**
 * The stored session, or null when there is none, it is unreadable, or it has
 * already expired. An expired token is treated as absent rather than handed to
 * the gateway for a guaranteed rejection.
 */
export function readCliSession(): CliSession | null {
  try {
    if (!existsSync(SESSION_FILE)) return null;
    const parsed = JSON.parse(readFileSync(SESSION_FILE, 'utf-8')) as Partial<CliSession>;
    if (!parsed?.token || !parsed.userId || !parsed.username) return null;
    if (parsed.expiresAt && Date.parse(parsed.expiresAt) <= Date.now()) return null;
    return {
      token: parsed.token,
      userId: parsed.userId,
      username: parsed.username,
      isAdmin: parsed.isAdmin === true,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

export function writeCliSession(session: CliSession): void {
  if (!existsSync(OCTIPUS_DIR)) mkdirSync(OCTIPUS_DIR, { recursive: true });
  writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2), { mode: 0o600 });
  // `mode` applies only when the file is created — a re-login over an existing
  // file would otherwise keep whatever permissions it already had.
  chmodSync(SESSION_FILE, 0o600);
}

/** Remove the stored session. Safe to call when there isn't one. */
export function clearCliSession(): void {
  try {
    rmSync(SESSION_FILE, { force: true });
  } catch {
    /* nothing to clear */
  }
}
