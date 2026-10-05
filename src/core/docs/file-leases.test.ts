/**
 * File leases (docs/plans/coworking-spec.md §7.5, §7.6 tests): acquire,
 * renew, expire, directory operations (prefix matching on whole segments),
 * an agent refused while a member edits, normalized paths, and the
 * per-path compare-and-write mutex.
 *
 * Backed by ephemeral PGlite.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;

const ben = randomUUID();
const ana = randomUUID();
let spaceId: string;
const changed: string[] = [];

const benHuman = { userId: ben, kind: 'human' as const };
const anaHuman = { userId: ana, kind: 'human' as const };
const anaAgent = { userId: ana, kind: 'agent' as const, agentId: 'agent-7' };

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-file-leases-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: ben, username: 'ben' }, { id: ana, username: 'ana' }]);
  const { spaceWith } = await import('@/test-helpers/space-fixtures');
  spaceId = await spaceWith(ben, [[ana, 'editor']]);
  const { setLeaseChangeListener } = await import('./file-leases');
  setLeaseChangeListener((ws) => changed.push(ws));
}, 120_000);

afterAll(async () => {
  const { _stopLeaseSweeperForTests } = await import('./file-leases');
  _stopLeaseSweeperForTests();
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

async function expireNow(path: string): Promise<void> {
  const { queryRaw } = await import('@/db/postgres');
  await queryRaw(`UPDATE file_leases SET expires_at = now() - interval '1 second' WHERE workspace_id = $1 AND path = $2`, [spaceId, path]);
}

describe('paths', () => {
  test('are normalized relative to the space root, and may not leave it', async () => {
    const { normalizeLeasePath } = await import('./file-leases');
    expect(normalizeLeasePath('docs//plan.md')).toBe('docs/plan.md');
    expect(normalizeLeasePath('./docs/./plan.md/')).toBe('docs/plan.md');
    expect(normalizeLeasePath('/docs/plan.md')).toBe('docs/plan.md');
    expect(normalizeLeasePath('docs\\plan.md')).toBe('docs/plan.md');
    expect(normalizeLeasePath('/srv/spaces/x/files/docs/plan.md', '/srv/spaces/x/files')).toBe('docs/plan.md');
    expect(() => normalizeLeasePath('/etc/passwd', '/srv/spaces/x/files')).toThrow(/outside/);
    expect(() => normalizeLeasePath('docs/../../etc')).toThrow(/outside/);
    expect(() => normalizeLeasePath('.')).toThrow(/root/);
  });
});

describe('leases', () => {
  test('acquire, see it held, renew it, release it', async () => {
    const { acquireLease, listLeases, leaseViews, renewLease, releaseLease } = await import('./file-leases');
    const first = await acquireLease(spaceId, 'notes/a.md', benHuman);
    expect(first.ok).toBe(true);
    expect(changed).toContain(spaceId);

    const other = await acquireLease(spaceId, 'notes/a.md', anaHuman);
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.heldBy[0].holderUserId).toBe(ben);
    const views = await leaseViews(await listLeases(spaceId));
    expect(views).toEqual([expect.objectContaining({ path: 'notes/a.md', holderName: 'ben', holderKind: 'human' })]);

    if (!first.ok) throw new Error('unreachable');
    const renewed = await renewLease(spaceId, 'notes/a.md', benHuman);
    expect(renewed?.expiresAt.getTime()).toBeGreaterThanOrEqual(first.lease.expiresAt.getTime());
    expect(await renewLease(spaceId, 'notes/a.md', anaHuman)).toBeNull();

    expect(await releaseLease(spaceId, 'notes/a.md', anaHuman)).toBe(false);
    expect(await releaseLease(spaceId, 'notes/a.md', benHuman)).toBe(true);
    expect((await acquireLease(spaceId, 'notes/a.md', anaHuman)).ok).toBe(true);
    await releaseLease(spaceId, 'notes/a.md', anaHuman);
  });

  test('an expired lease no longer holds, cannot be renewed, and is swept', async () => {
    const { acquireLease, expireLeases, listLeases, renewLease } = await import('./file-leases');
    expect((await acquireLease(spaceId, 'b.txt', benHuman)).ok).toBe(true);
    await expireNow('b.txt');
    expect(await listLeases(spaceId)).toEqual([]);
    expect(await renewLease(spaceId, 'b.txt', benHuman)).toBeNull();
    changed.length = 0;
    expect(await expireLeases()).toEqual([spaceId]);
    expect(changed).toEqual([spaceId]);
    const taken = await acquireLease(spaceId, 'b.txt', anaHuman);
    expect(taken.ok).toBe(true);
    const { releaseLease } = await import('./file-leases');
    await releaseLease(spaceId, 'b.txt', anaHuman);
  });

  test('directory operations: a lease anywhere under a directory blocks it, a directory lease covers its files', async () => {
    const { acquireLease, assertNoLeaseConflict, FileLeaseConflictError, leaseConflicts, releaseLease } = await import('./file-leases');
    expect((await acquireLease(spaceId, 'reports/q3/summary.md', benHuman)).ok).toBe(true);
    // Writing a sibling is fine; deleting or moving the parent is not.
    expect(await leaseConflicts(spaceId, 'reports/q3/other.md', anaAgent)).toEqual([]);
    await expect(assertNoLeaseConflict(spaceId, 'reports', anaAgent, { recursive: true })).rejects.toBeInstanceOf(FileLeaseConflictError);
    await expect(assertNoLeaseConflict(spaceId, 'reports/q3', anaAgent, { recursive: true })).rejects.toBeInstanceOf(FileLeaseConflictError);
    // Whole segments: `reports/q3x` is not under `reports/q3`.
    expect(await leaseConflicts(spaceId, 'reports/q3x', anaAgent, { recursive: true })).toEqual([]);
    // A directory cannot be leased over someone's file inside it.
    expect((await acquireLease(spaceId, 'reports', anaHuman)).ok).toBe(false);
    await releaseLease(spaceId, 'reports/q3/summary.md', benHuman);

    expect((await acquireLease(spaceId, 'drafts', benHuman)).ok).toBe(true);
    await expect(assertNoLeaseConflict(spaceId, 'drafts/deep/file.md', anaAgent)).rejects.toBeInstanceOf(FileLeaseConflictError);
    expect((await acquireLease(spaceId, 'drafts/deep/file.md', anaHuman)).ok).toBe(false);
    await releaseLease(spaceId, 'drafts', benHuman);
  });

  test("an agent is refused while a member edits — even its own member's", async () => {
    const { acquireLease, assertNoLeaseConflict, FileLeaseConflictError, releaseLease } = await import('./file-leases');
    expect((await acquireLease(spaceId, 'plan.md', anaHuman)).ok).toBe(true);
    const refused = await assertNoLeaseConflict(spaceId, 'plan.md', anaAgent).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(FileLeaseConflictError);
    expect((refused as InstanceType<typeof FileLeaseConflictError>).leases[0].holderUserId).toBe(ana);
    // The holder itself passes.
    await expect(assertNoLeaseConflict(spaceId, 'plan.md', anaHuman)).resolves.toBeUndefined();
    await releaseLease(spaceId, 'plan.md', anaHuman);
    await expect(assertNoLeaseConflict(spaceId, 'plan.md', anaAgent)).resolves.toBeUndefined();
  });

  test('a removed member loses their leases', async () => {
    const { acquireLease, dropMemberLeases, listLeases } = await import('./file-leases');
    expect((await acquireLease(spaceId, 'mine.md', anaHuman)).ok).toBe(true);
    expect(await dropMemberLeases(spaceId, ana)).toBe(1);
    expect((await listLeases(spaceId)).map((l) => l.path)).not.toContain('mine.md');
  });

  test('compare-and-write runs one at a time per path', async () => {
    const { withPathLock } = await import('./file-leases');
    const order: string[] = [];
    const slow = withPathLock(spaceId, 'x.md', async () => {
      order.push('a:start');
      await new Promise((r) => setTimeout(r, 30));
      order.push('a:end');
    });
    const fast = withPathLock(spaceId, 'x.md', async () => {
      order.push('b');
    });
    const elsewhere = withPathLock(spaceId, 'y.md', async () => {
      order.push('other');
    });
    await Promise.all([slow, fast, elsewhere]);
    expect(order.indexOf('b')).toBeGreaterThan(order.indexOf('a:end'));
    expect(order.indexOf('other')).toBeLessThan(order.indexOf('a:end'));
  });
});
