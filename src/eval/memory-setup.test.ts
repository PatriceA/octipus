/**
 * Memory-aware evals. Everything here is the part that decides whether a
 * seeded test may run at all — the half that must never quietly pass.
 */
import { describe, expect, test, vi } from 'vitest';
import * as memoryRepo from '@/core/memory/repository';
import * as postgres from '@/db/postgres';
import * as embeddings from '@/core/rag/embeddings';
import { evaluateAssertion } from './assertions';
import { clearMemories, memorySetupBlocker, seedMemories } from './memory-setup';
import type { TestExecutionContext } from './types';

const ctx = (response?: string): TestExecutionContext => ({ latencyMs: 1, response });
const UUID = '11111111-2222-4333-8444-555555555555';

describe('memorySetupBlocker', () => {
  test('no seeds, nothing to block', () => {
    expect(memorySetupBlocker(undefined, { integration: false })).toBeNull();
    expect(memorySetupBlocker([], { integration: false })).toBeNull();
  });

  test('unit mode is refused — it never reads the memories table', () => {
    const why = memorySetupBlocker([{ factType: 'preference', content: 'x' }], {
      integration: false,
      userId: UUID,
    });
    expect(why).toContain('--integration');
  });

  test('a non-UUID user is refused before the insert fails', () => {
    const why = memorySetupBlocker([{ factType: 'preference', content: 'x' }], {
      integration: true,
      userId: 'eval-user',
    });
    expect(why).toContain('uuid');
  });

  test('integration mode with a real user id runs', () => {
    expect(
      memorySetupBlocker([{ factType: 'preference', content: 'x' }], {
        integration: true,
        userId: UUID,
      }),
    ).toBeNull();
  });
});

describe('recalls_memory', () => {
  test('passes when the seeded fact is in the reply', async () => {
    const r = await evaluateAssertion(
      { type: 'recalls_memory', value: 'Lisbon' },
      ctx('You are based in Lisbon, so 14:00 local.'),
    );
    expect(r.passed).toBe(true);
  });

  test('a partial recall is a failure, and names what is missing', async () => {
    const r = await evaluateAssertion(
      { type: 'recalls_memory', value: ['Lisbon', 'espresso'] },
      ctx('You are based in Lisbon.'),
    );
    expect(r.passed).toBe(false);
    expect(r.message).toContain('espresso');
  });

  test('an empty response never counts as recall', async () => {
    const r = await evaluateAssertion({ type: 'recalls_memory', value: 'Lisbon' }, ctx(''));
    expect(r.passed).toBe(false);
  });

  test('matching ignores case', async () => {
    const r = await evaluateAssertion(
      { type: 'recalls_memory', value: 'lisbon' },
      ctx('Lisbon it is.'),
    );
    expect(r.passed).toBe(true);
  });
});

// `seedMemories` and `clearMemories` are the IO half. They are exercised
// through the ACCESSOR functions (`getEmbeddingService`, `getMemoryRepository`,
// `getDb`) rather than by mocking the modules: `mock.module` leaks across the
// whole test process here, and the accessor seam is the one this codebase
// already uses for exactly this reason.
describe('seedMemories', () => {
  test('embeds each fact and returns the row ids', async () => {
    const added: Record<string, unknown>[] = [];
    const embedSpy = vi.spyOn(embeddings, 'getEmbeddingService').mockReturnValue({
      generateEmbedding: async () => [0.1, 0.2, 0.3],
    } as unknown as ReturnType<typeof embeddings.getEmbeddingService>);
    const repoSpy = vi.spyOn(memoryRepo, 'getMemoryRepository').mockReturnValue({
      addNew: async (r: Record<string, unknown>) => { added.push(r); return { id: `row-${added.length}` }; },
    } as unknown as ReturnType<typeof memoryRepo.getMemoryRepository>);

    const ids = await seedMemories(UUID, [
      { factType: 'profile', content: 'The user lives in Lisbon.' },
      { factType: 'preference', content: 'The user prefers espresso.', agentScope: 'general' },
    ]);

    expect(ids).toEqual(['row-1', 'row-2']);
    expect(added[0]).toMatchObject({ userId: UUID, factType: 'profile', agentScope: null });
    // The version string records the dimension the row was written at, which is
    // what migration 0055's homogeneity check reads.
    expect(added[0].embeddingVersion).toBe('eval/3');
    expect(added[1]).toMatchObject({ agentScope: 'general' });

    embedSpy.mockRestore();
    repoSpy.mockRestore();
  });

  test('an embedding failure throws, naming the fact and the fix', async () => {
    const embedSpy = vi.spyOn(embeddings, 'getEmbeddingService').mockReturnValue({
      generateEmbedding: async () => { throw new Error('no embedding model'); },
    } as unknown as ReturnType<typeof embeddings.getEmbeddingService>);
    const repoSpy = vi.spyOn(memoryRepo, 'getMemoryRepository').mockReturnValue({
      addNew: async () => { throw new Error('must not be reached'); },
    } as unknown as ReturnType<typeof memoryRepo.getMemoryRepository>);

    await expect(seedMemories(UUID, [{ factType: 'profile', content: 'x' }])).rejects.toThrow(
      /could not embed .*embedding.* topic/s,
    );

    embedSpy.mockRestore();
    repoSpy.mockRestore();
  });

  test('a user that does not exist is named as the problem, not the constraint', async () => {
    // `memorySetupBlocker` only checks the SHAPE of the id, so a well-formed
    // UUID belonging to nobody reaches the insert and trips the foreign key.
    // The operator's fix is "use a real user", which the raw error never says.
    const embedSpy = vi.spyOn(embeddings, 'getEmbeddingService').mockReturnValue({
      generateEmbedding: async () => [0.1, 0.2, 0.3],
    } as unknown as ReturnType<typeof embeddings.getEmbeddingService>);
    const repoSpy = vi.spyOn(memoryRepo, 'getMemoryRepository').mockReturnValue({
      addNew: async () => {
        throw new Error('insert or update on table "memories" violates foreign key constraint "memories_user_id_fkey"');
      },
    } as unknown as ReturnType<typeof memoryRepo.getMemoryRepository>);

    await expect(seedMemories(UUID, [{ factType: 'profile', content: 'x' }])).rejects.toThrow(
      /no such user in the target install/,
    );

    embedSpy.mockRestore();
    repoSpy.mockRestore();
  });

  test('any other write failure keeps its own message', async () => {
    const embedSpy = vi.spyOn(embeddings, 'getEmbeddingService').mockReturnValue({
      generateEmbedding: async () => [0.1, 0.2, 0.3],
    } as unknown as ReturnType<typeof embeddings.getEmbeddingService>);
    const repoSpy = vi.spyOn(memoryRepo, 'getMemoryRepository').mockReturnValue({
      addNew: async () => { throw new Error('connection terminated'); },
    } as unknown as ReturnType<typeof memoryRepo.getMemoryRepository>);

    await expect(seedMemories(UUID, [{ factType: 'profile', content: 'x' }])).rejects.toThrow(
      /connection terminated/,
    );

    embedSpy.mockRestore();
    repoSpy.mockRestore();
  });
});

describe('clearMemories', () => {
  test('no ids, no query', async () => {
    const dbSpy = vi.spyOn(postgres, 'getDb').mockImplementation(() => {
      throw new Error('must not touch the database');
    });
    await clearMemories([]);
    dbSpy.mockRestore();
  });

  test('deletes the seeded rows', async () => {
    let deleted: unknown;
    const dbSpy = vi.spyOn(postgres, 'getDb').mockReturnValue({
      delete: () => ({ where: async (w: unknown) => { deleted = w; } }),
    } as unknown as ReturnType<typeof postgres.getDb>);
    await clearMemories(['a', 'b']);
    expect(deleted).toBeDefined();
    dbSpy.mockRestore();
  });
});
