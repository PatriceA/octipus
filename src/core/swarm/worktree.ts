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
 * - Every git call is an ARGUMENT VECTOR through `execFile`, never a shell
 *   string (same rule as `session-changes.ts#runGit`). The only caller-supplied
 *   value that reaches a path or ref name is the worktree id, and it is
 *   validated to `[A-Za-z0-9_-]` first.
 * - Server-initiated commits and merges run with hooks disabled and signing
 *   off: the server must not execute scripts the repo (or an agent) planted.
 * - A merge into the parent tree is attempted ONLY when that tree is on a
 *   branch, clean (tracked files) and not mid-merge. A conflict is aborted with
 *   `git merge --abort`; the branch is kept. Nothing is ever force-pushed, and
 *   a branch is deleted only with `git branch -d`, which git itself refuses for
 *   unmerged work.
 * - `git worktree remove --force` is used only by the server's own clean-up,
 *   and only after confirming the worktree has nothing uncommitted.
 *
 * Dependencies: a fresh worktree has no `node_modules`. When the repo root has
 * one, `createWorktree` builds a `node_modules` DIRECTORY in the worktree whose
 * entries are symlinks into the root's. A directory (not a single symlink) so
 * the common `node_modules/` ignore pattern — which matches directories only —
 * keeps it out of `git status`; if the repo does not ignore it at all, the shim
 * is removed again rather than risk committing it.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { coreLogger } from '@/utils/logger';

export const WORKTREE_BRANCH_PREFIX = 'octipus/';

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
// Leading alphanumeric so an id can never read as an option (`-f`).
const VALID_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * Identity and switches for every commit/merge the SERVER makes. `-c` rather
 * than repo config so nothing about the user's repo is changed, and so a repo
 * with no `user.name` configured still commits.
 */
const SERVER_GIT_CONFIG = [
  '-c', 'user.name=Octipus agent',
  '-c', 'user.email=octipus-agent@localhost',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'commit.gpgsign=false',
];

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

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function runGit(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((done) => {
    execFile(
      'git',
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, encoding: 'utf-8' },
      (err, stdout, stderr) => done({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? '' }),
    );
  });
}

async function mustGit(cwd: string, args: string[]): Promise<string> {
  const r = await runGit(cwd, args);
  if (!r.ok) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

/**
 * The canonical repo root when `dir` IS a git top level, else null. A directory
 * nested inside a larger repo does not qualify — isolating a sub-folder would
 * branch (and merge) the whole enclosing repo.
 */
export async function gitTopLevelOf(dir: string): Promise<string | null> {
  if (!dir || !existsSync(dir)) return null;
  const r = await runGit(dir, ['rev-parse', '--show-toplevel']);
  if (!r.ok) return null;
  try {
    const [top, self] = await Promise.all([realpath(r.stdout.trim()), realpath(dir)]);
    return top === self ? top : null;
  } catch {
    return null;
  }
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
  | 'skipped_status'
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
}

/** Worktree ids owned by a child that is still running in this process. */
const live = new Set<string>();

export function isWorktreeLive(id: string): boolean {
  return live.has(id);
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
  opts: { root?: string } = {},
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
  const baseSha = (await mustGit(top, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  // Registered BEFORE git creates it so the stale reaper can never see a
  // half-born worktree as abandoned.
  live.add(id);
  try {
    await mustGit(top, ['worktree', 'add', '-b', branch, path, baseSha]);
  } catch (err) {
    live.delete(id);
    throw err;
  }
  linkNodeModules(top, path);
  await dropShimIfNotIgnored(path);
  coreLogger.info({ id, repoRoot: top, path, branch }, 'Swarm worktree created');
  return { id, repoRoot: top, path, branch, baseSha };
}

const SHIM = 'node_modules';

/** Build `<wt>/node_modules/<entry> -> <repo>/node_modules/<entry>` links. */
function linkNodeModules(repoRoot: string, wt: string): void {
  const src = join(repoRoot, SHIM);
  const dest = join(wt, SHIM);
  try {
    if (!existsSync(src) || !statSync(src).isDirectory() || existsSync(dest)) return;
    mkdirSync(dest);
    for (const entry of readdirSync(src)) {
      symlinkSync(join(src, entry), join(dest, entry));
    }
  } catch (err) {
    coreLogger.warn({ err, wt }, 'Swarm worktree: node_modules shim not created');
  }
}

async function dropShimIfNotIgnored(wt: string): Promise<void> {
  const dest = join(wt, SHIM);
  if (!existsSync(dest)) return;
  const r = await runGit(wt, ['check-ignore', '-q', SHIM]);
  if (!r.ok) {
    coreLogger.warn({ wt }, 'Swarm worktree: node_modules is not git-ignored in this repo — shim removed');
    removeShim(wt);
  }
}

/** Remove the shim: a real dir of symlinks, so `rm -r` never follows into the targets. */
function removeShim(wt: string): void {
  const dest = join(wt, SHIM);
  try {
    // Only a shim WE made: a real directory whose every entry is a symlink.
    const st = statSync(dest, { throwIfNoEntry: false });
    if (!st?.isDirectory()) return;
    const entries = readdirSync(dest, { withFileTypes: true });
    if (!entries.every((e) => e.isSymbolicLink())) return;
    rmSync(dest, { recursive: true, force: true });
  } catch (err) {
    coreLogger.warn({ err, wt }, 'Swarm worktree: could not remove node_modules shim');
  }
}

async function hasUncommitted(cwd: string): Promise<boolean> {
  const r = await runGit(cwd, ['status', '--porcelain']);
  return !r.ok || r.stdout.trim().length > 0;
}

/**
 * Collect what the child produced, and — when `merge` is set and it is safe —
 * merge its branch into the parent tree's current branch.
 *
 * Uncommitted changes are committed on the child's branch first, so a child
 * that simply edited files (most CLI agents never commit) is captured too.
 */
export async function finishWorktree(
  h: WorktreeHandle,
  opts: { merge: boolean; label?: string },
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
  // not where the report and the merge would look, so say so and do nothing.
  const onBranch = (await runGit(h.path, ['symbolic-ref', '-q', 'HEAD'])).stdout.trim();
  if (onBranch !== `refs/heads/${h.branch}`) {
    report.merge = 'failed';
    report.mergeDetail = `worktree HEAD is no longer on ${h.branch} (${onBranch || 'detached'})`;
    return report;
  }

  if (await hasUncommitted(h.path)) {
    await mustGit(h.path, ['add', '-A', '--', '.', `:(exclude)${SHIM}`]);
    const staged = await runGit(h.path, ['diff', '--cached', '--quiet']);
    if (!staged.ok) {
      await mustGit(h.path, [
        ...SERVER_GIT_CONFIG,
        'commit',
        '--no-verify',
        '-m',
        `octipus: uncommitted work from swarm child ${h.id}${opts.label ? `\n\n${opts.label}` : ''}`,
      ]);
    }
  }

  report.headSha = (await mustGit(h.path, ['rev-parse', 'HEAD'])).trim();
  if (report.headSha === h.baseSha) return report;

  report.diffStat = (await mustGit(h.path, ['diff', '--shortstat', h.baseSha, report.headSha])).trim();
  report.filesChanged = (await mustGit(h.path, ['diff', '--name-only', h.baseSha, report.headSha]))
    .split('\n')
    .filter(Boolean).length;

  if (!opts.merge) {
    report.merge = 'skipped_status';
    return report;
  }
  const merged = await withRepoLock(h.repoRoot, () => mergeInto(h));
  report.merge = merged.outcome;
  report.mergeDetail = merged.detail;
  return report;
}

async function mergeInto(h: WorktreeHandle): Promise<{ outcome: WorktreeMergeOutcome; detail?: string }> {
  const repo = h.repoRoot;
  const head = await runGit(repo, ['symbolic-ref', '-q', '--short', 'HEAD']);
  if (!head.ok || !head.stdout.trim()) return { outcome: 'skipped_detached', detail: 'parent tree is not on a branch' };
  if ((await runGit(repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).ok) {
    return { outcome: 'skipped_dirty', detail: 'parent tree has a merge in progress' };
  }
  const status = await runGit(repo, ['status', '--porcelain', '--untracked-files=no']);
  if (!status.ok || status.stdout.trim()) {
    return { outcome: 'skipped_dirty', detail: 'parent tree has uncommitted changes' };
  }
  const r = await runGit(repo, [...SERVER_GIT_CONFIG, 'merge', '--no-ff', '--no-edit', h.branch]);
  if (r.ok) return { outcome: 'merged', detail: head.stdout.trim() };
  if ((await runGit(repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).ok) {
    const abort = await runGit(repo, ['merge', '--abort']);
    if (!abort.ok) {
      coreLogger.error({ repo, branch: h.branch, stderr: abort.stderr }, 'Swarm worktree: merge --abort failed');
      return { outcome: 'conflict', detail: `merge conflict; abort FAILED: ${abort.stderr.trim()}` };
    }
    return { outcome: 'conflict', detail: `merge conflict into ${head.stdout.trim()}; aborted, branch kept` };
  }
  // Refused before starting (e.g. it would overwrite untracked files): nothing to abort.
  return { outcome: 'failed', detail: (r.stderr || r.stdout).trim().slice(0, 500) };
}

/**
 * Remove the worktree directory, and the branch only when it was merged.
 * `--force` only when the tree has nothing uncommitted (ignored files such as
 * build output are the usual reason a plain remove refuses).
 */
export async function removeWorktree(
  h: Pick<WorktreeHandle, 'id' | 'repoRoot' | 'path' | 'branch'>,
  opts: { merged: boolean },
): Promise<{ removed: boolean; branchDeleted: boolean }> {
  let removed = false;
  let branchDeleted = false;
  try {
    if (existsSync(h.path)) {
      removeShim(h.path);
      let r = await runGit(h.repoRoot, ['worktree', 'remove', h.path]);
      if (!r.ok && !(await hasUncommitted(h.path))) {
        r = await runGit(h.repoRoot, ['worktree', 'remove', '--force', h.path]);
      }
      removed = r.ok;
      if (!r.ok) coreLogger.warn({ path: h.path, stderr: r.stderr }, 'Swarm worktree kept: not clean');
    } else {
      await runGit(h.repoRoot, ['worktree', 'prune']);
      removed = true;
    }
    if (removed && opts.merged) {
      // `-d`, never `-D`: git re-checks the branch is merged and refuses otherwise.
      branchDeleted = (await runGit(h.repoRoot, ['branch', '-d', h.branch])).ok;
    }
  } finally {
    if (removed) live.delete(h.id);
  }
  return { removed, branchDeleted };
}

/** Stop treating a worktree as live without removing it (it is kept for a human). */
export function releaseWorktree(id: string): void {
  live.delete(id);
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

export interface StaleWorktreeResult {
  pruned: string[];
  reported: Array<{ id: string; path: string; reason: string }>;
}

/**
 * Orphan-reaper pass: worktrees under the data dir whose child is no longer
 * running in this process. Merged and clean → removed with their branch.
 * Anything else is REPORTED, never deleted: unmerged work is the user's.
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
    if (!ent.isDirectory() || !isValidWorktreeId(ent.name) || live.has(ent.name)) continue;
    const path = join(root, ent.name);
    const report = (reason: string) => out.reported.push({ id: ent.name, path, reason });
    try {
      // Another process may own a young one; only old ones are ours to judge.
      if (now - statSync(path).mtimeMs < minAgeMs) continue;
      const common = await runGit(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
      if (!common.ok || basename(common.stdout.trim()) !== '.git') {
        report('not a git worktree of a non-bare repository');
        continue;
      }
      const repoRoot = dirname(common.stdout.trim());
      const branch = `${WORKTREE_BRANCH_PREFIX}${ent.name}`;
      removeShim(path);
      if (await hasUncommitted(path)) {
        report('uncommitted changes');
        continue;
      }
      const merged = await runGit(repoRoot, ['merge-base', '--is-ancestor', branch, 'HEAD']);
      if (!merged.ok) {
        report(`branch ${branch} is not merged into ${repoRoot}`);
        continue;
      }
      const r = await removeWorktree({ id: ent.name, repoRoot, path, branch }, { merged: true });
      if (r.removed) out.pruned.push(ent.name);
      else report('git worktree remove refused');
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
