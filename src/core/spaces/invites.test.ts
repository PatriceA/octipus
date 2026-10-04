/**
 * Space invites (docs/plans/coworking-spec.md §5.3, I8): hashed at rest,
 * clamped expiry, a single use under two concurrent accepts, revoke scoped to
 * its own space, preview without content, owner never invitable.
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
process.env.LOG_LEVEL ??= 'error';

const owner = randomUUID();
const alice = randomUUID();
const bob = randomUUID();
const otherOwner = randomUUID();

// biome-ignore lint/suspicious/noExplicitAny: raw rows
type Row = any;
async function q(sql: string, params: unknown[] = []): Promise<Row[]> {
  const { queryRaw } = await import('@/db/postgres');
  return (await queryRaw(sql, params)).rows;
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-invites-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([
    { id: owner, username: 'owner' },
    { id: alice, username: 'alice' },
    { id: bob, username: 'bob' },
    { id: otherOwner, username: 'other' },
  ]);
}, 120_000);

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

async function newSpace(by = owner): Promise<string> {
  const { createSpace } = await import('./service');
  return (await createSpace({ userId: by }, { name: `Space ${rand(3)}` })).id;
}

describe('invites', () => {
  test('only sha256(token) is stored, and listing never returns it', async () => {
    const { createInvite, listInvites } = await import('./invites');
    const { sha256 } = await import('@/utils/crypto');
    const id = await newSpace();
    const invite = await createInvite({ userId: owner }, id, { role: 'editor' });
    expect(invite.token).toMatch(/^[0-9a-f]{64}$/);
    const [row] = await q(`SELECT token_hash FROM workspace_invites WHERE id = $1`, [invite.id]);
    expect(row.token_hash).toBe(sha256(invite.token));
    const stored = await q(`SELECT row_to_json(i)::text AS j FROM workspace_invites i WHERE id = $1`, [invite.id]);
    expect(stored[0].j).not.toContain(invite.token);
    const listed = await listInvites({ userId: owner }, id);
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(invite.token);
    expect(JSON.stringify(listed)).not.toContain(row.token_hash);
  });

  test('expiry is clamped to [1, spaces.inviteMaxTtlHours] hours', async () => {
    const { createInvite, DEFAULT_INVITE_TTL_HOURS } = await import('./invites');
    const { getConfig } = await import('@/config');
    const id = await newSpace();
    const hoursFromNow = (d: Date) => Math.round((d.getTime() - Date.now()) / 3600_000);
    const max = getConfig().spaces.inviteMaxTtlHours;
    expect(hoursFromNow((await createInvite({ userId: owner }, id, { role: 'viewer', expiresInHours: 10 * max })).expiresAt)).toBe(max);
    expect(hoursFromNow((await createInvite({ userId: owner }, id, { role: 'viewer', expiresInHours: 0 })).expiresAt)).toBe(1);
    expect(hoursFromNow((await createInvite({ userId: owner }, id, { role: 'viewer' })).expiresAt)).toBe(Math.min(DEFAULT_INVITE_TTL_HOURS, max));
    expect(hoursFromNow((await createInvite({ userId: owner }, id, { role: 'viewer', expiresInHours: 5 })).expiresAt)).toBe(5);
  });

  test('owner is not invitable; only the owner invites; maxUses is bounded', async () => {
    const { createInvite, acceptInvite } = await import('./invites');
    const id = await newSpace();
    await expect(createInvite({ userId: owner }, id, { role: 'owner' })).rejects.toMatchObject({ code: 'invalid_role' });
    await expect(createInvite({ userId: owner }, id, { role: 'viewer', maxUses: 0 })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(createInvite({ userId: owner }, id, { role: 'viewer', maxUses: 101 })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(createInvite({ userId: alice }, id, { role: 'viewer' })).rejects.toMatchObject({ code: 'not_found' });
    const asEditor = await createInvite({ userId: owner }, id, { role: 'editor' });
    await acceptInvite({ userId: alice }, asEditor.token);
    await expect(createInvite({ userId: alice }, id, { role: 'viewer' })).rejects.toMatchObject({ code: 'forbidden_role' });
  });

  test('a single-use invite admits exactly one of two concurrent accepts', async () => {
    const { createInvite, acceptInvite } = await import('./invites');
    const { getMembership } = await import('./service');
    const id = await newSpace();
    const invite = await createInvite({ userId: owner }, id, { role: 'editor' });
    const results = await Promise.allSettled([
      acceptInvite({ userId: alice }, invite.token),
      acceptInvite({ userId: bob }, invite.token),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'not_found' });
    const joined = [await getMembership(alice, id), await getMembership(bob, id)].filter(Boolean);
    expect(joined).toHaveLength(1);
    const [row] = await q(`SELECT use_count FROM workspace_invites WHERE id = $1`, [invite.id]);
    expect(row.use_count).toBe(1);
  });

  test('the use guard is the conditional UPDATE itself: the last use goes to exactly one accept', async () => {
    // PGlite runs one connection, so two accepts cannot interleave here; what
    // this pins is that the WHERE clause, not a read before it, holds the
    // line: a counter already at the limit refuses, and at limit - 1 exactly
    // one of two accepts gets in. The interleaved race runs on Postgres in
    // concurrency.integration.test.ts.
    const { createInvite, acceptInvite } = await import('./invites');
    const { getMembership } = await import('./service');
    const id = await newSpace();
    const full = await createInvite({ userId: owner }, id, { role: 'viewer', maxUses: 5 });
    await q(`UPDATE workspace_invites SET use_count = max_uses WHERE id = $1`, [full.id]);
    await expect(acceptInvite({ userId: alice }, full.token)).rejects.toMatchObject({ code: 'not_found' });
    expect(await getMembership(alice, id)).toBeNull();

    const last = await createInvite({ userId: owner }, id, { role: 'viewer', maxUses: 5 });
    await q(`UPDATE workspace_invites SET use_count = max_uses - 1 WHERE id = $1`, [last.id]);
    const results = await Promise.allSettled([acceptInvite({ userId: alice }, last.token), acceptInvite({ userId: bob }, last.token)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const [row] = await q(`SELECT use_count, max_uses FROM workspace_invites WHERE id = $1`, [last.id]);
    expect(row.use_count).toBe(row.max_uses);
  });

  test('an owner who is removed, leaves or is demoted takes their invite links with them (I5)', async () => {
    const { createInvite, acceptInvite, previewInvite } = await import('./invites');
    const { removeMember, setRole, leaveSpace, getMembership } = await import('./service');
    const id = await newSpace();
    // Alice becomes a co-owner and hands out a 100-use editor link.
    const joinLink = await createInvite({ userId: owner }, id, { role: 'editor' });
    await acceptInvite({ userId: alice }, joinLink.token);
    await setRole({ userId: owner }, id, alice, { role: 'owner' });
    const hers = await createInvite({ userId: alice }, id, { role: 'editor', maxUses: 100 });

    await removeMember({ userId: owner }, id, alice);
    const [row] = await q(`SELECT revoked_at FROM workspace_invites WHERE id = $1`, [hers.id]);
    expect(row.revoked_at).not.toBeNull();
    const audit = await q(`SELECT user_id, details FROM audit_log WHERE workspace_id = $1 AND action = 'space_invite_revoked' AND resource_id = $2`, [id, hers.id]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ user_id: owner, details: { reason: 'creator_lost_access', createdBy: alice } });
    // She cannot rejoin through her own link, nor can anyone she shared it with.
    await expect(acceptInvite({ userId: alice }, hers.token)).rejects.toMatchObject({ code: 'not_found' });
    await expect(acceptInvite({ userId: bob }, hers.token)).rejects.toMatchObject({ code: 'not_found' });
    expect(await getMembership(alice, id)).toBeNull();

    // Demotion: the link dies with the role, even if nothing revoked it.
    const again = await createInvite({ userId: owner }, id, { role: 'editor' });
    await acceptInvite({ userId: alice }, again.token);
    await setRole({ userId: owner }, id, alice, { role: 'owner' });
    const second = await createInvite({ userId: alice }, id, { role: 'viewer', maxUses: 10 });
    await setRole({ userId: owner }, id, alice, { role: 'editor' });
    expect((await q(`SELECT revoked_at FROM workspace_invites WHERE id = $1`, [second.id]))[0].revoked_at).not.toBeNull();
    // The accept guard itself: un-revoke the row by hand, it still refuses.
    await q(`UPDATE workspace_invites SET revoked_at = NULL WHERE id = $1`, [second.id]);
    expect(await previewInvite(second.token)).toBeNull();
    await expect(acceptInvite({ userId: bob }, second.token)).rejects.toMatchObject({ code: 'not_found' });

    // Leaving: the same.
    await setRole({ userId: owner }, id, alice, { role: 'owner' });
    const third = await createInvite({ userId: alice }, id, { role: 'viewer' });
    await leaveSpace({ userId: alice }, id);
    expect((await q(`SELECT revoked_at FROM workspace_invites WHERE id = $1`, [third.id]))[0].revoked_at).not.toBeNull();
    // The remaining owner's links are untouched.
    expect((await q(`SELECT revoked_at FROM workspace_invites WHERE id = $1`, [again.id]))[0].revoked_at).toBeNull();
  });

  test('an existing member keeps their role and the use is refunded', async () => {
    const { createInvite, acceptInvite } = await import('./invites');
    const id = await newSpace();
    const first = await createInvite({ userId: owner }, id, { role: 'editor' });
    await acceptInvite({ userId: alice }, first.token);
    const second = await createInvite({ userId: owner }, id, { role: 'viewer' });
    expect(await acceptInvite({ userId: alice }, second.token)).toEqual({ workspaceId: id, role: 'editor', alreadyMember: true });
    const [row] = await q(`SELECT use_count FROM workspace_invites WHERE id = $1`, [second.id]);
    expect(row.use_count).toBe(0);
    // Still usable by someone else.
    expect(await acceptInvite({ userId: bob }, second.token)).toMatchObject({ role: 'viewer', alreadyMember: false });
  });

  test('expired, revoked and malformed tokens are refused alike', async () => {
    const { createInvite, acceptInvite, previewInvite } = await import('./invites');
    const id = await newSpace();
    const expired = await createInvite({ userId: owner }, id, { role: 'viewer' });
    await q(`UPDATE workspace_invites SET expires_at = now() - interval '1 minute' WHERE id = $1`, [expired.id]);
    await expect(acceptInvite({ userId: alice }, expired.token)).rejects.toMatchObject({ code: 'not_found' });
    expect(await previewInvite(expired.token)).toBeNull();
    await expect(acceptInvite({ userId: alice }, 'nope')).rejects.toMatchObject({ code: 'not_found' });
    expect(await previewInvite('nope')).toBeNull();
    expect(await previewInvite(rand(32))).toBeNull();
  });

  test('preview shows space, inviter, role and expiry — nothing else', async () => {
    const { createInvite, previewInvite } = await import('./invites');
    const { renameSpace } = await import('./service');
    const id = await newSpace();
    await renameSpace({ userId: owner }, id, 'Launch');
    const invite = await createInvite({ userId: owner }, id, { role: 'commenter' });
    const preview = await previewInvite(invite.token);
    expect(preview).toEqual({ spaceName: 'Launch', inviterName: 'owner', role: 'commenter', expiresAt: invite.expiresAt });
  });

  test('revoke is scoped to the invite space', async () => {
    const { createInvite, revokeInvite, acceptInvite } = await import('./invites');
    const mine = await newSpace();
    const theirs = await newSpace(otherOwner);
    const theirInvite = await createInvite({ userId: otherOwner }, theirs, { role: 'viewer' });
    // The owner of another space names this invite under their own space: not found.
    await expect(revokeInvite({ userId: owner }, mine, theirInvite.id)).rejects.toMatchObject({ code: 'not_found' });
    // And under its real space they are not a member: not found.
    await expect(revokeInvite({ userId: owner }, theirs, theirInvite.id)).rejects.toMatchObject({ code: 'not_found' });
    const [row] = await q(`SELECT revoked_at FROM workspace_invites WHERE id = $1`, [theirInvite.id]);
    expect(row.revoked_at).toBeNull();

    await revokeInvite({ userId: otherOwner }, theirs, theirInvite.id);
    await expect(acceptInvite({ userId: alice }, theirInvite.token)).rejects.toMatchObject({ code: 'not_found' });
  });

  test('an archived space takes no new members', async () => {
    const { createInvite, acceptInvite, previewInvite } = await import('./invites');
    const { archiveSpace } = await import('./service');
    const id = await newSpace();
    const invite = await createInvite({ userId: owner }, id, { role: 'viewer' });
    await archiveSpace({ userId: owner }, id);
    expect(await previewInvite(invite.token)).toBeNull();
    await expect(acceptInvite({ userId: alice }, invite.token)).rejects.toMatchObject({ code: 'archived' });
    const [row] = await q(`SELECT use_count FROM workspace_invites WHERE id = $1`, [invite.id]);
    expect(row.use_count).toBe(0);
  });
});
