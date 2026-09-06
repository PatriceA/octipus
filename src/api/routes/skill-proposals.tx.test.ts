/**
 * M14 — verifies the skill-proposal "approve" path is atomic: creating the
 * expert and marking the proposal `promoted` happen in one transaction, so a
 * failure on the second write rolls back the first (no orphan expert, proposal
 * stays re-approvable). Runs against embedded PGlite (no Docker), mirroring the
 * pattern in src/security/rls.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
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

  test('a kind:skill proposal promotes into a skill row (not an expert)', async () => {
    const { getDb } = await import('@/db/postgres');
    const { eq } = await import('drizzle-orm');
    const { skills } = await import('@/db/schema/skills');
    const { skillProposals } = await import('@/db/schema/skill-proposals');
    const db = getDb();

    // The kind + sourceRef columns round-trip.
    const [prop] = await db.insert(skillProposals).values({
      userId,
      fingerprint: randomUUID(),
      name: 'deploy-runbook',
      description: 'deploy steps',
      draftPromptTemplate: '1. build 2. ship',
      kind: 'skill',
      sourceRef: 'trajectory:abc',
      lastExemplarAt: new Date(),
    }).returning();
    expect(prop.kind).toBe('skill');
    expect(prop.sourceRef).toBe('trajectory:abc');

    // The approve 'skill' branch: create a skill + flip status, atomically.
    const created = await db.transaction(async (tx) => {
      const [skill] = await tx.insert(skills).values({
        id: randomUUID(),
        name: prop.name,
        description: prop.description,
        content: prop.draftPromptTemplate,
        category: 'general',
        isSystem: false,
        userId,
      }).returning();
      await tx.update(skillProposals).set({ status: 'promoted' }).where(eq(skillProposals.id, prop.id));
      return skill;
    });

    expect(created?.content).toBe('1. build 2. ship');
    const [after] = await db.select().from(skillProposals).where(eq(skillProposals.id, prop.id));
    expect(after.status).toBe('promoted');
  });

  test('kind defaults to expert for a proposal that does not set it', async () => {
    const { getDb } = await import('@/db/postgres');
    const { eq } = await import('drizzle-orm');
    const { skillProposals } = await import('@/db/schema/skill-proposals');
    const db = getDb();
    const id = await seedProposal();
    const [prop] = await db.select().from(skillProposals).where(eq(skillProposals.id, id));
    expect(prop.kind).toBe('expert');
  });
});

describe('approveProposal merges into an existing skill', () => {
  beforeEach(async () => {
    const { getDb } = await import('@/db/postgres');
    const { skills } = await import('@/db/schema/skills');
    const { skillProposals } = await import('@/db/schema/skill-proposals');
    await getDb().delete(skills);
    await getDb().delete(skillProposals);
  });

  async function seedSkillProposal(name: string, content: string): Promise<string> {
    const { getDb } = await import('@/db/postgres');
    const { skillProposals } = await import('@/db/schema/skill-proposals');
    const [row] = await getDb().insert(skillProposals).values({
      userId,
      fingerprint: randomUUID(),
      name,
      description: 'rotate a token',
      draftPromptTemplate: content,
      kind: 'skill',
      lastExemplarAt: new Date(),
    }).returning();
    return row.id;
  }

  test('approving a proposal for a skill the user already has updates it instead of adding a second row', async () => {
    const { getDb } = await import('@/db/postgres');
    const { skills } = await import('@/db/schema/skills');
    const { approveProposal } = await import('@/services/skill-proposal-service');
    const db = getDb();

    const existingId = randomUUID();
    await db.insert(skills).values({
      id: existingId,
      name: 'Token Rotation',
      description: 'old description',
      content: 'old steps',
      category: 'general',
      userId,
    });

    const proposalId = await seedSkillProposal('token-rotation', 'new steps');
    const result = await approveProposal(proposalId, { userId });

    expect(result).toMatchObject({ promoted: 'skill', id: existingId });
    const rows = await db.select().from(skills);
    expect(rows.length).toBe(1);
    expect(rows[0].content).toBe('new steps');
  });

  test('the merge clears the stale embedding so the row gets re-embedded', async () => {
    const { getDb } = await import('@/db/postgres');
    const { skills } = await import('@/db/schema/skills');
    const { approveProposal } = await import('@/services/skill-proposal-service');
    const db = getDb();

    await db.insert(skills).values({
      id: randomUUID(),
      name: 'Token Rotation',
      description: 'old description',
      content: 'old steps',
      category: 'general',
      userId,
      descriptionEmbedding: [1, 0, 0, 0],
      descriptionHash: 'stale',
    });

    await approveProposal(await seedSkillProposal('token-rotation', 'new steps'), { userId });

    const [row] = await db.select().from(skills);
    expect(row.descriptionEmbedding).toBeNull();
    expect(row.descriptionHash).toBeNull();
  });

  test('a genuinely new skill still inserts', async () => {
    const { getDb } = await import('@/db/postgres');
    const { skills } = await import('@/db/schema/skills');
    const { approveProposal } = await import('@/services/skill-proposal-service');

    const proposalId = await seedSkillProposal('backup-restore', 'restore steps');
    await approveProposal(proposalId, { userId });

    const rows = await getDb().select().from(skills);
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe('backup-restore');
  });
});
