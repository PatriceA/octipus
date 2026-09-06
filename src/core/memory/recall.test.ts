/**
 * Does the fact the turn needs actually reach the model? — the measurement the
 * daily-driver plan made Phase 6 conditional on.
 *
 * This is a benchmark that happens to be a test. It seeds a corpus the size a
 * real user reaches after a few months, warms the access counters the way the
 * running system warms them, then asks one question per topic and counts how
 * often the memory that answers it survives into the 250-token block. Two
 * strategies, same corpus, same budget:
 *
 *   - `retrieveTop`        — access_count + recency, what shipped in Phase D.
 *   - `retrieveForContext` — the same list interleaved with a relevance pass.
 *
 * It asserts the gap rather than printing it, so the claim in the plan doc and
 * in `docs/RAG.md` cannot quietly stop being true.
 *
 * What the numbers do and do not cover
 * ────────────────────────────────────
 * The vectors are SYNTHETIC: one unit direction per topic, so a query about
 * topic *t* is by construction nearest the fact filed under *t*. That makes
 * this a measurement of the RANKING — is it better to order the block by what
 * was asked than by how often a row has been read — with the embedder assumed
 * competent. It is not a measurement of any embedder's quality. `QUERY_NOISE`
 * rotates the query away from its topic to show the ranking still pays off
 * when the embedder is only roughly right; a truly bad embedder degrades this
 * to the frequency ordering, which is the floor the fallback path guarantees
 * anyway.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { MemoryRepository } from './repository';

const userId = randomUUID();
const LIMIT = 20;
let repo: MemoryRepository;
let retrieveForContext: typeof import('./retrieval').retrieveForContext;
let renderMemoriesBlock: typeof import('./retrieval').renderMemoriesBlock;

// ── The corpus ──────────────────────────────────────────────────────
// One consultant's facts after a few months of use. Twelve of them answer a
// question someone would actually type; the rest are the true-but-irrelevant
// majority that any real corpus is mostly made of.

interface Fact {
  factType: string;
  content: string;
  /** Set on the twelve answers; the index of the topic direction. */
  topic?: number;
}

const TARGETS: Array<{ topic: number; ask: string; fact: Fact }> = [
  { topic: 0, ask: 'Where should I get lunch today?', fact: { factType: 'profile', content: 'The user is allergic to peanuts.', topic: 0 } },
  { topic: 1, ask: 'Set up the datastore for the new service.', fact: { factType: 'preference', content: 'The user picks Postgres over MySQL for every new datastore.', topic: 1 } },
  { topic: 2, ask: 'Who owns the backend on the Meridian migration?', fact: { factType: 'relationship', content: 'Rui is the backend lead on the Meridian Health migration.', topic: 2 } },
  { topic: 3, ask: 'Book time with me next week.', fact: { factType: 'profile', content: 'The user takes no meetings before 14:00 Western European Time.', topic: 3 } },
  { topic: 4, ask: 'Review this error-handling change.', fact: { factType: 'preference', content: 'The user wants reviews to cover error handling before style.', topic: 4 } },
  { topic: 5, ask: 'Can we ship this today?', fact: { factType: 'workflow_note', content: 'The user only deploys on a Friday if the release has been on staging since Wednesday.', topic: 5 } },
  { topic: 6, ask: 'Send the client this month’s invoice.', fact: { factType: 'workflow_note', content: 'The user bills clients monthly in euros from billing.xlsx.', topic: 6 } },
  { topic: 7, ask: 'Add tests for the new module.', fact: { factType: 'preference', content: 'The user writes tests with Vitest, never Jest.', topic: 7 } },
  { topic: 8, ask: 'Draft the follow-up to the product manager.', fact: { factType: 'relationship', content: 'Marta is the user’s product manager at Meridian Health.', topic: 8 } },
  { topic: 9, ask: 'Open a pull request for this branch.', fact: { factType: 'workflow_note', content: 'The user opens a draft pull request before asking anyone to review.', topic: 9 } },
  { topic: 10, ask: 'What is my tax deadline?', fact: { factType: 'relationship', content: 'Tomas is the user’s accountant and files the quarterly returns.', topic: 10 } },
  { topic: 11, ask: 'Install the project dependencies.', fact: { factType: 'preference', content: 'The user runs pnpm, not npm, in every repository.', topic: 11 } },
];

const DISTRACTORS: Fact[] = [
  'The user lives in Lisbon.',
  'The user works as an independent software consultant.',
  'The user’s main laptop runs Linux.',
  'The user prefers dark mode in every interface.',
  'The user reads email first thing in the morning.',
  'The user’s partner is called Ines.',
  'The user mentors a junior developer called Sofia.',
  'The user keeps client notes in Obsidian.',
  'The user speaks Portuguese and English.',
  'The user prefers concise answers with no preamble.',
  'The user drives an electric car.',
  'The user has a standing desk.',
  'The user subscribes to two newsletters about distributed systems.',
  'The user took a sabbatical in 2023.',
  'The user prefers four-space indentation in Python.',
  'The user runs on Tuesday and Thursday evenings.',
  'The user’s previous employer was a payments company.',
  'The user dislikes video calls without an agenda.',
  'The user archives finished projects to an external drive.',
  'The user tracks reading in a plain text file.',
  'The user prefers train travel to flying within Iberia.',
  'The user renewed the office lease in March.',
  'The user keeps a spare laptop charger in the car.',
  'The user prefers a single monitor.',
  'The user learned Rust for a side project.',
  'The user files expenses at the end of every quarter.',
  'The user turns notifications off after 19:00.',
  'The user prefers markdown to word processors.',
].map((content, i) => ({ factType: i % 2 === 0 ? 'preference' : 'profile', content }));

const TOPIC_COUNT = TARGETS.length;
/** How far a query is rotated off its topic. 0 = a perfect embedder. */
const QUERY_NOISE = 0.45;

/** Reproducible PRNG — a benchmark whose numbers move between runs is noise. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20260906);

function normalize(v: number[]): number[] {
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

/** A unit direction per topic, plus off-axis directions for the distractors. */
function topicVector(topic: number): number[] {
  return Array.from({ length: TOPIC_COUNT }, (_, i) => (i === topic ? 1 : 0));
}

function noisyVector(topic: number, noise: number): number[] {
  return normalize(topicVector(topic).map((x) => x + noise * (rand() * 2 - 1)));
}

/** A distractor sits away from every topic axis, the way an unrelated fact does. */
function offAxisVector(): number[] {
  return normalize(Array.from({ length: TOPIC_COUNT }, () => rand()));
}

/** Fisher-Yates on the seeded PRNG — a fixed arrival order, not a fresh one. */
function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** text → vector, so the stubbed embedding service is a lookup, not a model. */
const queryVectors = new Map<string, number[]>();

/**
 * The stub itself, held here rather than inline so a test that needs ONE
 * failing call can queue it (`mockRejectedValueOnce`) instead of restoring the
 * spy — restoring would hand the rest of the file the real embedding service,
 * whose failures this module swallows, and the remaining tests would pass
 * while measuring the fallback.
 */
const embed = vi.fn(async (text: string) => {
  const vector = queryVectors.get(text);
  if (!vector) throw new Error(`bench: no vector fixture for query "${text}"`);
  return vector;
});

async function seedCorpus(): Promise<void> {
  const { getMemoryRepository } = await import('./repository');
  repo = getMemoryRepository();
  // Shuffled, because insertion order IS arrival order and the fact that
  // answers tomorrow's question was not necessarily mentioned last. Seeding
  // the twelve answers at the end instead would hand the recency half of the
  // old ordering a best case no real corpus gives it.
  const facts: Fact[] = shuffle([...DISTRACTORS, ...TARGETS.map((t) => t.fact)]);
  for (const fact of facts) {
    await repo.addNew({
      userId,
      workspaceId: null,
      agentScope: null,
      factType: fact.factType,
      content: fact.content,
      embedding: fact.topic === undefined ? offAxisVector() : topicVector(fact.topic),
      embeddingVersion: `bench/${TOPIC_COUNT}`,
      sourceMessageId: null,
      confidence: 1,
      validUntil: null,
    });
  }
  for (const t of TARGETS) queryVectors.set(t.ask, noisyVector(t.topic, QUERY_NOISE));
}

/**
 * Run turns through the OLD path so the access counters end up where a real
 * install's do. This is the loop that makes the frequency ordering a ratchet:
 * `recordAccess` bumps exactly the rows it returned, so those rows keep
 * winning and a row outside the page never gets a count to climb with.
 */
async function warmAccessCounters(turns: number): Promise<void> {
  const { executeRaw } = await import('@/db/postgres');
  for (let i = 0; i < turns; i++) {
    const rows = await repo.retrieveTop({ userId, limit: LIMIT });
    // Synchronous, unlike the fire-and-forget production call, so the next
    // iteration sees the bump rather than racing it.
    await executeRaw(
      `UPDATE memories SET access_count = access_count + 1, last_accessed_at = now()
       WHERE id IN (${rows.map((r) => `'${r.id}'`).join(',')})`,
    );
  }
}

type Snapshot = Array<{ id: string; access_count: number }>;

async function snapshotAccess(): Promise<Snapshot> {
  const { executeRaw } = await import('@/db/postgres');
  return (await executeRaw('SELECT id, access_count FROM memories')) as Snapshot;
}

/** Put the counters back, so each question is asked of the same install. */
async function restoreAccess(snap: Snapshot): Promise<void> {
  const { executeRaw } = await import('@/db/postgres');
  for (const row of snap) {
    await executeRaw(`UPDATE memories SET access_count = ${Number(row.access_count)} WHERE id = '${row.id}'`);
  }
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-recall-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: userId, username: 'recall-bench-user' }]);

  const retrieval = await import('./retrieval');
  retrieveForContext = retrieval.retrieveForContext;
  renderMemoriesBlock = retrieval.renderMemoriesBlock;

  // The embedding service is a lookup table here: the vectors are the
  // fixture's, so what is being measured is the ranking, not a model.
  const { getEmbeddingService } = await import('@/core/rag/embeddings');
  vi.spyOn(getEmbeddingService(), 'generateEmbedding').mockImplementation(embed);

  await seedCorpus();
  await warmAccessCounters(5);
});

afterAll(async () => {
  vi.restoreAllMocks();
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

/** Recall = the share of questions whose answer survived into the block. */
async function measure(strategy: 'frequency' | 'relevance'): Promise<{ recall: number; missed: string[] }> {
  const snap = await snapshotAccess();
  const missed: string[] = [];
  for (const target of TARGETS) {
    await restoreAccess(snap);
    const rows =
      strategy === 'frequency'
        ? await repo.retrieveTop({ userId, limit: LIMIT })
        : await retrieveForContext({ userId, limit: LIMIT, query: target.ask });
    if (!renderMemoriesBlock(rows).includes(target.fact.content)) missed.push(target.ask);
  }
  await restoreAccess(snap);
  return { recall: (TARGETS.length - missed.length) / TARGETS.length, missed };
}

describe('memory recall at the injected-block budget', () => {
  test('the corpus is big enough for the budget to bite', async () => {
    // Without this the whole comparison is vacuous: if everything fits, both
    // strategies score 1.0 and the ordering never mattered.
    const rows = await repo.retrieveTop({ userId, limit: LIMIT });
    const block = renderMemoriesBlock(rows);
    const rendered = block.split('\n').filter((l) => l.startsWith('- ')).length;
    expect(DISTRACTORS.length + TARGETS.length).toBeGreaterThan(LIMIT);
    expect(rendered).toBeLessThan(LIMIT);
  });

  test('frequency + recency alone loses half the answers', async () => {
    const { recall } = await measure('frequency');
    // Query-independent ordering returns one fixed block for every question,
    // so recall is just "how many of the twelve happen to be in that block" —
    // and it cannot be raised by asking a better question. Measured at 50% on
    // this fixture; the bound is loose enough to survive a fixture edit and
    // tight enough that a regression to "ordering does not matter" fails here.
    expect(recall).toBeLessThan(0.6);
  });

  test('ranking against the turn recovers them', async () => {
    const frequency = await measure('frequency');
    const relevance = await measure('relevance');
    // The number this whole file exists to produce. Printed because a
    // benchmark that only asserts a bound tells you it still holds, not where
    // the system actually sits.
    console.info(
      `[memory recall] corpus=${DISTRACTORS.length + TARGETS.length} budget=250tok  ` +
        `frequency=${(frequency.recall * 100).toFixed(0)}%  relevance=${(relevance.recall * 100).toFixed(0)}%`,
    );
    expect(relevance.recall).toBeGreaterThan(0.9);
    expect(relevance.recall - frequency.recall).toBeGreaterThan(0.4);
  });

  test('a fact learned after the counters warmed is still reachable', async () => {
    // The starvation case, stated on its own because it is the one that makes
    // the system feel broken: you tell it something, it agrees, and the fact
    // is invisible from the next turn on because every incumbent already has a
    // higher access_count than a brand-new row can have.
    const ask = 'Which cloud are we deploying to?';
    const content = 'The user moved all client infrastructure to Hetzner in August.';
    await repo.addNew({
      userId, workspaceId: null, agentScope: null,
      factType: 'workflow_note', content,
      embedding: topicVector(1), embeddingVersion: `bench/${TOPIC_COUNT}`,
      sourceMessageId: null, confidence: 1, validUntil: null,
    });
    queryVectors.set(ask, noisyVector(1, 0));

    const stale = renderMemoriesBlock(await repo.retrieveTop({ userId, limit: LIMIT }));
    expect(stale).not.toContain(content);

    const fresh = renderMemoriesBlock(await retrieveForContext({ userId, limit: LIMIT, query: ask }));
    expect(fresh).toContain(content);
  });
});

describe('the fallbacks that keep the relevance pass optional', () => {
  test('no query text → byte-identical to the old behaviour', async () => {
    const snap = await snapshotAccess();
    const before = await repo.retrieveTop({ userId, limit: LIMIT });
    await restoreAccess(snap);
    const after = await retrieveForContext({ userId, limit: LIMIT });
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    await restoreAccess(snap);
  });

  test('an embedding failure costs the ranking, not the memories', async () => {
    embed.mockRejectedValueOnce(new Error('embedding provider unreachable'));
    const rows = await retrieveForContext({ userId, limit: LIMIT, query: TARGETS[0].ask });
    expect(rows.length).toBe(LIMIT);
  });

  test('standing facts keep half the block — one question cannot evict them', async () => {
    // The interleave is what guarantees this. Concatenating instead would let
    // a single topical question fill the block with eight facts about that
    // topic and drop everything the assistant always needs to know.
    const rows = await retrieveForContext({ userId, limit: LIMIT, query: TARGETS[3].ask });
    const relevant = await repo.retrieveRelevant(queryVectors.get(TARGETS[3].ask) as number[], {
      userId, limit: 8,
    });
    const relevantIds = new Set(relevant.map((r) => r.id));
    expect(rows.filter((r) => !relevantIds.has(r.id)).length).toBeGreaterThanOrEqual(rows.length / 2);
  });
});
