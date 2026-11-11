/**
 * Whether a package may run now, as the check before every start of its
 * server says (`checkPackageBeforeStart`, ./service.ts: its sandbox, its
 * files against the approved hash, a marketplace revocation of its version,
 * a revoked key, its signature), cached for a short while: what a package's
 * pages (./ui.ts) and its page store (src/api/routes/plugin-ui.ts) ask on
 * every request, so a revoked or unapproved package serves no page and no
 * store, as its server does not start.
 *
 * The check hashes the package's files, hence the cache. It is forgotten
 * whenever what it depends on changes here: an install, an upgrade, an
 * approval or an uninstall (each ends in `syncPluginServers`), a revocation
 * recorded or cleared (./revocations.ts). Another instance's change is seen
 * within `RUN_CHECK_TTL_MS`.
 */

/** How long one answer is kept. */
export const RUN_CHECK_TTL_MS = 30_000;

const checked = new Map<string, { problem: string | null; at: number }>();

/** Forget the cached answers (of `name`, or of every package). */
export function forgetRunChecks(name?: string): void {
  if (name === undefined) checked.clear();
  else checked.delete(name);
}

/** Why `name` may not run now, or null (cached for `RUN_CHECK_TTL_MS`). */
export async function packageRunProblem(name: string, now = Date.now()): Promise<string | null> {
  const hit = checked.get(name);
  if (hit && now - hit.at < RUN_CHECK_TTL_MS) return hit.problem;
  const { checkPackageBeforeStart } = await import('./service');
  let problem: string | null;
  try {
    problem = await checkPackageBeforeStart(name);
  } catch (err) {
    problem = `Could not check the package: ${(err as Error).message}`;
  }
  if (checked.size >= 1000) checked.clear();
  checked.set(name, { problem, at: now });
  return problem;
}
