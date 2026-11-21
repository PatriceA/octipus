/** ensureSkillEmbeddings / ensureProposalEmbeddings against embedded PGlite, with a stubbed embedding service. */
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

const userId = '55555555-5555-4555-8555-555555555555';
const embed = vi.fn(async (_text: string) => [1, 0, 0]);
let mod: typeof import('./embedding-backfill');

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-embedding-backfill-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: userId, username: 'embedder' }]);
  mod = await import('./embedding-backfill');
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

beforeEach(async () => {
  const { getDb } = await import('@/db/postgres');
  const { skillProposals } = await import('@/db/schema/skill-proposals');
  const { skills } = await import('@/db/schema/skills');
  await getDb().delete(skillProposals);
  await getDb().delete(skills);
  embed.mockReset();
  embed.mockResolvedValue([1, 0, 0]);
  const embeddings = await import('@/core/rag/embeddings');
  vi.spyOn(embeddings, 'getEmbeddingService').mockReturnValue({ generateEmbedding: embed } as never);
});

afterEach(async () => {
  vi.restoreAllMocks();
  const { setCapabilitiesForTest } = await import('@/core/capabilities/gates');
  setCapabilitiesForTest({ embedding: true });
});

async function seedSkill(name: string, fields: Record<string, unknown> = {}): Promise<string> {
  const { getDb } = await import('@/db/postgres');
  const { skills } = await import('@/db/schema/skills');
  const id = randomUUID();
  await getDb().insert(skills).values({ id, name, description: `About ${name}`, content: 'x', userId, ...fields });
  return id;
}

async function seedProposal(name: string, fields: Record<string, unknown> = {}): Promise<string> {
  const { getDb } = await import('@/db/postgres');
  const { skillProposals } = await import('@/db/schema/skill-proposals');
  const [row] = await getDb().insert(skillProposals).values({
    userId, fingerprint: randomUUID(), name, description: `About ${name}`, draftPromptTemplate: 'x', kind: 'skill', lastExemplarAt: new Date(), ...fields,
  }).returning();
  return row.id;
}

describe('ensureSkillEmbeddings', () => {
  test('embeds missing and stale rows, skips current ones, honours the limit', async () => {
    const current = await seedSkill('current', { descriptionEmbedding: [0, 1, 0], descriptionHash: mod.skillDescriptionHash('current', 'About current') });
    await seedSkill('missing');
    await seedSkill('stale', { descriptionEmbedding: [0, 1, 0], descriptionHash: 'old' });

    expect(await mod.ensureSkillEmbeddings({ limit: 1 })).toMatchObject({ stale: 1, embedded: 1, failed: 0, noModel: false });
    expect(await mod.ensureSkillEmbeddings()).toMatchObject({ stale: 1, embedded: 1 });
    expect(await mod.ensureSkillEmbeddings()).toMatchObject({ stale: 0, embedded: 0 });
    expect(embed).toHaveBeenCalledTimes(2);
    expect(embed.mock.calls.map(([text]) => text)).not.toContain('current\nAbout current');

    const { getDb } = await import('@/db/postgres');
    const { skills } = await import('@/db/schema/skills');
    const { eq } = await import('drizzle-orm');
    const [row] = await getDb().select().from(skills).where(eq(skills.id, current));
    expect(row.descriptionEmbedding).toEqual([0, 1, 0]);
  });

  test('a missing model stops after the first row; a failing row is counted and the rest go on', async () => {
    await seedSkill('a');
    await seedSkill('b');
    embed.mockRejectedValue(new Error('No model mapped to topic "embedding". Assign one in the Models page.'));
    expect(await mod.ensureSkillEmbeddings()).toMatchObject({ embedded: 0, failed: 0, noModel: true });
    expect(embed).toHaveBeenCalledTimes(1);

    embed.mockReset();
    embed.mockRejectedValueOnce(new Error('provider hiccup')).mockResolvedValue([1, 0, 0]);
    expect(await mod.ensureSkillEmbeddings()).toMatchObject({ stale: 2, embedded: 1, failed: 1, noModel: false });
  });

  test('does nothing with the embedding capability off', async () => {
    await seedSkill('a');
    const { setCapabilitiesForTest } = await import('@/core/capabilities/gates');
    setCapabilitiesForTest({ embedding: false });
    expect(await mod.ensureSkillEmbeddings()).toEqual({ stale: 0, embedded: 0, failed: 0, noModel: true });
    expect(embed).not.toHaveBeenCalled();
  });
});

describe('ensureProposalEmbeddings', () => {
  test('embeds the user\'s open and suppressed non-patch proposals only', async () => {
    const pending = await seedProposal('pending');
    const candidate = await seedProposal('candidate', { status: 'candidate' });
    const suppressed = await seedProposal('suppressed', { status: 'rejected', rejectedUntil: new Date(Date.now() + 86_400_000) });
    await seedProposal('expired', { status: 'rejected', rejectedUntil: new Date(Date.now() - 1000) });
    await seedProposal('approved', { status: 'promoted' });
    await seedProposal('patch', { kind: 'patch' });

    expect(await mod.ensureProposalEmbeddings(userId, { limit: 20 })).toMatchObject({ stale: 3, embedded: 3 });
    const { getDb } = await import('@/db/postgres');
    const { skillProposals } = await import('@/db/schema/skill-proposals');
    const rows = await getDb().select({ id: skillProposals.id, embedding: skillProposals.embedding }).from(skillProposals);
    const embedded = rows.filter((row) => row.embedding).map((row) => row.id).sort();
    expect(embedded).toEqual([pending, candidate, suppressed].sort());
    expect(await mod.ensureProposalEmbeddings(userId)).toMatchObject({ stale: 0 });
  });
});
