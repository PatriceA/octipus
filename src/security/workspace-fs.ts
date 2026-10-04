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
 *       workspaces/{workspace_id | default}/
 *         files/      ← root for this WorkspaceFS instance
 *         documents/  ← uploads (managed by /api/documents)
 *         cache/      ← future
 *     system/
 *       skills/       ← read-only seeds
 *
 * The user's default workspace (and the user level, no workspace) keeps
 * the literal `default` segment, which every file written before
 * per-workspace roots lives under; any other workspace uses its id.
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
import { existsSync, mkdirSync, realpathSync, renameSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { basename, dirname, isAbsolute, join, resolve as pathResolve } from 'node:path';
import { getConfig } from '@/config';
import type { AgentContext } from '@/core/types';
import type { Principal } from './principal';
import { ANONYMOUS_PRINCIPAL, agentPrincipal, isAuthenticated } from './principal';

/**
 * Whether `child` is `parent` or inside it, by path segments (`/a/foo` is not
 * under `/a/foobar`). `relative` rather than `startsWith`: win32 `relative`
 * is case-insensitive, so `c:\users\me` counts as inside `C:\Users\me`, and
 * a different drive yields an absolute result instead of a false match.
 * `pathApi` exists so tests can pin win32 semantics on a posix host.
 */
export function isInside(parent: string, child: string, pathApi: typeof path.posix = path): boolean {
  const r = pathApi.relative(pathApi.resolve(parent), pathApi.resolve(child));
  return r === '' || (r !== '..' && !r.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(r));
}

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
  /**
   * Absolute paths matching one of these prefixes are accepted in
   * addition to the workspace root. Used for transient files in
   * `/tmp/octipus-*` and similar. Caller is responsible for security
   * of the prefix.
   */
  extraAllowedPrefixes?: readonly string[];
}

/**
 * A system job (no user behind it) working on files. It names its root
 * explicitly: a system job never inherits the shared `workspace.rootPath`
 * by omission, and a user's agent never lands there.
 */
export interface SystemFsJob {
  system: true;
  root: string;
}

/** The directory a user's default workspace keeps, so no file that predates per-workspace roots moves. */
export const DEFAULT_WORKSPACE_SEGMENT = 'default';

/**
 * Owner and default flag of every workspace row the `OrgWorkspaceManager`
 * has read or written in this process (loaded at boot, refreshed by each
 * workspace lookup). The file root of a workspace depends on whether it is
 * its owner's default, and the many synchronous callers of `forAgent` /
 * `forSession` cannot ask the database.
 */
const workspaceRows = new Map<string, { userId: string; isDefault: boolean }>();

/** Record workspace rows as read from or written to the database. */
export function noteWorkspaceRows(rows: ReadonlyArray<{ id: string; userId: string; isDefault: boolean }>): void {
  for (const row of rows) {
    if (row.isDefault) {
      // One default per user (partial unique index): a newly seen default
      // demotes whichever row this process still takes for the default.
      for (const [id, known] of workspaceRows) {
        if (known.userId === row.userId && known.isDefault && id !== row.id) known.isDefault = false;
      }
    }
    workspaceRows.set(row.id, { userId: row.userId, isDefault: row.isDefault });
  }
}

/** Drop a deleted workspace row. */
export function forgetWorkspaceRow(id: string): void {
  workspaceRows.delete(id);
}

/** Test hook: clear the known workspace rows. */
export function _resetWorkspaceRowsForTests(): void {
  workspaceRows.clear();
}

/**
 * The directory segment of a user's workspace: the workspace id, except the
 * user's default workspace (and the user level, `null`), which keep
 * `default`. A workspace this process has not seen, or one owned by someone
 * else, throws: guessing would put files in the wrong workspace.
 */
export function workspaceSegment(userId: string, workspaceId: string | null | undefined): string {
  if (!workspaceId) return DEFAULT_WORKSPACE_SEGMENT;
  const row = workspaceRows.get(workspaceId);
  if (!row || row.userId !== userId) {
    throw new WorkspaceFsError('INVALID_INPUT',
      `workspace ${workspaceId} of user ${userId} is not loaded; resolve it through the workspace manager first`);
  }
  return row.isDefault ? DEFAULT_WORKSPACE_SEGMENT : workspaceId;
}

/**
 * Compute the per-user data-root path. Pulled from config so the
 * deployment can override; defaults to `<workspace.rootPath>`.
 */
function configuredDataRoot(): string {
  try {
    const config = getConfig();
    return pathResolve(config.workspace.rootPath || './workspace');
  } catch {
    return pathResolve(process.env.WORKSPACE_PATH || process.cwd());
  }
}

/**
 * Move a user's workspace directories when the default changes, so each
 * workspace keeps its files: the old default's `default` directory becomes
 * `<previousDefaultId>`, and `<newDefaultId>` becomes `default`. Renames
 * within one directory; a missing source has nothing to move. Throws when a
 * target already exists rather than merging two trees. (A null id on either
 * side is "no such workspace", which undoing a swap from no default needs.)
 */
export function swapDefaultWorkspaceFiles(
  userId: string,
  previousDefaultId: string | null,
  newDefaultId: string | null,
  dataRoot: string = configuredDataRoot(),
): void {
  const base = pathResolve(dataRoot, 'users', userId, 'workspaces');
  const defaultDir = join(base, DEFAULT_WORKSPACE_SEGMENT);
  const newDir = newDefaultId ? join(base, newDefaultId) : null;
  const parked = join(base, `.default-swap-${newDefaultId ?? 'none'}`);
  if (existsSync(parked)) throw new Error(`workspace swap already in progress: ${parked} exists`);
  const oldDir = previousDefaultId ? join(base, previousDefaultId) : null;
  if (existsSync(defaultDir)) {
    if (!oldDir) throw new Error(`user ${userId} has a ${DEFAULT_WORKSPACE_SEGMENT} workspace directory but no previous default workspace to give it to`);
    if (existsSync(oldDir)) throw new Error(`cannot move the previous default workspace's files: ${oldDir} already exists`);
    renameSync(defaultDir, parked);
  }
  if (newDir && existsSync(newDir)) renameSync(newDir, defaultDir);
  if (oldDir && existsSync(parked)) renameSync(parked, oldDir);
}

/**
 * Extra prefixes an agent may use beside its root:
 * `config.workspace.additionalPaths` (lets a deployment expose multiple
 * repos), the legacy `/tmp/assistant-` prefix for transient files, and the
 * caller's own extras.
 */
function agentExtraPrefixes(options: WorkspaceFsOptions): string[] {
  let cfg: ReturnType<typeof getConfig> | undefined;
  try { cfg = getConfig(); } catch { /* config may not be loaded */ }
  const additional = (cfg?.workspace.additionalPaths ?? []).map((p) => pathResolve(p));
  return [
    ...additional,
    '/tmp/assistant-',
    // `/tmp` never matches on Windows (and `$TMPDIR` may differ on posix).
    join(tmpdir(), 'assistant-'),
    ...(options.extraAllowedPrefixes ?? []),
  ];
}

export class WorkspaceFS {
  /** Absolute path to this principal's workspace files dir. */
  readonly root: string;
  /** Owning principal. */
  readonly principal: Principal;
  private readonly extraAllowedPrefixes: readonly string[];
  /** `root` with junctions/symlinks resolved; cached once the root exists. */
  private realRootCache: string | undefined;

  private constructor(principal: Principal, root: string, options: WorkspaceFsOptions) {
    this.principal = principal;
    this.root = root;
    this.extraAllowedPrefixes = (options.extraAllowedPrefixes ?? [])
      .map((p) => pathResolve(p));
  }

  /**
   * Build a `WorkspaceFS` for the given principal under the per-user
   * nested layout, in the principal's workspace (`workspaceSegment`).
   * Throws synchronously for anonymous principals — callers should
   * already have rejected those via the auth guard.
   */
  static forPrincipal(principal: Principal, options: WorkspaceFsOptions = {}): WorkspaceFS {
    if (!isAuthenticated(principal)) {
      throw new WorkspaceFsError('UNAUTHENTICATED',
        'WorkspaceFS requires an authenticated principal');
    }
    const dataRoot = options.dataRoot ?? configuredDataRoot();
    const root = pathResolve(
      dataRoot,
      'users',
      principal.userId,
      'workspaces',
      workspaceSegment(principal.userId, principal.workspaceId),
      'files',
    );
    return new WorkspaceFS(principal, root, options);
  }

  /**
   * Build a `WorkspaceFS` rooted at an explicit absolute path, with no
   * per-user nesting: a dev-mode project, a skill directory, a system
   * job's named root.
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
   *   - An agent works for a real user: the root is that user's workspace
   *     (`context.workspaceId`; none means the default workspace) under
   *     `<dataRoot>/users/<id>/workspaces/<segment>/files`.
   *   - A system job passes `{ system: true, root }` and gets exactly that
   *     root. There is no implicit flat root: an agent context without a
   *     real user throws.
   *
   * In both cases:
   *   - `config.workspace.additionalPaths` are added as extra allowed
   *     prefixes (lets a deployment expose multiple repos).
   *   - The legacy `/tmp/assistant-` prefix is allowed for transient files.
   */
  static forAgent(
    context: AgentContext | SystemFsJob,
    options: WorkspaceFsOptions = {},
  ): WorkspaceFS {
    if ('system' in context) {
      if (context.system !== true || !context.root) {
        throw new WorkspaceFsError('INVALID_INPUT', 'a system job must name its root');
      }
      return WorkspaceFS.withRoot(context.root, { ...options, extraAllowedPrefixes: agentExtraPrefixes(options) });
    }

    // `'system'`/`'local'` were the old flat-root sentinels: a user path
    // never resolves to the shared root, so they are refused here.
    if (!context.userId || context.userId === 'system' || context.userId === 'local') {
      throw new WorkspaceFsError('UNAUTHENTICATED',
        `agent context has no real user (${context.userId || 'none'}); a system job passes { system: true, root }`);
    }
    return WorkspaceFS.forRequest(agentPrincipal(context), options);
  }

  /**
   * The root an agent of the principal's workspace works in, with the same
   * extras as `forAgent`: for REST surfaces that must accept exactly the
   * paths such an agent may use (knowledge indexing).
   */
  static forRequest(principal: Principal, options: WorkspaceFsOptions = {}): WorkspaceFS {
    return WorkspaceFS.forPrincipal(principal, {
      ...options,
      extraAllowedPrefixes: agentExtraPrefixes(options),
    });
  }

  /**
   * Build a `WorkspaceFS` for a session's read-back surfaces (file browser,
   * Changes tab, `/changes`). MUST mirror the cwd resolution the CLI agent
   * worker uses when spawning (`cli-agent-worker.ts`): a dev-mode session
   * with a `projectPath` runs the agent inside the project directory, so
   * read-back must target that same root — pinning it to the per-user
   * workspace 404s the file browser and blinds the Changes tab. Non-dev
   * sessions get the session's own workspace (`session.workspaceId`), the
   * root `forAgent` gives the agents of the session's turns.
   *
   * Trust note: `projectPath` is only honored together with `devMode` —
   * the same (pre-existing) trust decision that lets the CLI agent run
   * with that directory as cwd; this helper adds no new reach.
   */
  static forSession(
    session: { userId: string; workspaceId?: string | null; context?: unknown },
    options: WorkspaceFsOptions = {},
  ): WorkspaceFS {
    const ctx = session.context as
      | { devMode?: boolean; projectPath?: string }
      | null
      | undefined;
    if (ctx?.devMode && ctx.projectPath) {
      return WorkspaceFS.withRoot(pathResolve(ctx.projectPath), options);
    }
    return WorkspaceFS.forPrincipal(
      agentPrincipal({ userId: session.userId, workspaceId: session.workspaceId ?? null }),
      options,
    );
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

    // Accept our own canonical output too when the workspace root is linked.
    // The real-path check below still rejects links that escape either spelling.
    if (!this.isUnder(lexical, this.root) && !this.isUnder(lexical, this.realRoot()) && !this.isInExtraAllowed(lexical)) {
      throw new WorkspaceFsError('OUTSIDE_ROOT',
        `path resolves outside workspace: ${lexical}`);
    }

    // Real-path check (catches symlink escapes). Tolerate the common
    // case where the file doesn't exist yet by climbing to the nearest
    // existing parent.
    // Compare against the REAL root: a junction/subst/redirected workspace
    // canonicalizes every candidate to its target, which never sits under
    // the lexical root.
    const real = this.realPathBestEffort(lexical);
    if (!this.isUnder(real, this.realRoot()) && !this.isInExtraAllowed(real)) {
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
    return isInside(parent, child);
  }

  private realRoot(): string {
    if (this.realRootCache) return this.realRootCache;
    const real = this.realPathBestEffort(this.root);
    // Don't cache before the root exists — it may be created as a junction.
    if (existsSync(this.root)) this.realRootCache = real;
    return real;
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
