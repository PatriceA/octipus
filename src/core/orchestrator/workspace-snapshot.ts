import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { coreLogger } from '@/utils/logger';

/**
 * Workspace snapshots — the file-level evidence a pipeline stage leaves behind,
 * measured from the filesystem rather than from what the worker's tool counters
 * happened to see.
 *
 * Why this exists: the evidence gate used to read `SideEffectCounters.filesChanged`
 * alone, which counts only `FILE_CHANGE_TOOLS` (`filesystem__write_file` and
 * friends). A worker that writes through `shell__run` — a heredoc, `sed -i`,
 * `python -c`, a code generator — changes real files while that counter stays 0,
 * and the gate failed the stage for "changed 0 files".
 *
 * That was measured, not theorised: on 2026-08-03 a `Bug Fix` pipeline failed its
 * `Implement Fix` stage for changing 0 files, while both target files were
 * rewritten inside that stage's window and its test suite grew from 18 to 21
 * passing tests. The gate was reading the wrong evidence.
 *
 * A snapshot is `relative path → "<mtimeMs>:<size>"` for every regular file under
 * the root. Diffing two of them counts creations, rewrites and deletions, and is
 * blind to which tool did the writing — which is the whole point.
 *
 * Deliberate limits, each of which makes the snapshot report LESS change rather
 * than more, so the gate can never pass a stage on a snapshot artefact:
 *
 * - `node_modules` and `.git` are pruned. Both are enormous and neither is ever
 *   the hand-authored artifact a stage declares.
 * - A tree over `maxFiles` is `truncated`, and a truncated snapshot is not
 *   trusted: the traversal cut-off shifts as files appear, which would
 *   manufacture differences that no stage caused.
 * - A directory that cannot be read marks the snapshot truncated for the same
 *   reason — a partial view cannot tell "absent" from "unreadable".
 *
 * Concurrency caveat, shared with every other signal here: two pipelines running
 * against one workspace see each other's writes. The counters have the mirror
 * problem (they see only their own worker and miss its children's shell writes),
 * which is exactly why the gate reads both and requires only one to show work.
 */

/** Directories never worth walking: huge, and never a stage's declared artifact. */
const PRUNED_DIRS = new Set(['node_modules', '.git']);

/** Above this, the tree is too big to diff reliably — see `truncated`. */
const SNAPSHOT_MAX_FILES = 20_000;

export interface WorkspaceSnapshot {
  /** Relative path → `"<mtimeMs>:<size>"`. */
  files: Map<string, string>;
  /**
   * True when the walk did not see the whole tree (file cap hit, or a directory
   * could not be read). A truncated snapshot must not be diffed — callers treat
   * it as "no filesystem evidence available" and fall back to the counters.
   */
  truncated: boolean;
}

/**
 * Walk `root` and record every regular file's mtime and size.
 *
 * A root that does not exist yet is an EMPTY snapshot, not a failure: nothing
 * was there, so everything the stage goes on to write counts as a change.
 * Returns `null` only when the root exists but cannot be read at all, which is
 * the one case where we genuinely know nothing.
 */
export async function snapshotWorkspace(
  root: string,
  maxFiles: number = SNAPSHOT_MAX_FILES,
): Promise<WorkspaceSnapshot | null> {
  const files = new Map<string, string>();
  let truncated = false;

  const walk = async (dir: string): Promise<void> => {
    if (truncated) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // The root itself being absent is handled by the caller below; a missing
      // subdirectory mid-walk means it was removed under us, which IS a change
      // and is caught by the parent's own listing.
      if (code === 'ENOENT') return;
      truncated = true;
      return;
    }
    // Sorted so two walks of an unchanged tree visit files in the same order —
    // without it, the file cap would truncate at a different point each time.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      if (truncated) return;
      if (entry.isDirectory()) {
        if (PRUNED_DIRS.has(entry.name)) continue;
        await walk(join(dir, entry.name));
        continue;
      }
      // Symlinks are skipped rather than followed: a link's own mtime says
      // nothing about the file a stage wrote, and following them can leave the
      // workspace entirely or loop.
      if (!entry.isFile()) continue;

      if (files.size >= maxFiles) {
        truncated = true;
        return;
      }
      const full = join(dir, entry.name);
      try {
        const s = await stat(full);
        files.set(relative(root, full), `${s.mtimeMs}:${s.size}`);
      } catch {
        // Vanished between listing and stat — a change in its own right, and
        // the other side of the diff will show it.
      }
    }
  };

  try {
    await readdir(root);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { files, truncated: false };
    coreLogger.warn({ err: (err as Error).message, root }, 'Workspace snapshot: root unreadable');
    return null;
  }

  await walk(root);
  return { files, truncated };
}

/**
 * How many files differ between two snapshots — created, rewritten or deleted.
 *
 * Returns `null` when the comparison cannot be trusted: either snapshot missing
 * or truncated. `null` means "no filesystem evidence", never "no changes"; the
 * caller must not read it as a pass or a fail.
 */
export function countChangedFiles(
  before: WorkspaceSnapshot | null,
  after: WorkspaceSnapshot | null,
): number | null {
  if (!before || !after || before.truncated || after.truncated) return null;

  let changed = 0;
  for (const [path, stamp] of after.files) {
    if (before.files.get(path) !== stamp) changed++;
  }
  for (const path of before.files.keys()) {
    if (!after.files.has(path)) changed++;
  }
  return changed;
}
