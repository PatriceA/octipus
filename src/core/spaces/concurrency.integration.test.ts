/**
 * Space races on real Postgres (docs/plans/coworking-spec.md §5.11, I5, I8).
 *
 * PGlite is one in-process connection: two "concurrent" transactions there
 * run one after the other, so the unit suites can only pin the guards' SQL.
 * Here the pool hands each transaction its own connection and the races are
 * real:
 *
 *   - many accepts of an invite with one use left: exactly one joins;
 *   - two owners demoting each other at once: one owner is always left;
 *   - an owner's removal racing an accept of that owner's link: the accept
 *     never lands after the removal committed.
 *
 * Runs in the integration lane (`npm run test:integration`, INTEGRATION=1).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { isIntegration, setupIntegrationDb, teardownIntegration } from '@/test-helpers/integration';

// biome-ignore lint/suspicious/noExplicitAny: raw rows
type Row = any;
async function q(sql: string, params: unknown[] = []): Promise<Row[]> {
  const { queryRaw } = await import('@/db/postgres');
  return (await queryRaw(sql, params)).rows;
}

const owner = randomUUID();
const coOwner = randomUUID();
const joiners = Array.from({ length: 8 }, () => randomUUID());

describe.skipIf(!isIntegration)('space races (Integration)', () => {
  beforeAll(async () => {
    await setupIntegrationDb();
    const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
    await seedUsers([
      { id: owner, username: `race-owner-${owner.slice(0, 6)}` },
      { id: coOwner, username: `race-co-${coOwner.slice(0, 6)}` },
      ...joiners.map((id) => ({ id, username: `race-${id.slice(0, 8)}` })),
    ]);
  }, 60_000);

  afterAll(async () => {
    await teardownIntegration();
  });

  test('the last use of an invite goes to exactly one of many concurrent accepts', async () => {
    const { createSpace } = await import('./service');
    const { createInvite, acceptInvite } = await import('./invites');
    const space = await createSpace({ userId: owner }, { name: 'Race' });
    const invite = await createInvite({ userId: owner }, space.id, { role: 'viewer', maxUses: 3 });
    await q(`UPDATE workspace_invites SET use_count = max_uses - 1 WHERE id = $1`, [invite.id]);
    const results = await Promise.allSettled(joiners.map((userId) => acceptInvite({ userId }, invite.token)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const members = await q(`SELECT count(*)::int AS n FROM workspace_members WHERE workspace_id = $1`, [space.id]);
    expect(members[0].n).toBe(2);
    const [row] = await q(`SELECT use_count, max_uses FROM workspace_invites WHERE id = $1`, [invite.id]);
    expect(row.use_count).toBe(row.max_uses);
  });

  test('two owners demoting each other at once always leave one owner', async () => {
    const { createSpace, setRole } = await import('./service');
    const { createInvite, acceptInvite } = await import('./invites');
    for (let round = 0; round < 10; round += 1) {
      const space = await createSpace({ userId: owner }, { name: `Demote ${round}` });
      const invite = await createInvite({ userId: owner }, space.id, { role: 'editor' });
      await acceptInvite({ userId: coOwner }, invite.token);
      await setRole({ userId: owner }, space.id, coOwner, { role: 'owner' });
      await Promise.allSettled([
        setRole({ userId: owner }, space.id, coOwner, { role: 'editor' }),
        setRole({ userId: coOwner }, space.id, owner, { role: 'editor' }),
      ]);
      const owners = await q(`SELECT count(*)::int AS n FROM workspace_members WHERE workspace_id = $1 AND role = 'owner'`, [space.id]);
      expect(owners[0].n, `round ${round}`).toBe(1);
    }
  });

  test('an accept of a removed owner’s link never lands after the removal', async () => {
    const { createSpace, setRole, removeMember, getMembership } = await import('./service');
    const { createInvite, acceptInvite } = await import('./invites');
    for (let round = 0; round < 10; round += 1) {
      const space = await createSpace({ userId: owner }, { name: `Remove ${round}` });
      const invite = await createInvite({ userId: owner }, space.id, { role: 'editor' });
      await acceptInvite({ userId: coOwner }, invite.token);
      await setRole({ userId: owner }, space.id, coOwner, { role: 'owner' });
      const link = await createInvite({ userId: coOwner }, space.id, { role: 'editor', maxUses: 10 });
      const joiner = joiners[round % joiners.length];
      await Promise.allSettled([
        removeMember({ userId: owner }, space.id, coOwner),
        acceptInvite({ userId: joiner }, link.token),
      ]);
      // Either the accept went first (the joiner joined while the link was
      // good) or it was refused. Audit timestamps cannot tell which committed
      // first — each transaction stamps its row before it waits on the other's
      // lock — so the check is on state: the removal always ends with the
      // link revoked and the remover's demotion in place, and a join that
      // happened spent exactly one use of the link.
      const joined = await getMembership(joiner, space.id);
      const [linkRow] = await q(`SELECT use_count, revoked_at FROM workspace_invites WHERE id = $1`, [link.id]);
      expect(linkRow.revoked_at, `round ${round}`).not.toBeNull();
      expect(await getMembership(coOwner, space.id), `round ${round}`).toBeNull();
      expect(linkRow.use_count, `round ${round}`).toBe(joined ? 1 : 0);
      await expect(acceptInvite({ userId: joiners[(round + 1) % joiners.length] }, link.token)).rejects.toMatchObject({ code: 'not_found' });
    }
  });
});
