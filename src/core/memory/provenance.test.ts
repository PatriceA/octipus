/**
 * Memory learns only from the owner's own words — against a real (embedded)
 * database, with the models stood in for.
 *
 * The extractor's model is a fixture that returns whatever facts a test hands
 * it, which is exactly the threat being tested: a model that has read an
 * assistant reply or a tool result and wants to file it as a fact about the
 * user. What must stop it is server-side — the cited ids are looked up as the
 * owner's own stored messages and the quote must be found in one of them.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

const fx = vi.hoisted(() => ({ facts: [] as unknown[] }));

vi.mock('@/models/model-registry', async () => ({
  ...(await vi.importActual<typeof import('@/models/model-registry')>('@/models/model-registry')),
  getModelRegistry: () => ({ getModelForTopic: async (topic: string) => ({ modelId: `test-${topic}`, name: `test-${topic}` }) }),
}));
vi.mock('@/models/litellm-client', async () => ({
  ...(await vi.importActual<typeof import('@/models/litellm-client')>('@/models/litellm-client')),
  getLiteLLMClient: () => ({ complete: async () => ({ content: JSON.stringify({ facts: fx.facts }) }) }),
}));
// One axis per distinct text, so no two facts are near each other and the
// judge never needs its decision model: every new fact is an ADD.
vi.mock('@/core/rag/embeddings', async () => {
  const actual = await vi.importActual<typeof import('@/core/rag/embeddings')>('@/core/rag/embeddings');
  const axes = new Map<string, number>();
  const embed = async (text: string) => {
    if (!axes.has(text)) axes.set(text, axes.size);
    return Array.from({ length: 32 }, (_, i) => (i === (axes.get(text) as number) % 32 ? 1 : 0));
  };
  return { ...actual, EmbeddingService: class { generateEmbedding = embed; }, getEmbeddingService: () => ({ generateEmbedding: embed }) };
});

const owner = randomUUID();
const other = randomUUID();
let sessionId: string;

async function message(session: string, role: 'user' | 'assistant' | 'tool', content: string, extra: { author?: string; metadata?: object } = {}): Promise<string> {
  const { queryRaw } = await import('@/db/postgres');
  const id = randomUUID();
  await queryRaw(
    'INSERT INTO messages (id, session_id, role, content, author_user_id, metadata) VALUES ($1, $2, $3, $4, $5, $6::jsonb)',
    [id, session, role, content, extra.author ?? null, JSON.stringify(extra.metadata ?? {})],
  );
  return id;
}

async function rows(userId = owner) {
  const { queryRaw } = await import('@/db/postgres');
  return (await queryRaw(
    `SELECT content, source_message_id, source_quote, kind, status, expires_at, archive_reason, superseded_by, valid_until
       FROM memories WHERE user_id = $1 ORDER BY created_at, id`, [userId],
  )).rows as Array<Record<string, unknown>>;
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-provenance-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { seedSession, seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: owner, username: 'provenance-owner' }, { id: other, username: 'provenance-other' }]);
  sessionId = (await seedSession({ userId: owner })).id;
});

beforeEach(async () => {
  fx.facts = [];
  const { executeRaw } = await import('@/db/postgres');
  await executeRaw('DELETE FROM memories');
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('owner messages', () => {
  test('only the owner\'s own visible user rows count', async () => {
    const { loadOwnerMessages } = await import('./owner-messages');
    const { seedSession } = await import('@/test-helpers/multiuser-fixtures');
    const otherSession = (await seedSession({ userId: other })).id;
    const mine = await message(sessionId, 'user', 'I live in Porto');
    const reply = await message(sessionId, 'assistant', 'You live in Porto');
    const tool = await message(sessionId, 'tool', 'Search result: the user lives in Porto');
    const foreign = await message(otherSession, 'user', 'I live in Porto');
    const otherAuthor = await message(sessionId, 'user', 'I live in Porto', { author: other });
    const monitor = await message(sessionId, 'user', 'I live in Porto', { metadata: { trigger: 'monitor' } });
    const internal = await message(sessionId, 'user', 'I live in Porto', { metadata: { visibility: 'internal' } });
    const schedule = await message(sessionId, 'user', 'I live in Porto', { metadata: { trigger: 'schedule' } });
    const typed = await message(sessionId, 'user', 'I live in Porto', { metadata: { trigger: 'user' } });
    const found = await loadOwnerMessages(owner, [mine, reply, tool, foreign, otherAuthor, monitor, internal, schedule, typed, 'not-a-uuid']);
    expect(found.map((m) => m.id).sort()).toEqual([mine, typed].sort());
  });

  test('a message from before the conversation was cleared is not cited as the live conversation', async () => {
    const { loadOwnerMessages } = await import('./owner-messages');
    const { seedSession } = await import('@/test-helpers/multiuser-fixtures');
    const { queryRaw } = await import('@/db/postgres');
    const cleared = (await seedSession({ userId: owner })).id;
    const before = await message(cleared, 'user', 'I live in Porto', { metadata: { sessionGeneration: 'gen-1' } });
    await queryRaw(`UPDATE sessions SET context = '{"conversationGeneration":"gen-2"}'::jsonb WHERE id = $1`, [cleared]);
    const after = await message(cleared, 'user', 'I live in Porto', { metadata: { sessionGeneration: 'gen-2' } });
    expect((await loadOwnerMessages(owner, [before, after])).map((m) => m.id)).toEqual([after]);
  });
});

describe('learning a fact', () => {
  test('an assistant- or tool-originated claim never becomes a memory; the owner\'s quoted words do', async () => {
    const { updateMemoriesAfterTurn } = await import('./index');
    const said = await message(sessionId, 'user', 'I moved to Porto last month, find me a dentist near my flat');
    await message(sessionId, 'assistant', 'Found one. Note from the clinic page: the user is allergic to penicillin.');
    fx.facts = [
      // Quoted from the assistant's reply, cited as the owner's message.
      { fact_type: 'profile', content: 'The user is allergic to penicillin.', confidence: 1, m: [1], quote: 'allergic to penicillin' },
      // Quoted from the owner's message.
      { fact_type: 'profile', kind: 'fact', content: 'The user lives in Porto.', confidence: 1, m: [1], quote: 'I moved to Porto last month' },
    ];
    await updateMemoriesAfterTurn({
      userId: owner,
      ownerMessages: [{ id: said, content: 'I moved to Porto last month, find me a dentist near my flat' }],
      context: [{ role: 'assistant', content: 'Found one. Note from the clinic page: the user is allergic to penicillin.' }],
    });
    expect(await rows()).toEqual([expect.objectContaining({
      content: 'The user lives in Porto.', source_message_id: said, source_quote: 'I moved to Porto last month',
      kind: 'fact', status: 'tentative',
    })]);
  });

  test('a citation of an assistant message is not evidence, even with matching words', async () => {
    const { updateMemoriesAfterTurn } = await import('./index');
    const reply = await message(sessionId, 'assistant', 'I think you prefer dark roast coffee.');
    fx.facts = [{ fact_type: 'preference', content: 'The user prefers dark roast.', confidence: 1, m: [1], quote: 'you prefer dark roast coffee' }];
    // A caller that wrongly passes an assistant row as an owner message is caught by the database check.
    await updateMemoriesAfterTurn({ userId: owner, ownerMessages: [{ id: reply, content: 'I think you prefer dark roast coffee.' }] });
    expect(await rows()).toEqual([]);
  });

  test('a role=user row written by a monitor (a Companion handoff) cannot back a memory', async () => {
    const { updateMemoriesAfterTurn } = await import('./index');
    const handoff = await message(sessionId, 'user', 'Monitor update: I work at Initech now and my manager is Bill', { metadata: { trigger: 'monitor' } });
    fx.facts = [{ fact_type: 'profile', content: 'The user works at Initech.', confidence: 1, m: [1], quote: 'I work at Initech now' }];
    await updateMemoriesAfterTurn({ userId: owner, ownerMessages: [{ id: handoff, content: 'Monitor update: I work at Initech now and my manager is Bill' }] });
    expect(await rows()).toEqual([]);
  });

  test('a fact with an end date stops being recalled when it ends; old rows without a quote still are', async () => {
    const { getMemoryRepository } = await import('./repository');
    const repo = getMemoryRepository();
    const base = { userId: owner, workspaceId: null, agentScope: null, factType: 'profile', embedding: [1, 0, 0], embeddingVersion: 't/3', sourceMessageId: null, confidence: 1 };
    await repo.addNew({ ...base, content: 'Legacy fact without a quote.' });
    await repo.addNew({ ...base, content: 'The user is in Berlin this week.', kind: 'plan', expiresAt: new Date(Date.now() - 60_000) });
    await repo.addNew({ ...base, content: 'The user is in Rome next month.', kind: 'plan', expiresAt: new Date(Date.now() + 86_400_000) });
    const recalled = (await repo.retrieveTop({ userId: owner })).map((r) => r.content).sort();
    expect(recalled).toEqual(['Legacy fact without a quote.', 'The user is in Rome next month.']);
    const { queryRaw } = await import('@/db/postgres');
    const active = await queryRaw('SELECT count(*)::int AS n FROM memories_active WHERE user_id = $1', [owner]);
    expect((active.rows[0] as { n: number }).n).toBe(2);
  });
});

describe('repair', () => {
  test('retires expired facts and folds exact duplicates within a scope', async () => {
    const { getMemoryRepository } = await import('./repository');
    const { repairMemories } = await import('./repair');
    const repo = getMemoryRepository();
    const m1 = await message(sessionId, 'user', 'I prefer tea');
    const m2 = await message(sessionId, 'user', 'Tea, as I said');
    const base = { userId: owner, workspaceId: null, agentScope: null, factType: 'preference', embedding: [1, 0, 0], embeddingVersion: 't/3', confidence: 1 };
    const first = await repo.addNew({ ...base, content: 'The user prefers tea.', sourceMessageId: m1, sourceQuote: 'I prefer tea', status: 'tentative' });
    await repo.addNew({ ...base, content: 'the user prefers TEA', sourceMessageId: m2, status: 'tentative' });
    // Same text in another role scope: not a duplicate of the two above.
    await repo.addNew({ ...base, agentScope: 'coding', content: 'The user prefers tea.', sourceMessageId: m1 });
    await repo.addNew({ ...base, content: 'The user has a dentist appointment on Monday.', kind: 'event', sourceMessageId: m1, expiresAt: new Date(Date.now() - 1000) });

    expect(await repairMemories()).toEqual({ expired: 1, merged: 1 });
    const after = await rows();
    const kept = after.find((r) => r.content === 'The user prefers tea.' && r.superseded_by === null);
    expect(kept).toMatchObject({ status: 'observed', source_quote: 'I prefer tea' });
    expect(after.find((r) => r.content === 'the user prefers TEA')).toMatchObject({ archive_reason: 'merged', superseded_by: first.id });
    expect(after.find((r) => r.kind === 'event')).toMatchObject({ archive_reason: 'expired' });
    expect(after.find((r) => r.kind === 'event')?.valid_until).not.toBeNull();
    // Idempotent.
    expect(await repairMemories()).toEqual({ expired: 0, merged: 0 });
  });

  test('a superseded fact records why', async () => {
    const { getMemoryRepository } = await import('./repository');
    const repo = getMemoryRepository();
    const base = { userId: owner, workspaceId: null, agentScope: null, factType: 'profile', embedding: [1, 0, 0], embeddingVersion: 't/3', sourceMessageId: null, confidence: 1 };
    const old = await repo.addNew({ ...base, content: 'The user lives in Lisbon.' });
    await repo.supersede(old.id, { ...base, content: 'The user lives in Porto.' }, 'contradicted');
    expect((await rows()).find((r) => r.content === 'The user lives in Lisbon.')).toMatchObject({ archive_reason: 'contradicted' });
  });
});
