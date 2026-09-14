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
import { execFile, spawnSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { coreLogger } from './logger';

/**
 * OWNER RIGHTS — the well-known SID S-1-3-4, which names whoever owns the file.
 *
 * Deliberately not `%USERDOMAIN%\%USERNAME%`. Those are ordinary environment
 * variables, so a parent process picks them, and deciding who may read a bearer
 * token is this function's entire job: aimed at another principal it would strip
 * every inherited entry and hand that principal full control, then report
 * success. The owner is the account that created the file — a fact about the
 * filesystem, not about the environment — and `icacls` resolves the SID without
 * consulting either.
 */
const OWNER_RIGHTS_SID = '*S-1-3-4';

/**
 * Make `path` readable and writable by its owner only.
 *
 * Best effort, and says so when it fails: a filesystem that cannot express the
 * restriction (a FAT volume, a network share) must not take the write down with
 * it — the caller has already decided the data is worth storing. A failure is
 * logged at warn rather than swallowed, because "the token file is user-only"
 * is a claim this function is the only evidence for.
 */
/**
 * The same restriction, off the event loop.
 *
 * On Windows `restrictToOwner` is two `spawnSync` calls, and a process spawn is
 * tens of milliseconds. In a synchronous writer that is the correct trade — the
 * permission must land with the bytes — but the tool-output spill path is async
 * throughout precisely so a large write does not stall every other request, and
 * blocking it to set an ACL gives that back.
 */
export function restrictToOwnerAsync(path: string, kind: 'file' | 'directory' = 'file'): Promise<boolean> {
  if (process.platform !== 'win32') return Promise.resolve(restrictToOwner(path, kind));
  const permission = kind === 'directory' ? '(OI)(CI)(F)' : '(F)';
  return new Promise((done) => {
    execFile(
      'icacls',
      [path, '/inheritance:r', '/grant:r', `${OWNER_RIGHTS_SID}:${permission}`],
      { windowsHide: true },
      (err) => {
        if (err) coreLogger.warn({ path, err }, 'icacls could not restrict the file to its owner');
        done(!err);
      },
    );
  });
}

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

  // `(OI)(CI)` on a directory so new children inherit the same single entry;
  // a file takes no inheritance flags. `/grant:r` REPLACES any existing grant
  // for the account rather than adding to it, and `/inheritance:r` drops the
  // entries the parent handed down — without that the grant is additive and
  // Users keeps whatever it had.
  const permission = kind === 'directory' ? '(OI)(CI)(F)' : '(F)';
  const result = spawnSync(
    'icacls',
    [path, '/inheritance:r', '/grant:r', `${OWNER_RIGHTS_SID}:${permission}`],
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
