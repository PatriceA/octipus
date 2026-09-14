/**
 * Restrict a file or directory to the account that owns it.
 *
 * Everywhere this is called, the thing being written is a secret or a private
 * working file: the CLI session bearer token, the CocoIndex settings that hold
 * an embedding endpoint, a spilled tool output, an editor draft. The codebase
 * expressed that as `chmod 0600` — which on Windows sets nothing. Node's
 * `chmod` there toggles the read-only flag and nothing else, so `stat().mode`
 * comes back `0o666` no matter what was asked for, and every one of those files
 * was left with whatever the parent directory's ACL happened to be.
 *
 * `icacls` is the Windows equivalent and the same tool OpenSSH tells people to
 * use on a private key: drop inherited entries, then grant full control to one
 * account and nobody else. SYSTEM and Administrators lose their inherited
 * access too. That is deliberate — an administrator can still take ownership,
 * so nothing is actually prevented, but a backup agent or another account's
 * process no longer reads the file by default.
 *
 * Synchronous on purpose: the callers are, two of them are in a `writeFileSync`
 * path, and a permission that lands a tick after the bytes is a window.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { coreLogger } from './logger';

/**
 * `DOMAIN\user`, or `user` when the machine is not domain-joined.
 *
 * `USERNAME` alone is ambiguous on a domain — a local and a domain account can
 * share it — and `icacls` resolves the qualified form unambiguously.
 */
function ownerAccount(): string | null {
  const user = process.env.USERNAME;
  if (!user) return null;
  const domain = process.env.USERDOMAIN;
  return domain ? `${domain}\\${user}` : user;
}

/**
 * Make `path` readable and writable by its owner only.
 *
 * Best effort, and says so when it fails: a filesystem that cannot express the
 * restriction (a FAT volume, a network share) must not take the write down with
 * it — the caller has already decided the data is worth storing. A failure is
 * logged at warn rather than swallowed, because "the token file is user-only"
 * is a claim this function is the only evidence for.
 */
export function restrictToOwner(path: string, kind: 'file' | 'directory' = 'file'): boolean {
  if (process.platform !== 'win32') {
    try {
      chmodSync(path, kind === 'directory' ? 0o700 : 0o600);
      return true;
    } catch (err) {
      coreLogger.warn({ err, path }, 'Could not restrict file to its owner');
      return false;
    }
  }

  const account = ownerAccount();
  if (!account) {
    coreLogger.warn({ path }, 'Could not restrict file to its owner: USERNAME is not set');
    return false;
  }
  // `(OI)(CI)` on a directory so new children inherit the same single entry;
  // a file takes no inheritance flags. `/grant:r` REPLACES any existing grant
  // for the account rather than adding to it, and `/inheritance:r` drops the
  // entries the parent handed down — without that the grant is additive and
  // Users keeps whatever it had.
  const permission = kind === 'directory' ? '(OI)(CI)(F)' : '(F)';
  const result = spawnSync(
    'icacls',
    [path, '/inheritance:r', '/grant:r', `${account}:${permission}`],
    { stdio: 'ignore', windowsHide: true },
  );
  if (result.error || result.status !== 0) {
    coreLogger.warn(
      { path, status: result.status, err: result.error },
      'icacls could not restrict the file to its owner',
    );
    return false;
  }
  return true;
}
