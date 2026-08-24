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
 * the next suite to forget. Only directories that appear DURING the run are
 * removed, so a concurrent run's data is left alone.
 */
const PREFIXES = ['octipus-', 'octi-'];

const octipusTempDirs = (): Set<string> => {
  const found = new Set<string>();
  try {
    for (const name of readdirSync(tmpdir())) {
      if (PREFIXES.some((p) => name.startsWith(p))) found.add(name);
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
