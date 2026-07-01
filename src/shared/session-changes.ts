/**
 * Shared, dependency-free contract for the **session changes** surface — the
 * git-backed "what has the agent changed in this workspace" review used by the
 * web Changes tab and the TUI `/changes` command.
 *
 * Mirrors the split already used by `src/shared/work-stream.ts` and
 * `src/shared/diff.ts`: the *types* live here (runtime-import-free, no node
 * built-ins) so the browser bundle and the TUI can import them directly, while
 * the git logic that produces them lives server-side in
 * `src/core/session-changes.ts`.
 *
 * Design note: this deliberately reuses `computeLineDiff` (`src/shared/diff.ts`)
 * on the *client* for rendering — the server ships the raw `{ original, modified }`
 * text pair and the UI computes the visual diff, the same shape OpenHands uses
 * for its git-backed Changes tab. Keeping the diff computation client-side means
 * the endpoint stays a thin, cache-friendly text passthrough.
 */

/**
 * Git change status for a single path, normalized to a small stable set.
 * Mirrors `git diff --name-status` codes plus untracked files:
 *   - `added`     new file staged/committed relative to the base (A)
 *   - `modified`  content changed (M)
 *   - `deleted`   removed (D)
 *   - `renamed`   moved (R) — `path` is the new path
 *   - `untracked` present in the working tree but not tracked by git (`??`)
 */
export type SessionChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';

/** A single changed path in the session's workspace. */
export interface SessionChange {
  /** Workspace-relative path (POSIX separators). */
  path: string;
  status: SessionChangeStatus;
}

/**
 * Result of listing a workspace's changes. `isGitRepo` is false when the
 * workspace root is not itself a git repository — the UI renders an honest
 * "not a git repository" state rather than an empty diff (the same graceful
 * degrade OpenHands does).
 */
export interface SessionChangesResult {
  isGitRepo: boolean;
  /** Empty when `isGitRepo` is false or the working tree is clean. */
  changes: SessionChange[];
  /** Current branch name, when known (informational; omitted for detached/unknown). */
  branch?: string;
}

/**
 * Full before/after text for one changed path. `original` is the base
 * (HEAD) content — empty for an added/untracked file. `modified` is the
 * current working-tree content — empty for a deleted file. The client feeds
 * these to `computeLineDiff` to render the colored diff.
 */
export interface SessionChangeDiff {
  path: string;
  status: SessionChangeStatus;
  original: string;
  modified: string;
  /** True when either side was omitted because it exceeded the size cap. */
  truncated: boolean;
}

/** Max bytes of a single file side we return in a diff before truncating. */
export const SESSION_CHANGE_DIFF_MAX_BYTES = 512 * 1024;

/** Max number of changed files we enumerate in one `changes` listing. */
export const SESSION_CHANGES_MAX_FILES = 500;
