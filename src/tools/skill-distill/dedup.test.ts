/**
 * The distiller filed four proposals for one procedure ("Token Rotation
 * Procedure", "token-rotation-procedure", "vault-token-rotation",
 * "secure-credential-rotation") because the only guard was an exact-name match
 * against pending rows. These cover each way that now gets caught (and what
 * filing then does: drop, merge or insert). Runs against
 * embedded PGlite, mirroring skill-proposals.tx.test.ts.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

const userId = '22222222-2222-2222-2222-222222222222';

/** Deterministic stand-in embeddings: same topic ⇒ near-parallel vectors. */
const VECTORS: Record<string, number[]> = {
  rotation: [1, 0.9, 0.1, 0],
  backups: [0, 0.1, 1, 0.9],
};
function vectorFor(text: string): number[] {
  return /rotat|credential|token/i.test(text) ? VECTORS.rotation : VECTORS.backups;
}

function stubEmbeddings(impl?: () => Promise<number[]>) {
  return vi.spyOn(embeddingsModule, 'getEmbeddingService').mockReturnValue({
    generateEmbedding: async (text: string) => (impl ? impl() : vectorFor(text)),
  } as never);
}

let embeddingsModule: typeof import('@/core/rag/embeddings');
let decideSkillProposal: typeof import('./dedup').decideSkillProposal;
let skillFingerprint: typeof import('./distiller').skillFingerprint;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-skill-dedup-'));

  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: userId, username: 'dedup-user' }]);

  embeddingsModule = await import('@/core/rag/embeddings');
  ({ decideSkillProposal } = await import('./dedup'));
  ({ skillFingerprint } = await import('./distiller'));
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
});

afterEach(() => vi.restoreAllMocks());

async function seedProposal(fields: {
  name: string;
  description?: string;
  status?: 'pending' | 'rejected' | 'promoted';
  rejectedUntil?: Date;
}): Promise<string> {
  const { getDb } = await import('@/db/postgres');
  const { skillProposals } = await import('@/db/schema/skill-proposals');
  const [row] = await getDb().insert(skillProposals).values({
    userId,
    fingerprint: skillFingerprint(userId, fields.name),
    name: fields.name,
    description: fields.description ?? 'How to rotate a token',
    draftPromptTemplate: '1. revoke\n2. reissue',
    kind: 'skill',
    status: fields.status ?? 'pending',
    rejectedUntil: fields.rejectedUntil,
    lastExemplarAt: new Date(),
  }).returning();
  return row.id;
}

async function seedSkill(name: string, embedding?: number[]): Promise<string> {
  const { getDb } = await import('@/db/postgres');
  const { skills } = await import('@/db/schema/skills');
  const id = randomUUID();
  await getDb().insert(skills).values({
    id,
    name,
    description: 'How to rotate a token',
    content: 'steps',
    category: 'general',
    userId,
    descriptionEmbedding: embedding,
  });
  return id;
}

const distilled = (name: string, description = 'How to rotate a token') => ({
  name,
  description,
  content: '1. revoke\n2. reissue',
});

const decide = (skill: ReturnType<typeof distilled>, opts?: { extendsProposalId?: string }) =>
  decideSkillProposal(userId, skillFingerprint(userId, skill.name), skill, opts);

describe('decideSkillProposal', () => {
  test('a name that differs only in case/punctuation merges into the pending proposal', async () => {
    stubEmbeddings();
    const id = await seedProposal({ name: 'Token Rotation Procedure' });

    const hit = await decide(distilled('token-rotation-procedure'));
    expect(hit).toMatchObject({ action: 'merge', via: 'fingerprint', target: { id }, allowDistinct: false });
  });

  test('a rejection still inside its suppression window blocks a re-file', async () => {
    stubEmbeddings();
    const until = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await seedProposal({ name: 'token-rotation', status: 'rejected', rejectedUntil: until });

    expect(await decide(distilled('token-rotation'))).toMatchObject({ action: 'drop', reason: 'suppressed' });
  });

  test('an expired suppression lets the skill be proposed again', async () => {
    stubEmbeddings();
    await seedProposal({
      name: 'token-rotation',
      status: 'rejected',
      rejectedUntil: new Date(Date.now() - 1000),
    });

    expect(await decide(distilled('token-rotation'))).toMatchObject({ action: 'insert' });
  });

  test('an existing live skill wins over filing another proposal', async () => {
    stubEmbeddings();
    const id = await seedSkill('Token Rotation');

    expect(await decide(distilled('token-rotation'))).toMatchObject({ action: 'drop', reason: 'skill', id });
  });

  test('a differently-named but equivalent pending proposal is caught by its stored embedding', async () => {
    stubEmbeddings();
    // Seeded without an embedding: the dedup computes it first.
    const id = await seedProposal({ name: 'vault-token-rotation' });

    const hit = await decide(distilled('secure-credential-rotation', 'Rotate a credential safely'));
    expect(hit).toMatchObject({ action: 'merge', via: 'similarity', target: { id }, allowDistinct: false });
    expect(hit.action === 'merge' && hit.similarity).toBeGreaterThanOrEqual(0.85);
  });

  test('an unrelated pending proposal is not treated as a duplicate', async () => {
    stubEmbeddings();
    await seedProposal({ name: 'restore-from-backups', description: 'Restore from backups' });

    const hit = await decide(distilled('secure-credential-rotation', 'Rotate a credential safely'));
    expect(hit).toMatchObject({ action: 'insert' });
    expect(hit.action === 'insert' && hit.embedding).toEqual(VECTORS.rotation);
  });

  test('no embedding model ⇒ name checks only, never a throw', async () => {
    stubEmbeddings(() => Promise.reject(new Error('no embedding model configured')));
    await seedProposal({ name: 'vault-token-rotation' });

    expect(await decide(distilled('secure-credential-rotation'))).toEqual({ action: 'insert', embedding: null });
  });

  test('extendsProposalId merges into that open proposal without any embedding', async () => {
    stubEmbeddings(() => Promise.reject(new Error('no embedding model configured')));
    const id = await seedProposal({ name: 'restore-from-backups', description: 'Restore from backups' });

    expect(await decide(distilled('secure-credential-rotation'), { extendsProposalId: `proposal:${id}` }))
      .toMatchObject({ action: 'merge', via: 'extends', target: { id } });
    // Not an open proposal of the user: ignored.
    expect(await decide(distilled('secure-credential-rotation'), { extendsProposalId: randomUUID() })).toMatchObject({ action: 'insert' });
  });
});
