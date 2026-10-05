/**
 * File leases (docs/plans/coworking-spec.md §7.5): "Ben is editing" on a
 * space file.
 *
 * A lease names one path, normalized relative to the space's files root,
 * and one holder (a member in the web, or an agent working for one) until
 * `spaces.fileLeaseTtlSeconds` after its last renewal. A lease on a
 * directory covers everything under it; an operation on a directory
 * (recursive delete, move of a parent) conflicts with a lease anywhere
 * under it — prefix matching on whole segments.
 *
 * Lease paths are canonical, like the agent's file paths: a lease taken
 * through a symlinked directory names the real file (`canonicalLeasePath`),
 * and an agent write is checked under both its spelling and its canonical
 * path.
 *
 * The lease is the human-facing signal. The guarantee, for the agent's
 * file tools against leases, is `withPathLocks`: the agent's check and
 * write, and a lease acquisition, each hold the in-process mutex of their
 * path and of every directory above it (single process, D16), so two
 * paths where one contains the other always share a lock — a lease cannot
 * be taken between an agent's check and its write. Shell, git, docker,
 * skill scripts and CLI agents are advisory only — they do not check
 * leases.
 */
import { posix } from 'node:path';
import { getConfig } from '@/config';
import {
  deleteExpiredLeases,
  dropLease,
  dropLeasesOf,
  type LeaseHolder,
  liveLeases,
  liveLeasesUnder,
  takeLease,
  userNames,
} from '@/db/repositories/live-documents';
import type { FileLease } from '@/db/schema/live-documents';
import type { FileLeaseView } from '@/core/gateway/protocol';
import { pathInGuestFolders, type SpaceMembership } from '@/security/space-access';
import { WorkspaceFS, WorkspaceFsError } from '@/security/workspace-fs';
import { coreLogger } from '@/utils/logger';
import { KeyedMutex } from './keyed-mutex';

export type { LeaseHolder } from '@/db/repositories/live-documents';

const logger = coreLogger.child({ component: 'file-leases' });

export class InvalidLeasePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidLeasePathError';
  }
}

/** Someone else holds a lease on the path, a directory above it, or (for a directory operation) a path under it. */
export class FileLeaseConflictError extends Error {
  constructor(readonly leases: FileLease[]) {
    super(`${leases[0]?.path ?? 'The file'} is being edited by someone else`);
    this.name = 'FileLeaseConflictError';
  }
}

/**
 * `input` relative to the space's files root, `/`-separated, without `.`
 * segments or a trailing slash. An absolute path is read as relative to the
 * root, unless `root` is given: then it must lie under it. A path that
 * climbs out of the root is refused.
 */
export function normalizeLeasePath(input: string, root?: string): string {
  if (input.includes('\0')) throw new InvalidLeasePathError('A path cannot contain NUL');
  let path = input.replace(/\\/g, '/').trim();
  if (root) {
    const base = root.replace(/\\/g, '/').replace(/\/+$/, '');
    if (path === base) path = '';
    else if (path.startsWith(`${base}/`)) path = path.slice(base.length + 1);
    else if (path.startsWith('/')) throw new InvalidLeasePathError('The path is outside the space');
  }
  const normalized = posix.normalize(`/${path}`).replace(/^\/+/, '').replace(/\/+$/, '');
  if (!normalized || normalized === '.') throw new InvalidLeasePathError('A lease names a file or directory, not the space root');
  if (posix.normalize(path).split('/')[0] === '..') throw new InvalidLeasePathError('The path is outside the space');
  return normalized;
}

/**
 * `input` as a lease names it: `normalizeLeasePath`, then resolved through
 * the space's files root like the agent's file tools resolve their paths
 * (`WorkspaceFS.resolve`, symlinks followed) and made relative again. A
 * lease taken on `shared/plan.md`, where `shared` links to `projects/x`,
 * names `projects/x/plan.md`: the path the agent's write to either spelling
 * resolves to. A link out of the space is refused.
 */
export function canonicalLeasePath(workspaceId: string, input: string): string {
  const lexical = normalizeLeasePath(input);
  const fs = WorkspaceFS.forSpace(workspaceId);
  let real: string;
  try {
    real = fs.resolve(lexical);
  } catch (err) {
    if (err instanceof WorkspaceFsError) throw new InvalidLeasePathError('The path is outside the space');
    throw err;
  }
  const relative = fs.spaceRelative(real);
  if (relative === null) throw new InvalidLeasePathError('The path is outside the space');
  return normalizeLeasePath(relative);
}

/** The directories above `path` (`a/b/c` → `a`, `a/b`). */
export function ancestorsOf(path: string): string[] {
  const parts = path.split('/');
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
}

const sameHolder = (lease: FileLease, holder: LeaseHolder) =>
  lease.holderUserId === holder.userId && lease.holderKind === holder.kind && (lease.agentId ?? null) === (holder.agentId ?? null);

/**
 * Live leases of other holders that a write to `path` would cross: on the
 * path itself and on every directory above it; with `recursive` (a
 * directory operation) also anywhere under it.
 */
export async function leaseConflicts(workspaceId: string, path: string, holder: LeaseHolder, opts: { recursive?: boolean } = {}): Promise<FileLease[]> {
  // The space root itself (`''`): only an operation on all of it crosses a lease.
  if (path === '') return opts.recursive ? (await liveLeases(workspaceId)).filter((l) => !sameHolder(l, holder)) : [];
  const exact = await liveLeases(workspaceId, [path, ...ancestorsOf(path)]);
  const under = opts.recursive ? await liveLeasesUnder(workspaceId, path) : [];
  const seen = new Set<string>();
  return [...exact, ...under].filter((l) => {
    if (seen.has(l.path) || sameHolder(l, holder)) return false;
    seen.add(l.path);
    return true;
  });
}

/** Throws `FileLeaseConflictError` when `leaseConflicts` finds any. */
export async function assertNoLeaseConflict(workspaceId: string, path: string, holder: LeaseHolder, opts: { recursive?: boolean } = {}): Promise<void> {
  const conflicts = await leaseConflicts(workspaceId, path, holder, opts);
  if (conflicts.length > 0) throw new FileLeaseConflictError(conflicts);
}

/**
 * What an agent is told when a lease refuses its write: who holds which
 * path, and until when (their editor renews it while open). `forUserId`
 * is the member the agent works for: their own lease is named as theirs.
 */
export async function describeLeaseConflict(leases: FileLease[], forUserId?: string): Promise<string> {
  const names = await userNames(leases.map((l) => l.holderUserId));
  const held = leases.map((l) => {
    const who = names.get(l.holderUserId) ?? 'another member';
    const own = l.holderUserId === forUserId;
    const how = l.holderKind === 'human'
      ? (own ? `${who} (the member you work for) is editing it` : `${who} is editing it`)
      : (own ? `another agent working for ${who} (the member you work for) holds it` : `an agent working for ${who} holds it`);
    return `${l.path}: ${how} until ${l.expiresAt.toISOString()} (renewed while they work)`;
  });
  return `Nothing was changed: this space file is leased. ${held.join('; ')}. `
    + 'Wait until the lease is released or expires and try again, or ask them in the space.';
}

/** Refuse (`FileLeaseConflictError`) when a write by `holder` to any of `targets` crosses another holder's lease. */
export async function assertTargetsFree(
  workspaceId: string,
  targets: ReadonlyArray<{ path: string; recursive?: boolean }>,
  holder: LeaseHolder,
): Promise<void> {
  const conflicts: FileLease[] = [];
  for (const target of targets) conflicts.push(...await leaseConflicts(workspaceId, target.path, holder, { recursive: target.recursive }));
  const unique = [...new Map(conflicts.map((l) => [l.path, l])).values()];
  if (unique.length > 0) throw new FileLeaseConflictError(unique);
}

const spaceLocks = new KeyedMutex();
const pathLocks = new KeyedMutex();

/** Run `fn` holding the in-process mutex of exactly one space path key. */
export function withPathLock<T>(workspaceId: string, path: string, fn: () => Promise<T>): Promise<T> {
  return pathLocks.run(`${workspaceId}:${path}`, fn);
}

/**
 * Run `fn` holding the mutex of each of `paths` (a move's source and
 * destination) and of every directory above them: any two paths where one
 * contains the other share a key, so a lease acquisition and an agent
 * write that could cross never interleave. Taken in sorted order, so two
 * calls never wait on each other.
 */
export function withPathLocks<T>(workspaceId: string, paths: readonly string[], fn: () => Promise<T>): Promise<T> {
  const sorted = [...new Set(paths.flatMap((p) => (p === '' ? [p] : [...ancestorsOf(p), p])))].sort();
  const take = (i: number): Promise<T> => (i === sorted.length ? fn() : withPathLock(workspaceId, sorted[i], () => take(i + 1)));
  return take(0);
}

export type AcquireResult = { ok: true; lease: FileLease } | { ok: false; heldBy: FileLease[] };

/**
 * Take the lease on `path` for `holder`, or renew it when the holder has it.
 * Refused while another holder has a live lease on the path, a directory
 * above it or a path under it. Serialized per space, so two overlapping
 * acquisitions cannot both pass the check; and under the path locks of
 * `path` (and of the space root, which a recursive operation on the whole
 * space takes), so an agent write that crosses it is either done before
 * the lease is taken or checks after it.
 */
export async function acquireLease(workspaceId: string, path: string, holder: LeaseHolder): Promise<AcquireResult> {
  const ttl = getConfig().spaces.fileLeaseTtlSeconds;
  const result = await withPathLocks(workspaceId, ['', path], () => spaceLocks.run(workspaceId, async (): Promise<AcquireResult> => {
    await deleteExpiredLeases(workspaceId);
    const conflicts = await leaseConflicts(workspaceId, path, holder, { recursive: true });
    if (conflicts.length > 0) return { ok: false, heldBy: conflicts };
    const lease = await takeLease(workspaceId, path, holder, ttl);
    if (!lease) return { ok: false, heldBy: await liveLeases(workspaceId, [path]) };
    return { ok: true, lease };
  }));
  if (result.ok) {
    ensureSweeper();
    leasesChanged(workspaceId);
  }
  return result;
}

/** Extend `holder`'s lease on `path`; null when they do not hold it (expired and taken, or never had it). */
export async function renewLease(workspaceId: string, path: string, holder: LeaseHolder): Promise<FileLease | null> {
  const held = (await liveLeases(workspaceId, [path])).find((l) => sameHolder(l, holder));
  if (!held) return null;
  const result = await acquireLease(workspaceId, path, holder);
  return result.ok ? result.lease : null;
}

/** Drop `holder`'s lease on `path`. Returns whether there was one. */
export async function releaseLease(workspaceId: string, path: string, holder: LeaseHolder): Promise<boolean> {
  const dropped = await dropLease(workspaceId, path, holder);
  if (dropped) leasesChanged(workspaceId);
  return dropped;
}

/** The space's live leases. */
export function listLeases(workspaceId: string): Promise<FileLease[]> {
  return liveLeases(workspaceId);
}

/** Delete expired leases everywhere; tell each space that lost one. Returns those spaces. */
export async function expireLeases(): Promise<string[]> {
  const spaces = await deleteExpiredLeases();
  for (const workspaceId of spaces) leasesChanged(workspaceId);
  return spaces;
}

/** A member left the space or lost write access: their leases go. */
export async function dropMemberLeases(workspaceId: string, userId: string): Promise<number> {
  const n = await dropLeasesOf(workspaceId, userId);
  if (n > 0) leasesChanged(workspaceId);
  return n;
}

/** The leases as the web shows them. */
export async function leaseViews(leases: FileLease[]): Promise<FileLeaseView[]> {
  const names = await userNames(leases.map((l) => l.holderUserId));
  return leases.map((l) => ({
    path: l.path,
    holderUserId: l.holderUserId,
    holderName: names.get(l.holderUserId) ?? null,
    holderKind: l.holderKind,
    expiresAt: l.expiresAt.toISOString(),
  }));
}

/**
 * The leases as one member sees them: all of them, or for a guest (S6) the
 * leases of their folders only, the holder named only when among the
 * members of their rooms ("someone is editing").
 */
export async function leasesForMember(workspaceId: string, membership: SpaceMembership, leases: FileLease[]): Promise<FileLeaseView[]> {
  const scope = membership.scope;
  if (!scope) return leaseViews(leases);
  const { membersVisibleToGuest } = await import('@/core/spaces/service');
  const visible = await membersVisibleToGuest(workspaceId, membership.userId, scope);
  const views = await leaseViews(leases.filter((l) => pathInGuestFolders(l.path, scope.folders)));
  return views.map((v) => (v.holderUserId && visible.has(v.holderUserId) ? v : { ...v, holderUserId: null, holderName: null }));
}

// ── Change notification ─────────────────────────────────────────

let listener: (workspaceId: string) => void = () => undefined;

/** Set who hears that a space's leases changed (the gateway wiring publishes `file.leases`). */
export function setLeaseChangeListener(fn: (workspaceId: string) => void): void {
  listener = fn;
}

function leasesChanged(workspaceId: string): void {
  try {
    listener(workspaceId);
  } catch (err) {
    logger.error({ err, workspaceId }, 'Publishing a file lease change failed');
  }
}

let sweeper: ReturnType<typeof setInterval> | null = null;

/** Expired leases are swept every 30 s once any lease was taken, so "Ben is editing" goes away on its own. */
function ensureSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => {
    expireLeases().catch((err) => logger.error({ err }, 'Sweeping expired file leases failed'));
  }, 30_000);
  sweeper.unref?.();
}

/** Test hook. */
export function _stopLeaseSweeperForTests(): void {
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
}
