/**
 * Reaps the per-test PGlite/`DATA_DIR` scratch directories that ~100 test files
 * create with `mkdtempSync(join(tmpdir(), 'octipus-…'))` and never remove. Left
 * alone they accumulate at ~140 dirs (~40 MB each) per run and, on a
 * `tmpfs`-backed `/tmp`, fill the whole mount within days (observed: 1 852 dirs
 * / 39.6 GB, `/tmp` at 100%).
 *
 * Wired as the runner's **global setup**, which is the part that matters: the
 * sweep of "everything this run created" must happen once, after the last file,
 * not once per file. Registered per-file it deletes the scratch directories of
 * every sibling worker still running — which is exactly what it did on the
 * first run after the runner changed, and what the document-processor suite
 * failed on with ENOENT on a file it had just written.
 *
 * Two sweeps of `tmpdir()/octipus-*`:
 *   • at setup    — abandoned dirs from prior crashed/killed runs (>2 h idle;
 *                   a healthy run cleans its own at the end, so nothing that
 *                   old is still owned by a live run).
 *   • at teardown — everything this run created (activity within the window).
 *
 * Why a timestamp window and not per-dir tracking: the tests call `mkdtempSync`
 * directly, so there is no single place to record exact paths. We compare the
 * max of (birthtime, ctime, mtime) so an unreliable `birthtime` (0 on some
 * filesystems) can never make a fresh dir look old.
 *
 * ponytail: window sweep, not precise tracking. Ceiling — if a *separate*
 * octipus process (e.g. a dev server on this box) writes a `/tmp/octipus-*`
 * scratch dir during a test run, the teardown sweep could remove it too.
 * Benign in practice: the server regenerates its `/tmp` scratch (per-spawn MCP
 * config) on demand, and CI runs no server. Upgrade path — a shared
 * `makeTestTmpDir()` helper the tests call, tracked and removed precisely.
 */
import { readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const SCRATCH_PREFIX = 'octipus-';
const STALE_MS = 2 * 60 * 60 * 1000; // 2h

/**
 * Pure selection: given the entries in a dir and a way to read each one's
 * last-activity time, return the `octipus-*` names a sweep should remove.
 * `remove(lastMs)` decides per candidate; entries whose time can't be read
 * (`lastOf` returns null) are skipped — never removed on missing data.
 */
export function selectReap(
  names: string[],
  lastOf: (name: string) => number | null,
  remove: (lastMs: number) => boolean,
): string[] {
  const out: string[] = [];
  for (const name of names) {
    if (!name.startsWith(SCRATCH_PREFIX)) continue;
    const last = lastOf(name);
    if (last == null) continue;
    if (remove(last)) out.push(name);
  }
  return out;
}

/** Most-recent timestamp on a dir; null if it isn't a readable directory. */
function lastActivityMs(path: string): number | null {
  try {
    const st = statSync(path);
    if (!st.isDirectory()) return null;
    return Math.max(st.birthtimeMs || 0, st.ctimeMs || 0, st.mtimeMs || 0);
  } catch {
    return null; // vanished / racing — nothing to do
  }
}

/** Remove the selected `octipus-*` dirs under `dir`; returns the count removed. */
function reap(dir: string, remove: (lastMs: number) => boolean): number {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of selectReap(names, (n) => lastActivityMs(join(dir, n)), remove)) {
    try {
      rmSync(join(dir, name), { recursive: true, force: true });
      removed++;
    } catch {
      // best effort — another process may hold it; leave it be
    }
  }
  return removed;
}

const TMP = tmpdir();

/**
 * Vitest global setup. Returns the teardown, which the runner calls once after
 * every project and every file has finished.
 */
export default function setup(): () => void {
  const load = Date.now();
  // Abandoned leftovers from prior crashed or killed runs (idle > 2h).
  reap(TMP, (last) => last < load - STALE_MS);
  return () => {
    reap(TMP, (last) => last >= load);
  };
}
