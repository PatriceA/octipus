/**
 * WorkspaceFS — per-user filesystem sandbox.
 *
 * Every filesystem tool of a user's agent resolves paths against a
 * per-(user, workspace) root, through a strict path resolver that rejects
 * any input resolving outside it. A system job (no user) names its root
 * explicitly; nothing falls back to a root shared by every user.
 *
 * Layout:
 *
 *   $DATA_ROOT/
 *     users/{user_id}/
 *       workspaces/{files_dir}/
 *         files/      ← root for this WorkspaceFS instance
 *     system/
 *       skills/       ← read-only seeds
 *
 * (Uploads live elsewhere: `config.workspace.documentsPath`, keyed by
 * workspace id, see `api/routes/documents.ts`.)
 *
 * `files_dir` is stored on the workspace row: `default` for the workspace
 * that was its owner's default when per-workspace roots arrived (every file
 * written before them lives there, so none moved), the workspace id for
 * every other. Changing the default moves no file; a transfer moves the
 * directory to the recipient's tree. The user level (no workspace) keeps
 * the literal `default` segment.
 *
 * Construction does not touch the filesystem (the root is created by
 * `ensureRoot()`), but it throws for an anonymous principal and for a
 * workspace this process has not loaded or that another user owns.
 *
 * Path resolution rules:
 *   - Empty / relative paths resolve relative to the workspace root.
 *   - Absolute paths must be within the workspace root or a configured
 *     extra-allow list (e.g. `/tmp/assistant-…` for transient files).
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
import { existsSync, mkdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { basename, dirname, isAbsolute, join, relative, resolve as pathResolve } from 'node:path';
import { getConfig } from '@/config';
import type { AgentContext } from '@/core/types';
import type { Principal } from './principal';
import { ANONYMOUS_PRINCIPAL, agentPrincipal, isAuthenticated, isRealUserId } from './principal';
import { agentConfigRefusal, isAgentConfigPath } from './space-tools';

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
  readonly code: 'TRAVERSAL' | 'OUTSIDE_ROOT' | 'OUTSIDE_SCOPE' | 'UNAUTHENTICATED' | 'INVALID_INPUT' | 'AGENT_CONFIG';
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

/** Options of a space's file root (`WorkspaceFS.forSpace`). */
export interface SpaceFsOptions {
  /** Tests: replaces the configured root. */
  dataRoot?: string;
  /**
   * A guest's folders (S6): every path must lie under one of them
   * (relative to the space's file root). Absent for every other role.
   */
  guestFolders?: readonly string[] | null;
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

/** The directory of the user level (no workspace) and of a pre-workspace default. */
export const DEFAULT_WORKSPACE_SEGMENT = 'default';

/**
 * Owner and files directory of every workspace row the
 * `OrgWorkspaceManager` has read or written in this process (loaded at
 * boot, refreshed by each workspace lookup): the many synchronous callers
 * of `forAgent` / `forSession` cannot ask the database.
 */
const workspaceRows = new Map<string, { userId: string; filesDir: string }>();

/**
 * Record workspace rows as read from or written to the database. A shared
 * workspace (a space, `userId` NULL) has no personal file root and is not
 * recorded: its files live under `spaces/<id>`, never under a user.
 */
export function noteWorkspaceRows(rows: ReadonlyArray<{ id: string; userId: string | null; filesDir: string }>): void {
  for (const row of rows) {
    if (row.userId === null) {
      noteSharedWorkspace(row.id);
      continue;
    }
    workspaceRows.set(row.id, { userId: row.userId, filesDir: row.filesDir });
  }
}

/**
 * Shared workspaces (spaces) this process has seen: their files live under
 * `spaces/<id>/files` (`forSpace`), and the synchronous `forAgent` /
 * `forSession` need to know a space id when they see one. Filled at boot
 * (`loadFileRoots`) and by every membership read (`getMembership`).
 */
const sharedWorkspaceIds = new Set<string>();

/** Record a shared workspace id (see `sharedWorkspaceIds`). */
export function noteSharedWorkspace(id: string): void {
  sharedWorkspaceIds.add(id);
}

/** Whether `id` is a shared workspace this process has seen. */
export function isKnownSharedWorkspace(id: string | null | undefined): boolean {
  return !!id && sharedWorkspaceIds.has(id);
}

/**
 * Personal workspace ids `isSharedWorkspaceId` read from the database. A
 * workspace's kind never changes, so a negative answer is cached as well.
 */
const personalWorkspaceIds = new Set<string>();
const MAX_PERSONAL_IDS = 100_000;

/**
 * Whether `id` names a shared workspace: the process caches first, then
 * the database (a space created by another process after boot is not in
 * the cache until this process reads one of its memberships). A failed
 * read throws — callers deciding who may act never guess "personal".
 */
export async function isSharedWorkspaceId(id: string | null | undefined): Promise<boolean> {
  if (!id) return false;
  if (sharedWorkspaceIds.has(id)) return true;
  if (workspaceRows.has(id) || personalWorkspaceIds.has(id)) return false;
  const { isUuid } = await import('@/db/repositories/scoped');
  if (!isUuid(id)) return false;
  const [{ getDb }, { workspaces }, { eq }] = await Promise.all([
    import('@/db/postgres'), import('@/db/schema/organizations'), import('drizzle-orm'),
  ]);
  const [row] = await getDb().select({ kind: workspaces.kind }).from(workspaces).where(eq(workspaces.id, id)).limit(1);
  if (row?.kind === 'shared') {
    noteSharedWorkspace(id);
    return true;
  }
  // An id with no row is not cached: it may be a workspace not created yet.
  if (row) {
    personalWorkspaceIds.add(id);
    if (personalWorkspaceIds.size > MAX_PERSONAL_IDS) personalWorkspaceIds.delete(personalWorkspaceIds.values().next().value as string);
  }
  return false;
}

/** Drop a deleted workspace row. */
export function forgetWorkspaceRow(id: string): void {
  workspaceRows.delete(id);
  sharedWorkspaceIds.delete(id);
  personalWorkspaceIds.delete(id);
}

/** Test hook: clear the known workspace rows. */
export function _resetWorkspaceRowsForTests(): void {
  workspaceRows.clear();
  sharedWorkspaceIds.clear();
  personalWorkspaceIds.clear();
}

/**
 * The directory segment of a user's workspace: its stored `files_dir`, or
 * `default` for the user level (`null`). A workspace this process has not
 * seen, or one owned by someone else, throws: guessing would put files in
 * the wrong workspace.
 */
export function workspaceSegment(userId: string, workspaceId: string | null | undefined): string {
  if (!workspaceId) return DEFAULT_WORKSPACE_SEGMENT;
  const row = workspaceRows.get(workspaceId);
  if (!row || row.userId !== userId) {
    throw new WorkspaceFsError('INVALID_INPUT',
      `workspace ${workspaceId} of user ${userId} is not loaded; resolve it through the workspace manager first`);
  }
  return row.filesDir;
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

/** The directory under the data root (and under the documents root) that holds every space's files. */
export const SPACES_DIR = 'spaces';

/**
 * The two directories a space's files live in (docs/plans/coworking-spec.md
 * §5.5, §5.8): `<workspace.rootPath>/spaces/<id>` (its files) and
 * `<workspace.documentsPath>/spaces/<id>` (its uploads). Purge removes both.
 */
export function spaceDirectories(workspaceId: string): { root: string; documents: string } {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workspaceId)) {
    throw new WorkspaceFsError('INVALID_INPUT', `not a space id: ${workspaceId}`);
  }
  const config = getConfig();
  return {
    root: pathResolve(config.workspace.rootPath || './workspace', SPACES_DIR, workspaceId),
    documents: pathResolve(config.workspace.documentsPath || './workspace/documents', SPACES_DIR, workspaceId),
  };
}

/** `<dataRoot>/users/<userId>/workspaces/<filesDir>`: everything a workspace keeps on disk. */
export function workspaceDir(userId: string, filesDir: string, dataRoot: string = configuredDataRoot()): string {
  if (!isRealUserId(userId)) throw new WorkspaceFsError('INVALID_INPUT', `not a user id: ${JSON.stringify(userId)}`);
  if (!/^[A-Za-z0-9-]+$/.test(filesDir)) {
    throw new WorkspaceFsError('INVALID_INPUT', `not a workspace directory name: ${JSON.stringify(filesDir)}`);
  }
  return pathResolve(dataRoot, 'users', userId, 'workspaces', filesDir);
}

/**
 * Move a workspace's directory, for a transfer: one rename. A missing source
 * has nothing to move (the workspace never wrote a file). Throws when the
 * target exists rather than merging two trees.
 */
export function moveWorkspaceFiles(
  from: { userId: string; filesDir: string },
  to: { userId: string; filesDir: string },
  dataRoot: string = configuredDataRoot(),
): void {
  const source = workspaceDir(from.userId, from.filesDir, dataRoot);
  const target = workspaceDir(to.userId, to.filesDir, dataRoot);
  if (!existsSync(source)) return;
  if (existsSync(target)) throw new WorkspaceFsError('INVALID_INPUT', `cannot move workspace files: ${target} already exists`);
  mkdirSync(dirname(target), { recursive: true });
  renameSync(source, target);
}

/** Remove a deleted workspace's directory and everything in it. */
export function removeWorkspaceFiles(userId: string, filesDir: string, dataRoot: string = configuredDataRoot()): void {
  rmSync(workspaceDir(userId, filesDir, dataRoot), { recursive: true, force: true });
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
  /** A space's file root (`forSpace`): writes to coding agent configuration are refused (`assertWritable`). */
  readonly isSpace: boolean;
  /** A guest's folders in a space (S6): `resolve` refuses every path outside them. Null: the whole root. */
  readonly guestFolders: readonly string[] | null;

  private constructor(principal: Principal, root: string, options: WorkspaceFsOptions, isSpace = false, guestFolders: readonly string[] | null = null) {
    this.principal = principal;
    this.root = root;
    this.isSpace = isSpace;
    this.guestFolders = guestFolders;
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
    if (principal.workspaceKind === 'shared' || isKnownSharedWorkspace(principal.workspaceId)) {
      return WorkspaceFS.forSpace(principal.workspaceId as string, { dataRoot: options.dataRoot, guestFolders: principal.spaceScope?.folders });
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
   * Build the `WorkspaceFS` of a space (docs/plans/coworking-spec.md §5.5):
   * `<workspace.rootPath>/spaces/<id>/files`, shared by every member. No
   * extra prefixes in a space context — not `/tmp/assistant-`, not
   * `workspace.additionalPaths`, not a caller's: a member's agent reaches
   * the space's files and nothing of the host beside them. A guest's
   * (`guestFolders`, S6) reaches only the folders of their scope.
   */
  static forSpace(workspaceId: string, options: SpaceFsOptions = {}): WorkspaceFS {
    // `spaceDirectories` validates the id; a test's `dataRoot` replaces the configured root.
    const { root } = spaceDirectories(workspaceId);
    const base = options.dataRoot ? pathResolve(options.dataRoot, SPACES_DIR, workspaceId) : root;
    return new WorkspaceFS(ANONYMOUS_PRINCIPAL, join(base, 'files'), {}, true, options.guestFolders ? [...options.guestFolders] : null);
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

    // Anything but a real user id (a `'system'` sentinel, a username) is
    // refused: a user path never resolves to a shared root.
    if (!isRealUserId(context.userId)) {
      throw new WorkspaceFsError('UNAUTHENTICATED',
        `agent context has no real user (${context.userId || 'none'}); a system job passes { system: true, root }`);
    }
    if (context.space) return WorkspaceFS.forSpace(context.space.workspaceId, { guestFolders: context.space.scope?.folders });
    // A space without the turn's membership: no folder at all (fail closed;
    // the approval path refuses such a turn's tools anyway).
    if (isKnownSharedWorkspace(context.workspaceId)) return WorkspaceFS.forSpace(context.workspaceId as string, { guestFolders: [] });
    return WorkspaceFS.forRequest(agentPrincipal(context), options);
  }

  /**
   * The root an agent of the principal's workspace works in, with the same
   * extras as `forAgent`: for REST surfaces that must accept exactly the
   * paths such an agent may use (knowledge indexing).
   */
  static forRequest(principal: Principal, options: WorkspaceFsOptions = {}): WorkspaceFS {
    if (principal.workspaceKind === 'shared' || isKnownSharedWorkspace(principal.workspaceId)) {
      return WorkspaceFS.forSpace(principal.workspaceId as string, { guestFolders: principal.spaceScope?.folders });
    }
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
    // A space session reads back the space's files, whatever its context
    // says: no dev-mode project root in a space.
    if (isKnownSharedWorkspace(session.workspaceId)) return WorkspaceFS.forSpace(session.workspaceId as string);
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
    // A guest (S6): under one of their folders, judged on the real path so a
    // link inside a folder cannot reach the rest of the space.
    if (this.guestFolders && !this.guestFolders.some((f) => this.isUnder(real, join(this.realRoot(), f)))) {
      throw new WorkspaceFsError('OUTSIDE_SCOPE',
        `path is outside the folders you were given in this space: ${relative(this.root, lexical) || '.'}`);
    }

    return real;
  }

  /**
   * Refuse a write to `absolute` (a path `resolve` returned) when this is a
   * space's root and the path is, or lies under, a coding agent's
   * configuration (`.claude/`, `.codex/`, `.gemini/`, `.agents/`, `.vibe/`,
   * `.mcp.json`): a CLI model run in the space would read it as its own
   * settings, hooks or MCP servers, in every member's runs (§5.6).
   */
  assertWritable(absolute: string): void {
    if (!this.isSpace) return;
    for (const root of [this.root, this.realRoot()]) {
      if (this.isUnder(absolute, root) && isAgentConfigPath(relative(root, absolute))) {
        throw new WorkspaceFsError('AGENT_CONFIG', agentConfigRefusal(relative(root, absolute)));
      }
    }
  }

  /**
   * A space file's path relative to the space's files root, `/`-separated
   * (`''` for the root itself) — what its file lease names (§7.5). Null
   * outside a space or for a path not under the root.
   */
  spaceRelative(absolute: string): string | null {
    if (!this.isSpace) return null;
    for (const root of [this.root, this.realRoot()]) {
      if (this.isUnder(absolute, root)) return relative(root, absolute).split(path.sep).join('/');
    }
    return null;
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
