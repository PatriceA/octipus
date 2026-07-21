/**
 * Bun test preload — reaps the per-test PGlite/`DATA_DIR` scratch directories
 * that ~100 test files create with `mkdtempSync(join(tmpdir(), 'octipus-…'))`
 * and never remove. Left alone they accumulate at ~140 dirs (~40 MB each) per
 * `bun test src scripts` run and, on a `tmpfs`-backed `/tmp`, fill the whole
 * mount within days (observed: 1 852 dirs / 39.6 GB, `/tmp` at 100%).
 *
 * Wired via `bunfig.toml` `[test].preload`, so it runs once per test process
 * before any test file. Two sweeps of `tmpdir()/octipus-*`:
 *   • at load   — abandoned dirs from prior crashed/killed runs (>2 h idle;
 *                 a healthy run cleans its own at the end, so nothing that old
 *                 is still owned by a live run).
 *   • after all — everything this run created (activity within the run window).
 *                 Registered via a top-level `afterAll` from `bun:test`, which
 *                 Bun fires exactly once after the whole run. `process.on(
 *                 'exit'|'beforeExit')` do NOT fire under Bun's test runner
 *                 (verified), so an exit hook would silently leak.
 *
 * Why a timestamp window and not per-dir tracking: Bun exposes `node:fs`
 * methods as readonly, so `mkdtempSync` cannot be wrapped to record exact
 * paths. We compare the max of (birthtime, ctime, mtime) so an unreliable
 * `birthtime` (0 on some filesystems) can never make a fresh dir look old.
 *
 * ponytail: window sweep, not precise tracking. Ceiling — if a *separate*
 * octipus process (e.g. a dev server on this box) writes a `/tmp/octipus-*`
 * scratch dir during a test run, the after-all sweep could remove it too.
 * Benign in practice: the server regenerates its `/tmp` scratch (per-spawn MCP
 * config) on demand, and CI runs no server. Upgrade path — a shared
 * `makeTestTmpDir()` helper the tests call, tracked and removed precisely.
 */
import { afterAll } from 'bun:test';
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

const LOAD = Date.now();
const TMP = tmpdir();

// Reap abandoned leftovers from prior crashed/killed runs (idle > 2h).
reap(TMP, (last) => last < LOAD - STALE_MS);

// Clean everything this run created, once every test file has finished.
afterAll(() => {
  reap(TMP, (last) => last >= LOAD);
});

/**
 * Second leak, same shape: Bun's lcov writer leaves a
 * `coverage/.lcov.info.<hash>.tmp` behind on every run and never reaps them
 * (observed: 175 files / 30 MB in one week). Swept at load, not in `afterAll`,
 * because the writer finalises *after* the last hook — at preload every `.tmp`
 * present is necessarily from an earlier run, so no timestamp window is needed.
 *
 * ponytail: unconditional sweep. Ceiling — a second `bun test` running
 * concurrently against this same checkout would lose its in-flight `.tmp`
 * files. Upgrade path: reuse the `LOAD`-window predicate above if that ever
 * becomes a real workflow.
 */
export function reapCoverageTmp(dir: string): number {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0; // no coverage dir yet — nothing to do
  }
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith('.lcov.info.') || !name.endsWith('.tmp')) continue;
    try {
      rmSync(join(dir, name), { force: true });
      removed++;
    } catch {
      // best effort — same as above
    }
  }
  return removed;
}

reapCoverageTmp(join(import.meta.dir, '..', '..', 'coverage'));
