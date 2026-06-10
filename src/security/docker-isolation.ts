/**
 * Docker isolation — Phase 3f multi-user.
 *
 * The Docker tool today operates on whatever containers the daemon
 * exposes — there's nothing stopping user A's agent from `docker
 * stop`'ing a container created by user B, or from `docker exec`'ing
 * arbitrary commands inside one. When `security.dockerIsolation`
 * is `'enforce'` and `multiuser.enabled` is true, this module's
 * helpers gate every operation on a per-user label.
 *
 * Convention:
 *   - Every container the tool creates carries `octipus.user_id=<uuid>`.
 *   - Every per-user network is named `octipus_user_<short-uuid>`.
 *   - Every list operation filters with `--filter
 *     label=octipus.user_id=<uuid>` so the agent only sees its
 *     owner's containers.
 *   - Every targeted operation (start/stop/logs/exec) first runs
 *     `docker inspect` to verify the label; mismatches are reported
 *     as "container not found" — same shape as a missing container,
 *     so the agent can't enumerate other users' container names by
 *     probing.
 *
 * The helpers don't actually spawn `docker` — they return the right
 * argv fragments and invariants. The Docker tool spawns; this
 * module is the single place that knows the conventions.
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import { getConfig } from '@/config';

const LABEL_KEY = 'octipus.user_id';

/** Whether the per-user isolation should fire for this request. */
export function isolationActive(userId: string | null | undefined): boolean {
  if (!userId || userId === 'system' || userId === 'local') return false;
  try {
    return getConfig().security.dockerIsolation === 'enforce';
  } catch {
    return false;
  }
}

/** `octipus.user_id=<uuid>` label used on every container we create
 *  and as the filter on every container we list. */
export function userLabel(userId: string): string {
  return `${LABEL_KEY}=${userId}`;
}

/**
 * Per-user Docker network. Named after the user's short id (first 8
 * chars) so the daemon's network list stays readable; the full uuid
 * is in the label for unambiguous lookup.
 *
 * Container-to-container connectivity inside Docker is governed by
 * shared network membership. Putting each user's containers in their
 * own bridge network means user A's `nginx` container can't `curl`
 * user B's `redis` container even if they're both running.
 */
export function userNetworkName(userId: string): string {
  // Replace any non-alphanumeric (defense-in-depth — Docker network
  // names allow alphanumeric + a few separators).
  const safe = userId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
  return `octipus_user_${safe}`;
}

/** Run `docker` and return stdout/stderr/exit. Internal — kept here
 *  so `docker-isolation` is the single owner of `docker inspect`
 *  invocations, and tests can stub via `mock.module` if needed. */
function runDocker(args: string[], timeoutMs = 5000): Promise<{
  stdout: string; stderr: string; exitCode: number;
}> {
  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try { child = spawn('docker', args, { timeout: timeoutMs }); }
    catch { resolve({ stdout: '', stderr: 'docker not found', exitCode: 127 }); return; }
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => resolve({ stdout, stderr: stderr + e.message, exitCode: 1 }));
    child.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
  });
}

/**
 * Read a container's labels via `docker inspect` and assert it
 * carries `octipus.user_id=<expectedUserId>`. Throws when the
 * container exists but is owned by a different user — the route
 * layer surfaces this as "container not found" so attackers can't
 * enumerate names by probing.
 *
 * Returns `'ok'` when the label matches, `'not_found'` when docker
 * inspect failed (container doesn't exist OR isn't visible to this
 * caller), or `'wrong_owner'` when it exists but the label is
 * different / missing.
 */
export async function inspectOwnership(
  containerNameOrId: string,
  expectedUserId: string,
): Promise<'ok' | 'not_found' | 'wrong_owner'> {
  // -f only returns the requested format; non-zero exit means
  // container doesn't exist.
  const { stdout, exitCode } = await runDocker([
    'inspect', '-f', `{{ index .Config.Labels "${LABEL_KEY}" }}`, containerNameOrId,
  ]);
  if (exitCode !== 0) return 'not_found';
  const labelValue = stdout.trim();
  if (!labelValue) return 'wrong_owner';
  if (labelValue !== expectedUserId) return 'wrong_owner';
  return 'ok';
}

/**
 * Idempotently create the per-user bridge network. Safe to call on
 * every operation — `docker network create` returns an error when
 * the network already exists, which we swallow.
 *
 * Returns the network name regardless. The caller passes it to
 * `docker run --network <name>`.
 */
export async function ensureUserNetwork(userId: string): Promise<string> {
  const name = userNetworkName(userId);
  // `docker network create` is idempotent enough for our purposes:
  // a duplicate-name error is harmless. We don't bother probing
  // first — that's two roundtrips for the cost of one.
  await runDocker(['network', 'create', '--driver', 'bridge', name]);
  return name;
}

/**
 * Build the additional argv flags to inject into a `docker run` /
 * `docker create` call so the new container is bound to the user's
 * label + network. Returns an empty array when isolation is off.
 *
 * The Docker tool today doesn't have a `run_container` op (only
 * start/stop/logs/exec/build). The flag set is exposed here for
 * the future op + for `docker build --label` injection.
 */
export function runIsolationFlags(userId: string): string[] {
  if (!isolationActive(userId)) return [];
  return [
    '--label', userLabel(userId),
    '--network', userNetworkName(userId),
  ];
}

/** Same shape, but the build subcommand only takes `--label`
 *  (networks aren't a thing for image builds). */
export function buildIsolationFlags(userId: string): string[] {
  if (!isolationActive(userId)) return [];
  return ['--label', userLabel(userId)];
}

/** The argv fragment for `docker ps`-style filtering. */
export function listFilterFlags(userId: string): string[] {
  if (!isolationActive(userId)) return [];
  return ['--filter', `label=${userLabel(userId)}`];
}

/** Re-export for callers that want to read the constant directly. */
export const USER_LABEL_KEY = LABEL_KEY;
