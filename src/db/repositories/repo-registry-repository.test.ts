import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { embeddings } from '@/db/schema/embeddings';
import { workspaceRepos } from '@/db/schema/workspace-repos';
import { seedUsers } from '@/test-helpers/multiuser-fixtures';
import { RepoRegistryRepository } from './repo-registry-repository';

const aliceId = randomUUID();
const bobId = randomUUID();
let repository: RepoRegistryRepository;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-repo-delete-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  await seedUsers([
    { id: aliceId, username: 'repo-delete-alice' },
    { id: bobId, username: 'repo-delete-bob' },
  ]);
  repository = new RepoRegistryRepository();
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('RepoRegistryRepository.deleteById', () => {
  test('deletes linked embeddings transactionally without crossing repository ownership', async () => {
    const { getDb } = await import('@/db/postgres');
    const db = getDb();
    const aliceRepo = await repository.upsert({
      userId: aliceId,
      name: 'alice-repo',
      rootPath: '/workspace/alice-repo',
      kind: 'library',
      languages: ['typescript'],
      dependencies: [],
      hasAgentsMd: false,
    });
    const bobRepo = await repository.upsert({
      userId: bobId,
      name: 'bob-repo',
      rootPath: '/workspace/bob-repo',
      kind: 'library',
      languages: ['typescript'],
      dependencies: [],
      hasAgentsMd: false,
    });

    const linkedId = randomUUID();
    const legacyLinkedId = randomUUID();
    const globalId = randomUUID();
    const bobLinkedId = randomUUID();
    await db.insert(embeddings).values([
      embeddingRow(linkedId, aliceId, 'alice-linked', aliceRepo.id),
      // Cleanup follows the verified repo FK, including inconsistent legacy
      // ownership, so this row cannot become globally visible either.
      embeddingRow(legacyLinkedId, bobId, 'legacy-linked', aliceRepo.id),
      embeddingRow(globalId, aliceId, 'alice-global', null),
      embeddingRow(bobLinkedId, bobId, 'bob-linked', bobRepo.id),
    ]);

    expect(await repository.deleteById(bobId, aliceRepo.id)).toBe(false);
    expect(await db.select({ id: embeddings.id }).from(embeddings)
      .where(inArray(embeddings.id, [linkedId, legacyLinkedId]))).toHaveLength(2);

    expect(await repository.deleteById(aliceId, aliceRepo.id)).toBe(true);
    expect(await repository.deleteById(aliceId, aliceRepo.id)).toBe(false);
    expect(await db.select({ id: workspaceRepos.id }).from(workspaceRepos)
      .where(eq(workspaceRepos.id, aliceRepo.id))).toEqual([]);

    const survivors = await db.select({ id: embeddings.id, repoId: embeddings.repoId })
      .from(embeddings)
      .where(inArray(embeddings.id, [linkedId, legacyLinkedId, globalId, bobLinkedId]));
    expect(survivors).toEqual(expect.arrayContaining([
      { id: globalId, repoId: null },
      { id: bobLinkedId, repoId: bobRepo.id },
    ]));
    expect(survivors).toHaveLength(2);
  });
});

function embeddingRow(id: string, userId: string, sourceId: string, repoId: string | null) {
  return {
    id,
    sourceId,
    userId,
    content: sourceId,
    embedding: [0.1, 0.2, 0.3],
    model: 'test-embedding',
    purpose: 'knowledge_artifact',
    contentSha256: `sha-${sourceId}`,
    embeddingVersion: 'test-embedding/3',
    repoId,
  };
}
