/**
 * Git-backed session changes — the server side of the "what has the agent
 * changed in this workspace" review surfaced by the web Changes tab
 * (`GET /sessions/:id/changes`) and the TUI `/changes` gateway command.
 *
 * The types are in `src/shared/session-changes.ts` (browser/TUI-safe). This
 * module holds the node-only git logic, so it is imported lazily by the route
 * and command handlers.
 *
 * Security: every git invocation goes through `runGit`, which uses
 * `execFile('git', [...args])` — an ARGUMENT VECTOR, never a shell string. No
 * user-controlled value (a file path) is ever interpolated into a command
 * line, so the class of shell-injection bug that hit OpenHands' equivalent
 * handler (GHSA-7h8w-hj9j-8rjw) is impossible here by construction.
 *
 * Containment: we only report changes when the workspace root is *itself* the
 * git repository root. If `root` sits inside a larger repo whose top level is
 * an ancestor directory, we treat it as "not a git repo" rather than leak the
 * parent repo's changes (which could include paths outside the user's
 * workspace). Callers additionally validate the per-file path through
 * `WorkspaceFS.resolve` before calling `getWorkspaceChangeDiff`.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { relative as pathRelative, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {
  SESSION_CHANGE_DIFF_MAX_BYTES,
  SESSION_CHANGES_MAX_FILES,
  type SessionChange,
  type SessionChangeDiff,
  type SessionChangeStatus,
  type SessionChangesResult,
} from '@/shared/session-changes';
import { coreLogger } from '@/utils/logger';

const GIT_TIMEOUT_MS = 10_000;
/** Generous stdout cap for `git show` of a large file (bytes). */
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Run `git` with an argument vector (no shell) inside `cwd`. Never throws for a
 * non-zero exit — expected failures (not a repo, path not in HEAD) are part of
 * normal flow and returned as `{ ok: false }`. Only a spawn-level failure
 * (git missing) rejects, which callers translate into a not-a-repo result.
 */
function runGit(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, encoding: 'utf-8' },
      (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          // git binary not installed — surface as not-a-repo, but log once so a
          // misconfigured host isn't silently degraded (fail-loud spirit).
          coreLogger.warn('git binary not found; session changes unavailable');
          resolve({ ok: false, stdout: '', stderr: 'git not found' });
          return;
        }
        resolve({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
  });
}

/**
 * Resolve the git top level for `root` and confirm it *is* `root` (realpath
 * compared both sides). Returns the canonical repo root, or null when `root`
 * is not a repo or is merely nested inside a parent repo.
 */
async function repoRootFor(root: string): Promise<string | null> {
  // Guard directory existence first: a fresh per-user workspace often doesn't
  // exist on disk yet, and spawning git with a missing cwd throws ENOENT —
  // which would otherwise be misread as "git binary not found".
  if (!existsSync(root)) return null;
  const res = await runGit(root, ['rev-parse', '--show-toplevel']);
  if (!res.ok) return null;
  const topLevel = res.stdout.trim();
  if (!topLevel) return null;
  try {
    const realRoot = await realpath(root);
    const realTop = await realpath(topLevel);
    // The workspace must be the repo root, not a subdirectory of a larger repo.
    // (A parent-repo top level would be an ancestor of the workspace; refuse it
    // so we never expose changes to paths outside the user's workspace.)
    if (realRoot !== realTop) return null;
    return realTop;
  } catch {
    return null;
  }
}

/** Map a `git status --porcelain` XY code to our normalized status. */
function statusFromPorcelain(xy: string): SessionChangeStatus {
  if (xy === '??') return 'untracked';
  // XY: X = index/staged, Y = worktree. Prefer the most meaningful signal.
  if (xy.includes('R')) return 'renamed';
  if (xy.includes('D')) return 'deleted';
  if (xy.includes('A')) return 'added';
  return 'modified';
}

/**
 * List the workspace's changes vs the committed tree. Uses
 * `git status --porcelain` so it works with or without a HEAD commit and
 * includes untracked files in a single call. Returns `{ isGitRepo: false }`
 * when the workspace root is not a git repository.
 */
export async function getWorkspaceChanges(root: string): Promise<SessionChangesResult> {
  const repoRoot = await repoRootFor(root);
  if (!repoRoot) return { isGitRepo: false, changes: [] };

  // `-z`: NUL-separated records with NO C-style quoting. Without it, git
  // quotes any path containing a space or non-ASCII byte (core.quotepath),
  // which we'd otherwise surface verbatim (`"my file.txt"`) and then fail to
  // resolve. `--no-renames` keeps each record to a single path field.
  const status = await runGit(repoRoot, ['status', '--porcelain', '-z', '--no-renames']);
  if (!status.ok) {
    // A repo that exists but whose status errors is an unexpected state — log
    // it rather than pretending the tree is clean.
    coreLogger.warn({ stderr: status.stderr.slice(0, 200) }, 'git status failed for workspace changes');
    return { isGitRepo: true, changes: [] };
  }

  const changes: SessionChange[] = [];
  for (const entry of status.stdout.split('\0')) {
    if (!entry) continue;
    // Each record: 2-char status code, a space, then the exact path (no quoting,
    // no trailing newline — so no `.trim()`, which would corrupt a filename that
    // legitimately has leading/trailing whitespace).
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    if (!path) continue;
    changes.push({ path, status: statusFromPorcelain(xy) });
    if (changes.length >= SESSION_CHANGES_MAX_FILES) break;
  }

  let branch: string | undefined;
  const head = await runGit(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (head.ok) {
    const name = head.stdout.trim();
    if (name && name !== 'HEAD') branch = name;
  }

  return { isGitRepo: true, changes, branch };
}

/** Cap a file side at the byte limit; returns [text, wasTruncated]. */
function capText(text: string): [string, boolean] {
  if (Buffer.byteLength(text, 'utf-8') <= SESSION_CHANGE_DIFF_MAX_BYTES) return [text, false];
  const buf = Buffer.from(text, 'utf-8').subarray(0, SESSION_CHANGE_DIFF_MAX_BYTES);
  // A byte-offset slice can land mid-character. StringDecoder emits only
  // complete UTF-8 characters and holds an incomplete trailing sequence back,
  // rather than decoding it into a U+FFFD replacement char.
  return [new StringDecoder('utf8').write(buf), true];
}

/**
 * Return the before/after text for a single changed path. `absPath` must be an
 * absolute path the caller has already validated to be inside `root` (via
 * `WorkspaceFS.resolve`). `original` is the HEAD content ('' for added/
 * untracked or a repo with no commits); `modified` is the current working-tree
 * content ('' for a deleted file).
 */
export async function getWorkspaceChangeDiff(root: string, absPath: string): Promise<SessionChangeDiff> {
  const repoRoot = await repoRootFor(root);
  const relPath = pathRelative(repoRoot ?? root, absPath).split(sep).join('/');

  // Current working-tree content. `existsSync` first so a missing file (deleted)
  // is an empty `modified` side; a file that exists but can't be read (EACCES,
  // EISDIR, …) is a real error we surface rather than mislabel as "deleted".
  const onDisk = existsSync(absPath);
  let modified = '';
  if (onDisk) {
    try {
      modified = await readFile(absPath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; // fail loud
    }
  }

  // HEAD content + tracked-ness. We ask git whether the path is in HEAD
  // (`cat-file -e`) independently of `show`, so a `show` that fails for a
  // reason OTHER than "not in HEAD" — e.g. a blob larger than maxBuffer — is
  // reported as a truncated *modified* file, not silently mislabeled "added".
  let original = '';
  let inHead = false;
  let showTruncated = false;
  if (repoRoot) {
    const exists = await runGit(repoRoot, ['cat-file', '-e', `HEAD:${relPath}`]);
    inHead = exists.ok;
    if (inHead) {
      const show = await runGit(repoRoot, ['show', `HEAD:${relPath}`]);
      if (show.ok) original = show.stdout;
      else showTruncated = true; // e.g. blob exceeds GIT_MAX_BUFFER
    }
  }

  // Status from git truth (tracked-ness + presence on disk), not from string
  // emptiness — so an empty tracked file isn't called "added" and an edited-to-
  // empty file isn't called "deleted".
  const status: SessionChangeStatus =
    !inHead && onDisk ? 'added' : inHead && !onDisk ? 'deleted' : 'modified';

  const [origCapped, origTrunc] = capText(original);
  const [modCapped, modTrunc] = capText(modified);

  return {
    path: relPath,
    status,
    original: origCapped,
    modified: modCapped,
    truncated: origTrunc || modTrunc || showTruncated,
  };
}
