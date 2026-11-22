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

/** One folder's entries for the tree, sorted by name, skipped folders left out. Unreadable entries are left out too. */
export function listFolder(dir: string): FolderEntry[] {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return [];
  }
  const out: FolderEntry[] = [];
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    try {
      out.push({ name, path, isDir: statSync(path).isDirectory() });
    } catch {
      // A dangling symlink or a file removed since readdir: nothing to show.
    }
  }
  return out;
}

export interface ProjectIndex {
  /** Absolute paths. */
  files: string[];
  source: 'git' | 'walk';
  /** True when the index stopped at `MAX_INDEXED_FILES`. */
  truncated: boolean;
}

/** Every file of the project: `git ls-files` in a work tree, a walk otherwise. */
export async function indexProjectFiles(root: string): Promise<ProjectIndex> {
  const fromGit = await gitFiles(root);
  if (fromGit) return fromGit;
  const files: string[] = [];
  const truncated = await walk(root, files);
  files.sort();
  return { files, source: 'walk', truncated };
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
async function walk(root: string, out: string[]): Promise<boolean> {
  let level = [root];
  while (level.length > 0) {
    const next: string[] = [];
    for (const dir of level) {
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const path = join(dir, entry.name);
        let isDir = entry.isDirectory();
        if (entry.isSymbolicLink()) {
          // Follow a link to a file; not to a folder, which could loop.
          try { isDir = (await stat(path)).isDirectory(); if (isDir) continue; } catch { continue; }
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
