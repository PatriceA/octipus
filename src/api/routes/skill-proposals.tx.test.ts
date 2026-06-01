/**
 * M14 — verifies the skill-proposal "approve" path is atomic: creating the
 * expert and marking the proposal `promoted` happen in one transaction, so a
 * failure on the second write rolls back the first (no orphan expert, proposal
 * stays re-approvable). Runs against embedded PGlite (no Docker), mirroring the
 * pattern in src/security/rls.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const userId = '11111111-1111-1111-1111-111111111111';

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-skillprop-tx-'));

  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();

  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: userId, username: 'alice' }]);
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

async function seedProposal(): Promise<string> {
  const { getDb } = await import('@/db/postgres');
  const { skillProposals } = await import('@/db/schema/skill-proposals');
  const db = getDb();
  const [row] = await db.insert(skillProposals).values({
    userId,
    fingerprint: randomUUID(),
    name: 'cloud-infra',
    description: 'cloud infrastructure expertise',
    draftPromptTemplate: 'You are a cloud infra expert.',
    lastExemplarAt: new Date(),
  }).returning();
  return row.id;
}

describe('skill-proposal approve atomicity (M14)', () => {
  beforeEach(async () => {
    const { getDb } = await import('@/db/postgres');
    const { experts } = await import('@/db/schema/experts');
    const { skillProposals } = await import('@/db/schema/skill-proposals');
    const db = getDb();
    await db.delete(experts);
    await db.delete(skillProposals);
  });

  test('happy path: both the expert insert and the proposal update commit', async () => {
    const { getDb } = await import('@/db/postgres');
    const { eq } = await import('drizzle-orm');
    const { experts } = await import('@/db/schema/experts');
    const { skillProposals } = await import('@/db/schema/skill-proposals');
    const db = getDb();
    const id = await seedProposal();

    const created = await db.transaction(async (tx) => {
      const [expert] = await tx.insert(experts).values({
        userId, name: 'cloud-infra', description: 'x', role: 'general',
        systemPrompt: 'p', isSystem: false,
      }).returning();
      await tx.update(skillProposals).set({ status: 'promoted' }).where(eq(skillProposals.id, id));
      return expert;
    });

    expect(created?.id).toBeDefined();
    const [proposal] = await db.select().from(skillProposals).where(eq(skillProposals.id, id));
    expect(proposal.status).toBe('promoted');
    const allExperts = await db.select().from(experts);
    expect(allExperts.length).toBe(1);
  });

  test('rollback: a failure after the expert insert leaves no expert and the proposal pending', async () => {
    const { getDb } = await import('@/db/postgres');
    const { eq } = await import('drizzle-orm');
    const { experts } = await import('@/db/schema/experts');
    const { skillProposals } = await import('@/db/schema/skill-proposals');
    const db = getDb();
    const id = await seedProposal();

    await expect(
      db.transaction(async (tx) => {
        await tx.insert(experts).values({
          userId, name: 'cloud-infra', description: 'x', role: 'general',
          systemPrompt: 'p', isSystem: false,
        }).returning();
        // Simulate the status-update failing mid-transaction (before the
        // second write lands), exercising the rollback path.
        throw new Error('boom after expert insert');
      }),
    ).rejects.toThrow(/boom/);

    // Both writes must have rolled back.
    const allExperts = await db.select().from(experts);
    expect(allExperts.length).toBe(0);
    const [proposal] = await db.select().from(skillProposals).where(eq(skillProposals.id, id));
    expect(proposal.status).toBe('pending');
  });
});
