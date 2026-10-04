/**
 * Opt-in git worktree isolation for coding CLI children (`swarm.worktreeIsolation`).
 *
 * Without it, parallel coding children share one working tree and only
 * `utils/file-mutation-queue.ts` serialises their writes — which does nothing
 * for a Claude Code / Codex child, whose edits never pass through our tools.
 * With it, each qualifying child gets its own worktree on its own branch
 * (`octipus/<id>`), and on completion the framework — not the child — records
 * what it produced (branch, head, diff stat) and tries to merge it back.
 *
 * Safety rules, each of which is load-bearing:
 *
 * - Every git call is an ARGUMENT VECTOR through `session-changes#runGit`,
 *   never a shell string. The only caller-supplied value that reaches a path or
 *   ref name is the worktree id, validated to `[A-Za-z0-9][A-Za-z0-9_-]*`.
 * - EVERY server-side git call runs with hooks disabled (`core.hooksPath`),
 *   fsmonitor off and signing off: the server must not execute anything the
 *   repo (or an agent working in it) planted.
 * - Commands that mutate a tree (worktree add, commit, merge, merge --abort)
 *   get a long timeout: a kill mid-merge leaves the user's tree half-changed.
 *   After any failed merge, a `MERGE_HEAD` is aborted.
 * - A merge into the project is attempted ONLY when the project is on a
 *   branch, has no tracked changes, is not mid-merge, and still contains the
 *   commit the worktree was created from. A conflict is aborted and the branch
 *   kept. Nothing is force-pushed; a branch is only ever deleted with
 *   `git branch -d`, which git itself refuses for unmerged work.
 * - A worktree is never removed while its HEAD commit is reachable from no
 *   local branch: detached work is first fast-forwarded onto `octipus/<id>` or
 *   pinned by a keep-ref `octipus/<id>-detached`. Nor while it has uncommitted
 *   changes. `--force` is used only after both checks pass.
 *
 * Staleness: a worktree starts at the project's HEAD and does not see
 * uncommitted edits in the shared tree. Rather than copy them, the spawner
 * does not isolate a child when the project has tracked uncommitted changes —
 * the merge would be skipped as dirty anyway.
 *
 * Dependencies: a fresh worktree has no `node_modules`. Unless
 * `swarm.worktreeLinkNodeModules` is off, `createWorktree` makes
 * `<wt>/node_modules` a single symlink to the repo's — SHARED, read-mostly:
 * an install inside the worktree writes into the user's real `node_modules`.
 * See `linkNodeModules`.
 *
 * Descendants: a child spawned by a worktree child inherits that worktree (its
 * cwd, scorer root and, for a native agent, its file tools' `projectPath`) and
 * never gets a worktree of its own. See `inheritedTreeMetadata`.
 */
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { type GitResult, repoRootFor, runGit } from '@/core/session-changes';
import { coreLogger } from '@/utils/logger';

export const WORKTREE_BRANCH_PREFIX = 'octipus/';

// Leading alphanumeric so an id can never read as an option (`-f`).
const VALID_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Read-only commands: short, a hang must not hold a child's completion. */
const READ_TIMEOUT_MS = 30_000;
/** Commands that write a tree: long, a kill mid-write is the worse outcome. */
const MUTATE_TIMEOUT_MS = 15 * 60_000;

/**
 * Prepended to EVERY git call made here. `-c` rather than repo config so
 * nothing about the user's repo changes. Missing identity values are supplied
 * only for commit/merge operations; configured identity is preserved. `core.hooksPath=/dev/null` disables every hook (there is no file
 * under /dev/null); `core.fsmonitor=false` stops a configured fsmonitor daemon
 * command from being executed.
 */
export const SERVER_GIT_CONFIG = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'commit.gpgsign=false',
];

async function git(cwd: string, args: string[], mode: 'read' | 'mutate' = 'read'): Promise<GitResult> {
  const config = [...SERVER_GIT_CONFIG];
  if (mode === 'mutate' && ['commit', 'merge'].includes(args[0]) && !args.includes('--abort')) {
    // Honor local/global identity; synthesize only values absent from Git config.
    const identities = await Promise.all(['user.name', 'user.email'].map(key =>
      runGit(cwd, [...SERVER_GIT_CONFIG, 'config', '--default', '', '--get', key], { timeoutMs: READ_TIMEOUT_MS })));
    for (const [index, key] of ['user.name', 'user.email'].entries()) {
      const identity = identities[index];
      if (!identity.ok) throw new Error(`Cannot read Git identity: ${identity.stderr}`);
      if (!identity.stdout.trim()) config.push('-c', `${key}=${index === 0 ? 'Octipus agent' : 'octipus-agent@localhost'}`);
    }
  }
  return runGit(cwd, [...config, ...args], {
    timeoutMs: mode === 'mutate' ? MUTATE_TIMEOUT_MS : READ_TIMEOUT_MS,
  });
}

async function mustGit(cwd: string, args: string[], mode: 'read' | 'mutate' = 'read'): Promise<string> {
  const r = await git(cwd, args, mode);
  if (!r.ok) throw new Error(`git ${args.join(' ')} failed${r.timedOut ? ' (timed out)' : ''}: ${r.stderr.trim()}`);
  return r.stdout;
}

/**
 * Where worktrees live: the app data dir, never inside the user's repo.
 * `OCTIPUS_WORKTREES_DIR` relocates it (tests, or a host whose home is small).
 */
export function worktreesRoot(): string {
  const override = process.env.OCTIPUS_WORKTREES_DIR;
  return override && isAbsolute(override) ? resolve(override) : join(homedir(), '.octipus', 'worktrees');
}

export function isValidWorktreeId(id: string): boolean {
  return typeof id === 'string' && VALID_ID.test(id);
}

/**
 * The canonical repo root when `dir` IS a git top level, else null. A directory
 * nested inside a larger repo does not qualify — isolating a sub-folder would
 * branch (and merge) the whole enclosing repo.
 */
export function gitTopLevelOf(dir: string): Promise<string | null> {
  if (!dir) return Promise.resolve(null);
  return repoRootFor(dir, SERVER_GIT_CONFIG);
}

/** Tracked uncommitted changes (or a merge in progress) in `repo`. A failure reads as "yes". */
export async function hasTrackedChanges(repo: string): Promise<boolean> {
  if ((await git(repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).ok) return true;
  const r = await git(repo, ['status', '--porcelain', '--untracked-files=no']);
  return !r.ok || r.stdout.trim().length > 0;
}

async function hasUncommitted(cwd: string): Promise<boolean> {
  const r = await git(cwd, ['status', '--porcelain']);
  return !r.ok || r.stdout.trim().length > 0;
}

async function isAncestor(repo: string, a: string, b: string): Promise<boolean> {
  return (await git(repo, ['merge-base', '--is-ancestor', a, b])).ok;
}

async function revParse(cwd: string, rev: string): Promise<string | null> {
  const r = await git(cwd, ['rev-parse', '-q', '--verify', `${rev}^{commit}`]);
  return r.ok ? r.stdout.trim() || null : null;
}

export interface WorktreeHandle {
  id: string;
  repoRoot: string;
  path: string;
  branch: string;
  /** Commit the worktree was created from — the diff baseline. */
  baseSha: string;
}

export type WorktreeMergeOutcome =
  | 'merged'
  | 'conflict'
  | 'skipped_dirty'
  | 'skipped_detached'
  | 'skipped_moved'
  | 'skipped_status'
  | 'skipped_other_attempt'
  | 'no_changes'
  | 'failed';

/** What the parent is told about a child's worktree. Carried on the receipt. */
export interface WorktreeReport {
  branch: string;
  worktreePath: string;
  baseSha: string;
  headSha: string;
  /** `git diff --shortstat base..head`, e.g. "2 files changed, 10 insertions(+)". */
  diffStat: string;
  filesChanged: number;
  merge: WorktreeMergeOutcome;
  mergeDetail?: string;
  /** Whether the branch still exists after clean-up (false only once merged and deleted). */
  branchKept: boolean;
  /** A ref created or moved so detached work stays reachable after clean-up. */
  keptRef?: string;
}

// ── Ownership ────────────────────────────────────────────────────────
//
// In-process: the set of ids whose child is still running here. Across
// processes: an `<id>.pid` file beside the worktree, so a second server's
// reaper never judges a worktree whose owner is alive.

const live = new Map<string, string>(); // id -> worktrees root

function pidFile(root: string, id: string): string {
  return join(root, `${id}.pid`);
}

function ownedByLiveProcess(root: string, id: string): boolean {
  if (live.has(id)) return true;
  try {
    const pid = Number.parseInt(readFileSync(pidFile(root, id), 'utf-8').trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
    process.kill(pid, 0); // throws when no such process
    return true;
  } catch (err) {
    // EPERM: the process exists but is someone else's — still alive.
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

export function isWorktreeLive(id: string): boolean {
  return live.has(id);
}

/** Stop owning a worktree without removing it (it is kept for a human or the reaper). */
export function releaseWorktree(id: string): void {
  const root = live.get(id);
  live.delete(id);
  if (root) rmSync(pidFile(root, id), { force: true });
}

// ── Which attempt produced a result ──────────────────────────────────

const attemptTrees = new WeakMap<object, string>();

/** Record that `result` came from an attempt that ran in the worktree at `path`. */
export function recordAttemptTree(result: object, path: string): void {
  attemptTrees.set(result, path);
}

export function attemptTreeOf(result: object | undefined): string | undefined {
  return result ? attemptTrees.get(result) : undefined;
}

/** One merge at a time per repo: two children finishing together share one index. */
const repoLocks = new Map<string, Promise<unknown>>();
function withRepoLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoLocks.get(repoRoot) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => undefined);
  repoLocks.set(repoRoot, tail);
  void tail.then(() => {
    if (repoLocks.get(repoRoot) === tail) repoLocks.delete(repoRoot);
  });
  return next;
}

function assertInside(root: string, p: string): void {
  const rel = relative(resolve(root), resolve(p));
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.includes(`..${sep}`)) {
    throw new Error(`worktree path escapes ${root}: ${p}`);
  }
}

/**
 * Create `<root>/<id>` as a worktree of `repoRoot` on a new branch
 * `octipus/<id>` at the repo's current HEAD. Throws on any failure — the caller
 * decides to fall back to the shared tree.
 */
export async function createWorktree(
  repoRoot: string,
  id: string,
  opts: { root?: string; linkNodeModules?: boolean } = {},
): Promise<WorktreeHandle> {
  if (!isValidWorktreeId(id)) throw new Error(`invalid worktree id: ${JSON.stringify(id)}`);
  const top = await gitTopLevelOf(repoRoot);
  if (!top) throw new Error(`not a git repository root: ${repoRoot}`);
  const root = resolve(opts.root ?? worktreesRoot());
  const path = join(root, id);
  assertInside(root, path);
  if (existsSync(path)) throw new Error(`worktree path already exists: ${path}`);
  mkdirSync(root, { recursive: true });

  const branch = `${WORKTREE_BRANCH_PREFIX}${id}`;
  const baseSha = await revParse(top, 'HEAD');
  if (!baseSha) throw new Error(`repository has no HEAD commit: ${top}`);
  // Owned BEFORE git creates it so no reaper can see a half-born worktree as
  // abandoned.
  live.set(id, root);
  writeFileSync(pidFile(root, id), String(process.pid));
  try {
    await mustGit(top, ['worktree', 'add', '-b', branch, path, baseSha], 'mutate');
  } catch (err) {
    releaseWorktree(id);
    throw err;
  }
  if (opts.linkNodeModules !== false) await linkNodeModules(top, path);
  coreLogger.info({ id, repoRoot: top, path, branch }, 'Swarm worktree created');
  return { id, repoRoot: top, path, branch, baseSha };
}

const SHIM = 'node_modules';
const EXCLUDE_LINE = '/node_modules';

/**
 * Make `<wt>/node_modules` a single symlink to `<repo>/node_modules`, so the
 * child's builds and tests find the dependencies already installed.
 *
 * SHARED, not isolated: anything the child installs or deletes there lands in
 * the user's real `node_modules` — the reason `swarm.worktreeLinkNodeModules`
 * can turn it off.
 *
 * A symlink is not matched by the common `node_modules/` ignore pattern
 * (trailing slash = directories only), so `/node_modules` is added to the
 * exclude file git reports for the worktree (`rev-parse --git-path
 * info/exclude`). Git keeps `info/` in the COMMON dir, so that file is the
 * repo's own `.git/info/exclude`: the line also applies to the main tree,
 * where it only ignores an UNTRACKED root `node_modules` (tracked files are
 * unaffected). Written once, with a comment saying who added it, and only
 * when the symlink is not already ignored. If it still is not ignored, the
 * symlink is removed rather than risk committing it.
 */
async function linkNodeModules(repoRoot: string, wt: string): Promise<void> {
  const src = join(repoRoot, SHIM);
  const dest = join(wt, SHIM);
  try {
    if (!existsSync(src) || !statSync(src).isDirectory() || existsSync(dest)) return;
    symlinkSync(src, dest, 'dir');
    if ((await git(wt, ['check-ignore', '-q', SHIM])).ok) return;
    const rel = (await mustGit(wt, ['rev-parse', '--git-path', 'info/exclude'])).trim();
    const excludeFile = resolve(wt, rel);
    const current = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf-8') : '';
    if (!current.split('\n').some((l) => l.trim() === EXCLUDE_LINE)) {
      mkdirSync(dirname(excludeFile), { recursive: true });
      const lead = current && !current.endsWith('\n') ? '\n' : '';
      appendFileSync(
        excludeFile,
        `${lead}# Added by Octipus swarm worktrees: keeps their node_modules symlink out of git status\n${EXCLUDE_LINE}\n`,
      );
    }
    if (!(await git(wt, ['check-ignore', '-q', SHIM])).ok) {
      coreLogger.warn({ wt }, 'Swarm worktree: node_modules symlink is not ignored — removed');
      removeShim(repoRoot, wt);
    }
  } catch (err) {
    coreLogger.warn({ err, wt }, 'Swarm worktree: node_modules symlink not created');
    removeShim(repoRoot, wt);
  }
}

/** Unlink the shim — only a symlink pointing at the repo's node_modules, never a real directory. */
function removeShim(repoRoot: string, wt: string): void {
  const dest = join(wt, SHIM);
  try {
    const st = lstatSync(dest, { throwIfNoEntry: false });
    if (!st?.isSymbolicLink()) return;
    if (resolve(wt, readlinkSync(dest)) !== resolve(repoRoot, SHIM)) return;
    unlinkSync(dest);
  } catch (err) {
    coreLogger.warn({ err, wt }, 'Swarm worktree: could not remove node_modules symlink');
  }
}

/**
 * Collect what the child produced, and — when `merge` is set and it is safe —
 * merge its branch into the project's current branch.
 *
 * Uncommitted changes are committed on the child's branch first, so a child
 * that simply edited files (most CLI agents never commit) is captured too.
 */
export async function finishWorktree(
  h: WorktreeHandle,
  opts: { merge: boolean; skipReason?: WorktreeMergeOutcome; label?: string },
): Promise<WorktreeReport> {
  const report: WorktreeReport = {
    branch: h.branch,
    worktreePath: h.path,
    baseSha: h.baseSha,
    headSha: h.baseSha,
    diffStat: '',
    filesChanged: 0,
    merge: 'no_changes',
    branchKept: true,
  };

  // The child may have moved its worktree onto another ref. Its work is then
  // not where the report and the merge would look: say so, change nothing, and
  // let `removeWorktree` pin that HEAD before any clean-up.
  const onBranch = (await git(h.path, ['symbolic-ref', '-q', 'HEAD'])).stdout.trim();
  if (onBranch !== `refs/heads/${h.branch}`) {
    report.headSha = (await revParse(h.path, 'HEAD')) ?? h.baseSha;
    report.merge = 'failed';
    report.mergeDetail = `worktree HEAD is no longer on ${h.branch} (${onBranch || 'detached'})`;
    return report;
  }

  if (await hasUncommitted(h.path)) {
    // The node_modules symlink is excluded by `linkNodeModules` (or was never
    // made), so a plain `add -A` cannot pick it up. An explicit exclude
    // pathspec would make git fail on the ignored path instead.
    await mustGit(h.path, ['add', '-A'], 'mutate');
    const staged = await git(h.path, ['diff', '--cached', '--quiet']);
    if (!staged.ok) {
      await mustGit(
        h.path,
        [
          'commit',
          '--no-verify',
          '-m',
          `octipus: uncommitted work from swarm child ${h.id}${opts.label ? `\n\n${opts.label}` : ''}`,
        ],
        'mutate',
      );
    }
  }

  report.headSha = (await mustGit(h.path, ['rev-parse', 'HEAD'])).trim();
  if (report.headSha === h.baseSha) return report;

  report.diffStat = (await mustGit(h.path, ['diff', '--shortstat', h.baseSha, report.headSha])).trim();
  report.filesChanged = (await mustGit(h.path, ['diff', '--name-only', h.baseSha, report.headSha]))
    .split('\n')
    .filter(Boolean).length;

  if (!opts.merge) {
    report.merge = opts.skipReason ?? 'skipped_status';
    return report;
  }
  const merged = await withRepoLock(h.repoRoot, () => mergeInto(h));
  report.merge = merged.outcome;
  report.mergeDetail = merged.detail;
  return report;
}

async function abortIfMerging(repo: string): Promise<string | null> {
  if (!(await git(repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).ok) return null;
  const abort = await git(repo, ['merge', '--abort'], 'mutate');
  if (abort.ok) return 'aborted';
  coreLogger.error({ repo, stderr: abort.stderr }, 'Swarm worktree: merge --abort failed');
  return `abort FAILED: ${abort.stderr.trim()}`;
}

async function mergeInto(h: WorktreeHandle): Promise<{ outcome: WorktreeMergeOutcome; detail?: string }> {
  const repo = h.repoRoot;
  const head = await git(repo, ['symbolic-ref', '-q', '--short', 'HEAD']);
  const target = head.stdout.trim();
  if (!head.ok || !target) return { outcome: 'skipped_detached', detail: 'project is not on a branch' };
  if (await hasTrackedChanges(repo)) {
    return { outcome: 'skipped_dirty', detail: 'project has uncommitted changes or a merge in progress' };
  }
  // The project must still contain the commit the child started from. If the
  // user reset or switched branches meanwhile, merging would drag the child's
  // whole base history into a branch that deliberately dropped it.
  if (!(await isAncestor(repo, h.baseSha, 'HEAD'))) {
    return { outcome: 'skipped_moved', detail: `${target} no longer contains the base ${h.baseSha.slice(0, 12)}` };
  }
  const r = await git(repo, ['merge', '--no-ff', '--no-edit', h.branch], 'mutate');
  if (r.ok) return { outcome: 'merged', detail: target };
  const aborted = await abortIfMerging(repo);
  if (aborted) {
    const why = r.timedOut ? 'merge timed out' : `merge conflict into ${target}`;
    return { outcome: 'conflict', detail: `${why}; ${aborted}, branch kept` };
  }
  // Refused before starting (e.g. it would overwrite untracked files): nothing to abort.
  return { outcome: 'failed', detail: (r.timedOut ? 'merge timed out' : (r.stderr || r.stdout).trim()).slice(0, 500) };
}

/**
 * Make sure the worktree's HEAD commit outlives the worktree. Fine as-is when
 * some local branch contains it; else fast-forward `octipus/<id>` onto it when
 * that is a fast-forward; else pin it with `octipus/<id>-detached`.
 */
async function protectHead(
  h: Pick<WorktreeHandle, 'repoRoot' | 'path' | 'branch'>,
): Promise<{ ok: true; keptRef?: string } | { ok: false; reason: string }> {
  const sha = await revParse(h.path, 'HEAD');
  if (!sha) return { ok: false, reason: 'cannot read the worktree HEAD' };
  const containing = await git(h.repoRoot, ['for-each-ref', '--contains', sha, '--format=%(refname)', 'refs/heads/']);
  if (!containing.ok) return { ok: false, reason: 'cannot tell which branches contain the worktree HEAD' };
  if (containing.stdout.trim()) return { ok: true };

  const branchRef = `refs/heads/${h.branch}`;
  const branchSha = await revParse(h.repoRoot, branchRef);
  if (branchSha && (await isAncestor(h.repoRoot, branchSha, sha))) {
    // Compare-and-set: moves the branch only if nobody moved it meanwhile.
    if ((await git(h.repoRoot, ['update-ref', branchRef, sha, branchSha], 'mutate')).ok) {
      return { ok: true, keptRef: h.branch };
    }
  }
  const keep = `${h.branch}-detached`;
  // Empty old value: create only if the ref does not exist yet.
  if ((await git(h.repoRoot, ['update-ref', `refs/heads/${keep}`, sha, ''], 'mutate')).ok) {
    return { ok: true, keptRef: keep };
  }
  if ((await revParse(h.repoRoot, `refs/heads/${keep}`)) === sha) return { ok: true, keptRef: keep };
  return { ok: false, reason: `worktree HEAD ${sha.slice(0, 12)} is on no branch and could not be pinned` };
}

/**
 * Remove the worktree directory, and the branch only when it was merged.
 * Refuses while the HEAD commit would become unreachable or anything is
 * uncommitted; `--force` only after both checks pass (ignored build output is
 * the usual reason a plain remove refuses).
 */
export async function removeWorktree(
  h: Pick<WorktreeHandle, 'id' | 'repoRoot' | 'path' | 'branch'>,
  opts: { merged: boolean },
): Promise<{ removed: boolean; branchDeleted: boolean; keptRef?: string; reason?: string }> {
  let keptRef: string | undefined;
  if (existsSync(h.path)) {
    const protectedHead = await protectHead(h);
    if (!protectedHead.ok) {
      coreLogger.warn({ path: h.path, reason: protectedHead.reason }, 'Swarm worktree kept');
      return { removed: false, branchDeleted: false, reason: protectedHead.reason };
    }
    keptRef = protectedHead.keptRef;
    if (await hasUncommitted(h.path)) {
      coreLogger.warn({ path: h.path }, 'Swarm worktree kept: uncommitted changes');
      return { removed: false, branchDeleted: false, keptRef, reason: 'uncommitted changes' };
    }
    removeShim(h.repoRoot, h.path);
    let r = await git(h.repoRoot, ['worktree', 'remove', h.path], 'mutate');
    if (!r.ok && !(await hasUncommitted(h.path))) {
      r = await git(h.repoRoot, ['worktree', 'remove', '--force', h.path], 'mutate');
    }
    if (!r.ok) {
      coreLogger.warn({ path: h.path, stderr: r.stderr }, 'Swarm worktree kept: git refused to remove it');
      return { removed: false, branchDeleted: false, keptRef, reason: r.stderr.trim() };
    }
  } else {
    await git(h.repoRoot, ['worktree', 'prune'], 'mutate');
  }
  let branchDeleted = false;
  // `-d`, never `-D`: git re-checks the branch is merged and refuses otherwise.
  // Never when the branch itself was just moved to keep detached work.
  if (opts.merged && keptRef !== h.branch) {
    branchDeleted = (await git(h.repoRoot, ['branch', '-d', h.branch], 'mutate')).ok;
  }
  releaseWorktree(h.id);
  return { removed: true, branchDeleted, keptRef };
}

/**
 * `metadata.worktreePath` as a CLI cwd, or undefined. Accepted only when it is
 * an existing directory directly under the worktrees root — metadata is an
 * open bag, and a cwd override must not be a way to point an agent anywhere.
 */
export function worktreeCwdOverride(
  metadata: Record<string, unknown> | undefined,
  root: string = worktreesRoot(),
): string | undefined {
  const p = metadata?.worktreePath;
  if (typeof p !== 'string' || !isAbsolute(p)) return undefined;
  const abs = resolve(p);
  if (dirname(abs) !== resolve(root) || !isValidWorktreeId(basename(abs))) return undefined;
  try {
    return statSync(abs).isDirectory() ? abs : undefined;
  } catch {
    return undefined;
  }
}

/** Keep CLI cwd and registered tool paths in the same inherited or owned tree. */
export function inheritedTreeMetadata(worktreePath: string): Record<string, string> {
  return { worktreePath, projectPath: worktreePath };
}

export interface StaleWorktreeResult {
  pruned: string[];
  reported: Array<{ id: string; path: string; reason: string }>;
}

/**
 * Orphan-reaper pass over worktrees whose owner is gone (not running in this
 * process, no live owner pid). One is removed only when ALL hold: it is clean,
 * its HEAD is contained in the project's HEAD, and its branch (if any) is
 * merged there. Everything else is REPORTED, never deleted.
 */
export async function reapStaleWorktrees(
  opts: { root?: string; minAgeMs?: number; now?: number } = {},
): Promise<StaleWorktreeResult> {
  const root = resolve(opts.root ?? worktreesRoot());
  const minAgeMs = opts.minAgeMs ?? 60 * 60_000;
  const now = opts.now ?? Date.now();
  const out: StaleWorktreeResult = { pruned: [], reported: [] };
  if (!existsSync(root)) return out;

  for (const ent of readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory() || !isValidWorktreeId(ent.name)) continue;
    if (ownedByLiveProcess(root, ent.name)) continue;
    const path = join(root, ent.name);
    const report = (reason: string) => out.reported.push({ id: ent.name, path, reason });
    try {
      if (now - statSync(path).mtimeMs < minAgeMs) continue;
      const common = await git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
      if (!common.ok || basename(common.stdout.trim()) !== '.git') {
        report('not a git worktree of a non-bare repository');
        continue;
      }
      const repoRoot = dirname(common.stdout.trim());
      const branch = `${WORKTREE_BRANCH_PREFIX}${ent.name}`;
      if (await hasUncommitted(path)) {
        report('uncommitted changes');
        continue;
      }
      const wtHead = await revParse(path, 'HEAD');
      if (!wtHead || !(await isAncestor(repoRoot, wtHead, 'HEAD'))) {
        report(`worktree HEAD ${wtHead?.slice(0, 12) ?? '?'} is not merged into ${repoRoot}`);
        continue;
      }
      if ((await revParse(repoRoot, `refs/heads/${branch}`)) && !(await isAncestor(repoRoot, branch, 'HEAD'))) {
        report(`branch ${branch} is not merged into ${repoRoot}`);
        continue;
      }
      const r = await removeWorktree({ id: ent.name, repoRoot, path, branch }, { merged: true });
      if (r.removed) {
        rmSync(pidFile(root, ent.name), { force: true });
        out.pruned.push(ent.name);
      } else report(r.reason ?? 'git worktree remove refused');
    } catch (err) {
      report((err as Error).message);
    }
  }
  if (out.pruned.length || out.reported.length) {
    coreLogger.info(
      { pruned: out.pruned, reported: out.reported.slice(0, 10) },
      'Swarm worktree reaper — pruned merged worktrees, kept the rest',
    );
  }
  return out;
}
