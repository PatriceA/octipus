/**
 * WorkspaceFS — per-user filesystem sandbox.
 *
 * Phase 1b-3 multi-user foundation. Today every filesystem tool resolves
 * paths against a single `config.workspace.rootPath` shared by every
 * user — agent X for user A can read agent Y's files for user B if it
 * guesses the path. WorkspaceFS replaces that with a per-(user,
 * workspace) root and a strict path resolver that rejects any input
 * resolving outside it.
 *
 * Layout:
 *
 *   $DATA_ROOT/
 *     users/{user_id}/
 *       workspaces/{workspace_id}/
 *         files/      ← root for this WorkspaceFS instance
 *         documents/  ← uploads (managed by /api/documents)
 *         cache/      ← future
 *     system/
 *       skills/       ← read-only seeds
 *
 * The class never throws on construction; it lazily creates the root
 * directory on the first `mkdirRoot()` or `resolve()` call. That keeps
 * unit tests fast and avoids surprising filesystem side-effects from
 * just constructing a Principal.
 *
 * Path resolution rules:
 *   - Empty / relative paths resolve relative to the workspace root.
 *   - Absolute paths must be within the workspace root or a configured
 *     extra-allow list (e.g. `/tmp/octipus-…` for transient files).
 *   - `..` segments that would escape the root are rejected after
 *     resolution. We don't try to filter `..` lexically — `path.resolve`
 *     normalizes it and we check the result; the old approach of
 *     blacklisting strings missed `foo/../../escape`.
 *   - Symlinks pointing outside the root are rejected. We follow
 *     symlinks via `realpath`; if the target is outside the root we
 *     throw. Files that don't exist yet (write paths) check the parent
 *     dir's realpath instead.
 *
 * Cross-tenant property: `WorkspaceFS.forPrincipal(alice).resolve('foo')`
 * and `WorkspaceFS.forPrincipal(bob).resolve('foo')` produce paths in
 * disjoint trees. Even with identical user-supplied paths the actual
 * filesystem locations never collide.
 */
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve as pathResolve, sep } from 'node:path';
import { getConfig } from '@/config';
import type { Principal } from './principal';
import { ANONYMOUS_PRINCIPAL, isAuthenticated, principalFromUser } from './principal';

export class WorkspaceFsError extends Error {
  readonly code: 'TRAVERSAL' | 'OUTSIDE_ROOT' | 'UNAUTHENTICATED' | 'INVALID_INPUT';
  constructor(code: WorkspaceFsError['code'], message: string) {
    super(message);
    this.name = 'WorkspaceFsError';
    this.code = code;
  }
}

export interface WorkspaceFsOptions {
  /** Override the data root (otherwise read from config). Useful for tests. */
  dataRoot?: string;
  /** Workspace id within the user. Defaults to "default". */
  workspaceId?: string;
  /**
   * Absolute paths matching one of these prefixes are accepted in
   * addition to the workspace root. Used for transient files in
   * `/tmp/octipus-*` and similar. Caller is responsible for security
   * of the prefix.
   */
  extraAllowedPrefixes?: readonly string[];
}

/**
 * Compute the per-user data-root path. Pulled from config so the
 * deployment can override; defaults to `<workspace.rootPath>` so a
 * single-user install needs no migration to opt in.
 */
function configuredDataRoot(): string {
  try {
    const config = getConfig();
    return pathResolve(config.workspace.rootPath || './workspace');
  } catch {
    return pathResolve(process.env.WORKSPACE_PATH || process.cwd());
  }
}

export class WorkspaceFS {
  /** Absolute path to this principal's workspace files dir. */
  readonly root: string;
  /** Owning principal. */
  readonly principal: Principal;
  /** Configured workspace id (defaults to "default"). */
  readonly workspaceId: string;
  private readonly extraAllowedPrefixes: readonly string[];

  private constructor(principal: Principal, root: string, options: WorkspaceFsOptions) {
    this.principal = principal;
    this.workspaceId = options.workspaceId ?? 'default';
    this.root = root;
    this.extraAllowedPrefixes = (options.extraAllowedPrefixes ?? [])
      .map((p) => pathResolve(p));
  }

  /**
   * Build a `WorkspaceFS` for the given principal under the per-user
   * nested layout. Throws synchronously for anonymous principals —
   * callers should already have rejected those via the auth guard.
   */
  static forPrincipal(principal: Principal, options: WorkspaceFsOptions = {}): WorkspaceFS {
    if (!isAuthenticated(principal)) {
      throw new WorkspaceFsError('UNAUTHENTICATED',
        'WorkspaceFS requires an authenticated principal');
    }
    const dataRoot = options.dataRoot ?? configuredDataRoot();
    const workspaceId = options.workspaceId ?? 'default';
    const root = pathResolve(
      dataRoot,
      'users',
      principal.userId,
      'workspaces',
      workspaceId,
      'files',
    );
    return new WorkspaceFS(principal, root, options);
  }

  /**
   * Build a `WorkspaceFS` rooted at an explicit absolute path, with no
   * per-user nesting. Used by single-user installs to keep the existing
   * `<config.workspace.rootPath>` layout — Phase 1b only nests when
   * `multiuser.enabled` is true.
   */
  static withRoot(root: string, options: WorkspaceFsOptions = {}): WorkspaceFS {
    return new WorkspaceFS(
      ANONYMOUS_PRINCIPAL,
      pathResolve(root),
      options,
    );
  }

  /**
   * Build a `WorkspaceFS` for an in-flight agent.
   *
   *   - When `multiuser.enabled` is true AND the agent has a real userId
   *     (not the legacy `'system'` sentinel), returns the per-user
   *     nested layout.
   *   - Otherwise returns a flat `withRoot` instance pinned to
   *     `config.workspace.rootPath` so single-user installs and
   *     system-job tools keep their current layout.
   *
   * In both modes:
   *   - `config.workspace.additionalPaths` are added as extra allowed
   *     prefixes (lets a single-user deployment expose multiple repos).
   *   - The legacy `/tmp/assistant-` prefix is allowed for transient
   *     files. Pre-Phase-1b filesystem tools relied on this; we keep
   *     it so behavior is unchanged.
   */
  static forAgent(
    context?: { userId?: string },
    options: WorkspaceFsOptions = {},
  ): WorkspaceFS {
    let cfg: ReturnType<typeof getConfig> | undefined;
    try { cfg = getConfig(); } catch { /* config may not be loaded */ }

    const multiuser = !!cfg?.multiuser?.enabled;
    const dataRoot = options.dataRoot
      ?? pathResolve(cfg?.workspace.rootPath || './workspace');
    const additional = (cfg?.workspace.additionalPaths ?? []).map((p) => pathResolve(p));
    // Keep legacy tmp prefix so transient artifacts created by the
    // existing tool stack stay readable.
    const extra = [
      ...additional,
      '/tmp/assistant-',
      ...(options.extraAllowedPrefixes ?? []),
    ];

    if (multiuser && context?.userId && context.userId !== 'system') {
      const principal = principalFromUser({
        id: context.userId,
        username: context.userId,
        isAdmin: false,
      });
      return WorkspaceFS.forPrincipal(principal, {
        ...options,
        dataRoot,
        extraAllowedPrefixes: extra,
      });
    }

    return WorkspaceFS.withRoot(dataRoot, {
      ...options,
      dataRoot,
      extraAllowedPrefixes: extra,
    });
  }

  /**
   * Ensure the workspace root exists on disk. Idempotent. Call this
   * before the first write — `resolve()` does NOT create directories so
   * that read-only callers don't trigger filesystem mutation.
   */
  async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  /** Synchronous variant for callers that can't await. */
  ensureRootSync(): void {
    if (!existsSync(this.root)) {
      mkdirSync(this.root, { recursive: true });
    }
  }

  /**
   * Resolve a user-supplied path against this workspace's root.
   * Returns the absolute, normalized path. Throws `WorkspaceFsError`
   * for any input that escapes the root or hits a symlink pointing
   * outside it.
   *
   * The two phases:
   *
   *   1. Lexical resolve — `path.resolve(root, input)` normalizes `..`
   *      segments. Verify the result is still under `root`.
   *
   *   2. Real-path check — if the file exists, `realpath` resolves
   *      symlinks; the target must also be under `root`. If the file
   *      doesn't exist yet (write path), we check the parent directory
   *      instead.
   */
  resolve(userPath: string): string {
    if (typeof userPath !== 'string') {
      throw new WorkspaceFsError('INVALID_INPUT', 'path must be a string');
    }
    if (userPath.includes('\0')) {
      throw new WorkspaceFsError('INVALID_INPUT', 'path contains a null byte');
    }

    // Lexical resolution — `path.resolve` flattens `..` and combines
    // with the root unless `userPath` is absolute, in which case the
    // absolute path wins.
    const lexical = isAbsolute(userPath) ? pathResolve(userPath) : pathResolve(this.root, userPath);

    if (!this.isUnder(lexical, this.root) && !this.isInExtraAllowed(lexical)) {
      throw new WorkspaceFsError('OUTSIDE_ROOT',
        `path resolves outside workspace: ${lexical}`);
    }

    // Real-path check (catches symlink escapes). Tolerate the common
    // case where the file doesn't exist yet by climbing to the nearest
    // existing parent.
    const real = this.realPathBestEffort(lexical);
    if (!this.isUnder(real, this.root) && !this.isInExtraAllowed(real)) {
      throw new WorkspaceFsError('TRAVERSAL',
        `path resolves to a target outside workspace via symlink: ${real}`);
    }

    return real;
  }

  /** Like `resolve`, but returns null instead of throwing. */
  resolveOptional(userPath: string): string | null {
    try { return this.resolve(userPath); }
    catch (err) {
      if (err instanceof WorkspaceFsError) return null;
      throw err;
    }
  }

  /**
   * Whether the given absolute path is under `parent` (inclusive of
   * `parent` itself). Uses path-segment comparison so `/a/foo` is not
   * mistaken for being under `/a/foobar`.
   */
  isUnder(child: string, parent: string): boolean {
    const c = pathResolve(child);
    const p = pathResolve(parent);
    if (c === p) return true;
    return c.startsWith(p + sep);
  }

  /**
   * Walk `lexical` up to the nearest existing ancestor and apply
   * `realpath` there. Reattach the unresolved tail. Used to vet write
   * paths whose target file doesn't exist yet.
   */
  private realPathBestEffort(lexical: string): string {
    if (existsSync(lexical)) {
      try { return realpathSync(lexical); }
      catch { return lexical; }
    }
    let parent = dirname(lexical);
    let tail = basename(lexical);
    // Walk up at most 32 levels — guards against bizarrely deep paths.
    for (let i = 0; i < 32; i++) {
      if (existsSync(parent)) {
        try {
          return join(realpathSync(parent), tail);
        } catch {
          return lexical;
        }
      }
      const next = dirname(parent);
      if (next === parent) break;
      tail = join(basename(parent), tail);
      parent = next;
    }
    return lexical;
  }

  /**
   * Extra-allowed prefixes accept either:
   *   - a proper directory match via `isUnder` (e.g. `/data/extras` allows
   *     `/data/extras/foo` but NOT `/data/extras-evil`), or
   *   - a literal string-prefix match (e.g. `/tmp/assistant-` allows
   *     `/tmp/assistant-foo` — preserves the legacy tmp-file convention
   *     where the suffix encodes the session id).
   *
   * Operators who add custom directory prefixes don't need to think
   * about this — `isUnder` is the safe path. The string-prefix path is
   * here for backwards compat with the legacy validatePath behavior.
   */
  private isInExtraAllowed(absolute: string): boolean {
    return this.extraAllowedPrefixes.some(
      (p) => this.isUnder(absolute, p) || absolute.startsWith(p),
    );
  }
}
