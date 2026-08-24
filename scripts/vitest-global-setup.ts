import { readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Remove the temporary data directories the suite leaves behind.
 *
 * Around thirty suites run against an embedded database and create their own
 * `mkdtempSync(join(tmpdir(), 'octipus-…'))` DATA_DIR. Almost none remove it:
 * `afterAll` closes the database and stops there. Each directory is a PGlite
 * instance of roughly 45 MB, so a full run leaks over a gigabyte and a machine
 * that runs the suite repeatedly fills its disk — at which point ~390 of 410
 * files fail at once with errors that look nothing like "no space left",
 * because the failure lands wherever a write happens to be.
 *
 * Fixed here rather than in thirty `afterAll` blocks: one owner, and no way for
 * the next suite to forget.
 *
 * Scope, stated plainly rather than overclaimed: only directories that appear
 * DURING this run are removed, which spares anything already on disk but NOT a
 * second suite running concurrently on the same machine — its directories
 * appear in the same window and are indistinguishable from ours. The suite is
 * run one at a time locally and in an isolated container in CI, so that is
 * acceptable; it would not be if the two ever shared a host.
 */
/**
 * Only directories `mkdtempSync` made: a known prefix followed by exactly the
 * six random characters it appends.
 *
 * A bare prefix match is too broad — `/tmp/octipus-cli` is a FIXED directory
 * the running product creates for its CLI adapters, not a temporary one, so a
 * `npm test` beside a live server would delete adapter HOME directories out
 * from under it.
 */
const MKDTEMP_DIR = /^(?:octipus|octi)-[a-z0-9-]*[A-Za-z0-9]{6}$/;

/** Never removed, whatever else matches. */
const NEVER_REMOVE = new Set(['octipus-cli']);

/** Exported so the rule can be tested without a filesystem. */
export const isSweepable = (name: string): boolean =>
  !NEVER_REMOVE.has(name) && MKDTEMP_DIR.test(name);

const octipusTempDirs = (): Set<string> => {
  const found = new Set<string>();
  try {
    for (const name of readdirSync(tmpdir())) {
      if (isSweepable(name)) found.add(name);
    }
  } catch {
    // An unreadable tmpdir is not worth failing a test run over.
  }
  return found;
};

let preexisting = new Set<string>();

export function setup(): void {
  preexisting = octipusTempDirs();
}

export function teardown(): void {
  let removed = 0;
  for (const name of octipusTempDirs()) {
    if (preexisting.has(name)) continue;
    const path = join(tmpdir(), name);
    try {
      // Only directories, and only ones this run created.
      if (!statSync(path).isDirectory()) continue;
      rmSync(path, { recursive: true, force: true });
      removed++;
    } catch {
      // Best-effort: a directory still held open by a straggling process is
      // not a reason to fail an otherwise green run.
    }
  }
  if (removed > 0) {
    // eslint-disable-next-line no-console
    console.log(`[vitest] removed ${removed} leftover temp data director${removed === 1 ? 'y' : 'ies'}`);
  }
}
