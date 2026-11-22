/**
 * The project's files, for the tree (one folder at a time) and the file
 * picker (all of them).
 *
 * The picker's index comes from `git ls-files` when the project is a git
 * work tree — tracked and untracked files, without what `.gitignore`
 * excludes — and from a walk of the folder otherwise. Either way it is
 * built asynchronously, so opening the picker in a large repository does
 * not freeze the editor, and it is not cut to the first N names: the
 * picker ranks the whole index against what is typed.
 *
 * The walk and the tree skip the same folders (`SKIP_DIRS`).
 */
import { execFile } from 'node:child_process';
import { readdirSync, statSync, type Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Folders neither the tree nor the walk descends into. */
export const SKIP_DIRS: ReadonlySet<string> = new Set(['.git', 'node_modules', 'dist', 'build', '.octipus', '.next', '.cache']);

/** The index stops here, and says so: past this a fuzzy filter is no longer instant. */
export const MAX_INDEXED_FILES = 200_000;

export interface FolderEntry { name: string; path: string; isDir: boolean }

/** A folder's entries, or why it could not be read (`error`, with the entries empty). */
export interface FolderListing { entries: FolderEntry[]; error: string | null }

/** The `code` of a Node system error, or null. */
export function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const code = (error as { code: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/** Why a file or folder could not be read, as the editor says it. */
export function fsReason(error: unknown): string {
  const code = errorCode(error);
  if (code === 'EACCES' || code === 'EPERM') return 'permission denied';
  return error instanceof Error ? error.message : String(error);
}

/** Gone, or never a folder: what a listing finds when the file system changed under it. */
const GONE = new Set(['ENOENT', 'ENOTDIR']);
/** A symlink to nothing (or to itself): not an entry to show. */
const DANGLING = new Set(['ENOENT', 'ELOOP']);

/**
 * One folder's entries for the tree, sorted by name, skipped folders left
 * out. A folder that is gone lists nothing; one that cannot be read says
 * why. A dangling symlink is left out; an entry that cannot be examined for
 * another reason is shown as a file, and opening it reports the reason.
 */
export function listFolder(dir: string): FolderListing {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch (error) {
    if (GONE.has(errorCode(error) ?? '')) return { entries: [], error: null };
    return { entries: [], error: `cannot read this folder: ${fsReason(error)}` };
  }
  const out: FolderEntry[] = [];
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(path).isDirectory();
    } catch (error) {
      if (DANGLING.has(errorCode(error) ?? '')) continue;
    }
    out.push({ name, path, isDir });
  }
  return { entries: out, error: null };
}

export interface ProjectIndex {
  /** Absolute paths. */
  files: string[];
  source: 'git' | 'walk';
  /** True when the index stopped at `MAX_INDEXED_FILES`. */
  truncated: boolean;
  /** Folders (and linked files) the walk could not read, so their files are missing from the index. */
  unreadable?: readonly string[];
}

/** Every file of the project: `git ls-files` in a work tree, a walk otherwise. */
export async function indexProjectFiles(root: string): Promise<ProjectIndex> {
  const fromGit = await gitFiles(root);
  if (fromGit) return fromGit;
  const files: string[] = [];
  const unreadable: string[] = [];
  const truncated = await walk(root, files, unreadable);
  files.sort();
  return { files, source: 'walk', truncated, unreadable };
}

async function gitFiles(root: string): Promise<ProjectIndex | null> {
  const run = (args: string[]) => new Promise<string | null>((resolve) => {
    execFile('git', args, { cwd: root, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => resolve(error ? null : stdout));
  });
  // Not a work tree, or git is not installed: the caller walks instead.
  if ((await run(['rev-parse', '--is-inside-work-tree']))?.trim() !== 'true') return null;
  const listed = await run(['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  if (listed === null) return null;
  const deleted = new Set((await run(['ls-files', '-z', '--deleted']) ?? '').split('\0'));
  const names = [...new Set(listed.split('\0'))].filter((name) => name && !deleted.has(name)).sort();
  const truncated = names.length > MAX_INDEXED_FILES;
  return { files: names.slice(0, MAX_INDEXED_FILES).map((name) => join(root, name)), source: 'git', truncated };
}

/** Breadth-first so a capped index holds the shallow files; returns whether it stopped at the cap. */
async function walk(root: string, out: string[], unreadable: string[]): Promise<boolean> {
  let level = [root];
  while (level.length > 0) {
    const next: string[] = [];
    for (const dir of level) {
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        // Removed since it was listed: nothing to index. Anything else is reported with the index.
        if (!GONE.has(errorCode(error) ?? '')) unreadable.push(dir);
        continue;
      }
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const path = join(dir, entry.name);
        let isDir = entry.isDirectory();
        if (entry.isSymbolicLink()) {
          // Follow a link to a file; not to a folder, which could loop.
          try {
            isDir = (await stat(path)).isDirectory();
            if (isDir) continue;
          } catch (error) {
            if (!DANGLING.has(errorCode(error) ?? '')) unreadable.push(path);
            continue;
          }
        }
        if (isDir) next.push(path);
        else {
          out.push(path);
          if (out.length >= MAX_INDEXED_FILES) return true;
        }
      }
    }
    level = next;
  }
  return false;
}
