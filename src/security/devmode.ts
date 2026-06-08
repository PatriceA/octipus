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
 * Policy: honor request-supplied devMode/projectPath only when multiuser is
 * OFF (single-user install — the caller IS the operator), or when the caller
 * is an admin. Otherwise the ingestion sites drop devMode + projectPath so it
 * never reaches session context, and every downstream consumer is safe by
 * construction.
 */
import { getConfig } from '@/config';
import { securityLogger } from '@/utils/logger';

export function devModeAllowed(isAdmin: boolean): boolean {
  let multiuser = false;
  try {
    multiuser = !!getConfig().multiuser?.enabled;
  } catch (err) {
    // `getConfig` throws when config isn't loaded yet (early boot / unit
    // harness) or on a validation failure after a hot-reload. We treat that
    // as single-user rather than crash the handler — but a security gate
    // resolving its own input by exception must not do so silently (house
    // rule: fail loud / log the reason). A hot-reload failure here means
    // devMode falls open to single-user semantics, so make it visible.
    securityLogger.warn({ err }, 'devModeAllowed: config unavailable, treating as single-user');
  }
  return !multiuser || isAdmin;
}
