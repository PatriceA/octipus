/**
 * devMode authorization policy.
 *
 * devMode points the agent's filesystem tools and the CLI worker at an
 * arbitrary host path supplied by the caller (`projectPath`). That is the
 * intended "open my repo" behavior for a single-user / local self-hosted
 * install — but on a shared multiuser instance it is a full filesystem
 * sandbox escape: any authenticated user could send
 * `{ devMode: true, projectPath: '/etc' }` (or another tenant's directory)
 * and have the agent read/write there, because `projectPath` is granted as
 * an extra-allowed prefix to the filesystem tool and as the CLI worker cwd.
 *
 * Policy, in two independent gates:
 *   1. Caller must be an admin (the operator). Non-admin requests have devMode
 *      + projectPath dropped at the ingestion sites, so the flag never reaches
 *      session context.
 *   2. The path itself must be a plausible project directory. Admin-ness says
 *      the caller is trusted; it does NOT say the path is sane. A typo or a
 *      pasted `/etc` from an admin used to be honored verbatim — the very
 *      scenario this file's threat model names.
 */

import { realpathSync, statSync } from 'fs';
import { resolve } from 'path';

/**
 * Directories that are never a project root. Matched as path prefixes after
 * symlink resolution, so `/etc` also covers `/etc/anything` and a symlink
 * pointing at either.
 *
 * Deliberately a denylist, not an allowlist: this is a local-operator feature
 * and an allowlist would break the ordinary "open any repo on my disk" case.
 * It catches the accident and the obvious escape, not a determined admin — who
 * already has shell on the host anyway.
 */
const FORBIDDEN_PROJECT_PREFIXES = [
  '/etc',
  '/proc',
  '/sys',
  '/dev',
  '/boot',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/usr',
  '/var',
  '/root',
];

export interface DevModePathCheck {
  ok: boolean;
  /** Present when `ok` is false — safe to log, no secrets. */
  reason?: string;
}

/**
 * Is this path usable as a devMode project root? Exported separately so the
 * ingestion sites can log *why* a path was rejected.
 */
export function checkProjectPath(projectPath: string): DevModePathCheck {
  const trimmed = projectPath.trim();
  if (!trimmed) return { ok: false, reason: 'empty path' };
  if (!trimmed.startsWith('/')) {
    return { ok: false, reason: 'must be an absolute path' };
  }

  // Dereference symlinks BEFORE the denylist. `resolve()` is purely lexical —
  // it collapses `..` but does NOT follow links — so checking it alone would
  // let a symlink pointing at /etc sail straight through the prefix match.
  // realpathSync also doubles as the existence check.
  let real: string;
  try {
    real = realpathSync(resolve(trimmed));
  } catch (err) {
    // Distinguish "not there" from "there but unreadable" — an admin debugging
    // a silently-ignored devMode otherwise hunts for a typo when the real
    // problem is permissions.
    const code = (err as NodeJS.ErrnoException).code;
    return {
      ok: false,
      reason: code === 'ENOENT' ? 'path does not exist' : `path is not resolvable (${code ?? 'unknown error'})`,
    };
  }

  if (real === '/') return { ok: false, reason: 'filesystem root is not a project' };

  const forbidden = FORBIDDEN_PROJECT_PREFIXES.find(
    (p) => real === p || real.startsWith(`${p}/`),
  );
  if (forbidden) {
    return { ok: false, reason: `system directory (${forbidden}) is not a valid project root` };
  }

  // Directory-ness. `existsSync` alone would happily pass a plain file, which
  // then becomes the agent's cwd and fails obscurely much later.
  try {
    if (!statSync(real).isDirectory()) {
      return { ok: false, reason: 'path exists but is not a directory' };
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { ok: false, reason: `path is not readable (${code ?? 'unknown error'})` };
  }

  return { ok: true };
}

/**
 * Full devMode gate: trusted caller AND a sane path.
 *
 * `projectPath` is optional so a caller that only sets `devMode` (no path) is
 * still gated on admin-ness alone — there is nothing to validate in that case.
 */
export function devModeAllowed(isAdmin: boolean, projectPath?: string): boolean {
  if (!isAdmin) return false;
  if (projectPath === undefined) return true;
  return checkProjectPath(projectPath).ok;
}
