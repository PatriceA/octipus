/**
 * Learned skills in discovery (docs/plans/learning-notes-and-skill-discovery.md,
 * "Skill discovery"): a skill of the user with no topic assignment row is a
 * candidate for every role, by meaning and by trigger, never always-injected;
 * without an embedding model the most recently used ones are listed; never
 * another user's, an archived one, or one in a shared space.
 *
 * Embedded PGlite in memory, deterministic mocked embeddings, as discovery.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('@electric-sql/pglite', async importOriginal => {
  const actual = await importOriginal<typeof import('@electric-sql/pglite')>();
  return { ...actual, PGlite: { create: (options: Record<string, unknown>) => actual.PGlite.create({ ...options, dataDir: undefined }) } };
});
vi.mock('@/skills/external-loader', async importOriginal => ({
  ...await importOriginal<typeof import('@/skills/external-loader')>(),
  loadExternalSkills: () => [],
}));

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';
process.env.STORAGE_MODE = 'embedded';
const DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-skill-discovery-learned-'));
process.env.DATA_DIR = DATA_DIR;

let currentEmbedding: number[] | null = null;
let embeddingError: Error | null = null;
/** Calls of the query embedding; `embeddingHangs`: it never answers (a stalled provider). */
let embedCalls = 0;
let embeddingHangs = false;
vi.mock('@/core/rag/embeddings', async () => ({
  ...(await vi.importActual<typeof import('@/core/rag/embeddings')>('@/core/rag/embeddings')),
  getEmbeddingService: () => ({
    generateEmbedding: async (_text: string) => {
      embedCalls++;
      if (embeddingHangs) await new Promise(() => {});
      if (embeddingError) throw embeddingError;
      return currentEmbedding ?? unit(1023);
    },
  }),
}));

import { getDb } from '@/db/postgres';
import { skillTopicAssignments } from '@/db/schema/skill-topic-assignments';
import { skills } from '@/db/schema/skills';
import { setCapabilitiesForTest } from '@/core/capabilities/gates';
import { discoverLearnedSkillIds, discoverSkillIds, LEARNED_RECENT_LIMIT, LEARNED_STALE_LIMIT } from './discovery';

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ROLE_A = `role-a-${rand(3)}`;
const ROLE_B = `role-b-${rand(3)}`;

/** Unit vector along axis `i` (1024 dims): equal axes ⇒ similarity 1, different ⇒ 0. */
function unit(i: number): number[] {
  return new Array(1024).fill(0).map((_, j) => (j === i ? 1 : 0));
}
/** Similarity `cos` with unit(0). */
function towardA(cos: number): number[] {
  return new Array(1024).fill(0).map((_, j) => (j === 0 ? cos : j === 1 ? Math.sqrt(1 - cos * cos) : 0));
}

beforeAll(async () => {
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: ME, username: 'learner' }, { id: OTHER, username: 'someone-else' }]);
}, 120_000);

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

beforeEach(async () => {
  currentEmbedding = null;
  embeddingError = null;
  embedCalls = 0;
  embeddingHangs = false;
  delete process.env.SKILL_DISCOVERY_MODE;
  setCapabilitiesForTest({ embedding: true });
  await getDb().delete(skillTopicAssignments);
  await getDb().delete(skills);
});

interface Seed {
  id?: string;
  userId?: string | null;
  isSystem?: boolean;
  embedding?: number[] | null;
  triggers?: string[];
  alwaysInject?: boolean;
  archivedAt?: Date | null;
  lastUsedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
  assign?: { topic: string; isActive?: boolean };
}

async function seed(opts: Seed = {}): Promise<string> {
  const id = opts.id ?? `skill-${randomUUID().slice(0, 8)}`;
  await getDb().insert(skills).values({
    id,
    name: id,
    description: `${id} description`,
    userId: opts.userId === undefined ? ME : opts.userId,
    isSystem: opts.isSystem ?? false,
    descriptionEmbedding: opts.embedding === undefined ? unit(0) : opts.embedding,
    triggers: opts.triggers ?? [],
    alwaysInject: opts.alwaysInject ?? false,
    archivedAt: opts.archivedAt ?? null,
    lastUsedAt: opts.lastUsedAt ?? null,
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    ...(opts.updatedAt ? { updatedAt: opts.updatedAt } : {}),
  });
  if (opts.assign) {
    await getDb().insert(skillTopicAssignments).values({ skillId: id, topic: opts.assign.topic, isActive: opts.assign.isActive ?? true });
  }
  return id;
}

const discover = (topic: string, message = 'some task', extra: Record<string, unknown> = {}) =>
  discoverSkillIds({ topic, message, userId: ME, minSimilarity: 0.5, ...extra });

describe('a learned skill with no assignment', () => {
  test('is discovered by meaning for two different roles', async () => {
    const learned = await seed({ embedding: unit(0) });
    currentEmbedding = unit(0);
    expect(await discover(ROLE_A)).toContain(learned);
    expect(await discover(ROLE_B)).toContain(learned);
  });

  test('below the similarity threshold it is not', async () => {
    const learned = await seed({ embedding: towardA(0.4) });
    currentEmbedding = unit(0);
    expect(await discover(ROLE_A)).not.toContain(learned);
    expect(await discover(ROLE_A, 'x', { minSimilarity: 0.3 })).toContain(learned);
  });

  test('shares the vector top-k with assigned skills and ranks by similarity across both', async () => {
    const assignedFar = await seed({ userId: null, isSystem: true, embedding: towardA(0.7), assign: { topic: ROLE_A } });
    const learnedNear = await seed({ embedding: towardA(0.95) });
    const learnedMid = await seed({ embedding: towardA(0.8) });
    currentEmbedding = unit(0);
    expect(await discover(ROLE_A)).toEqual([learnedNear, learnedMid, assignedFar]);
    expect(await discover(ROLE_A, 'x', { maxByVector: 2 })).toEqual([learnedNear, learnedMid]);
  });

  test('matches by trigger, ranked before vector hits', async () => {
    const byVector = await seed({ embedding: unit(0) });
    const byTrigger = await seed({ embedding: unit(5), triggers: ['Deploy Checklist'] });
    currentEmbedding = unit(0);
    expect(await discover(ROLE_A, 'run the deploy checklist please')).toEqual([byTrigger, byVector]);
    expect(await discover(ROLE_A, 'unrelated')).toEqual([byVector]);
  });

  test('always_inject never applies to it', async () => {
    const learned = await seed({ embedding: unit(7), alwaysInject: true });
    currentEmbedding = unit(0);
    expect(await discover(ROLE_A)).not.toContain(learned);
  });

  test('without a user it is not a candidate (callers without one keep the old behaviour)', async () => {
    const learned = await seed({ embedding: unit(0) });
    currentEmbedding = unit(0);
    expect(await discoverSkillIds({ topic: ROLE_A, message: 'x', minSimilarity: 0.5 })).not.toContain(learned);
  });
});

describe('what is never returned', () => {
  test("another user's learned skill — by vector, trigger, stale or recent fallback", async () => {
    const theirs = await seed({ userId: OTHER, embedding: unit(0), triggers: ['deploy'] });
    const theirsStale = await seed({ userId: OTHER, embedding: null });
    currentEmbedding = unit(0);
    expect(await discover(ROLE_A, 'deploy')).toEqual([]);
    setCapabilitiesForTest({ embedding: false });
    const ids = await discover(ROLE_A, 'deploy');
    expect(ids).not.toContain(theirs);
    expect(ids).not.toContain(theirsStale);
  });

  test("another user's personal skill assigned to the role is dropped when the user is given", async () => {
    const theirsAssigned = await seed({ userId: OTHER, embedding: unit(0), assign: { topic: ROLE_A } });
    currentEmbedding = unit(0);
    expect(await discover(ROLE_A)).not.toContain(theirsAssigned);
    // Without a user, unfiltered as before (callers filter by visibility).
    expect(await discoverSkillIds({ topic: ROLE_A, message: 'x', minSimilarity: 0.5 })).toContain(theirsAssigned);
  });

  test('an archived learned skill', async () => {
    const archived = await seed({ embedding: unit(0), triggers: ['deploy'], archivedAt: new Date() });
    currentEmbedding = unit(0);
    expect(await discover(ROLE_A, 'deploy')).not.toContain(archived);
    setCapabilitiesForTest({ embedding: false });
    expect(await discover(ROLE_A, 'deploy')).not.toContain(archived);
  });

  test('a system skill without an assignment is not a learned skill', async () => {
    const system = await seed({ userId: null, isSystem: true, embedding: unit(0) });
    currentEmbedding = unit(0);
    expect(await discover(ROLE_A)).not.toContain(system);
  });
});

test('a learned skill with an active topic assignment follows only the assignment', async () => {
  const assigned = await seed({ embedding: unit(0), alwaysInject: true, assign: { topic: ROLE_A } });
  currentEmbedding = unit(0);
  expect(await discover(ROLE_A)).toContain(assigned);
  expect(await discover(ROLE_B)).not.toContain(assigned);
  // Its assignment's always_inject applies to its own role only.
  currentEmbedding = unit(9);
  expect(await discover(ROLE_A)).toContain(assigned);
  expect(await discover(ROLE_B)).not.toContain(assigned);
});

test('a skill whose only assignment rows are inactive is not a learned-skill candidate and is not discovered', async () => {
  const deactivated = await seed({ embedding: unit(0), triggers: ['deploy'], assign: { topic: ROLE_A, isActive: false } });
  currentEmbedding = unit(0);
  expect(await discover(ROLE_A, 'deploy')).not.toContain(deactivated);
  expect(await discover(ROLE_B, 'deploy')).not.toContain(deactivated);
  expect(await discoverLearnedSkillIds({ userId: ME, message: 'deploy', minSimilarity: 0.5 })).not.toContain(deactivated);
  setCapabilitiesForTest({ embedding: false });
  expect(await discover(ROLE_B, 'deploy')).not.toContain(deactivated);
});

test('a skill the user wrote and never assigned is a candidate like an approved one', async () => {
  const handWritten = await seed({ embedding: unit(0) });
  await getDb().update(skills).set({ ownerEditedAt: new Date() });
  currentEmbedding = unit(0);
  expect(await discover(ROLE_B)).toContain(handWritten);
});

describe('without an embedding model', () => {
  const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

  async function seedMany(): Promise<string[]> {
    // 12 learned skills: s0 used most recently … s9; two never used, created long ago.
    const used = [];
    for (let i = 0; i < 10; i++) used.push(await seed({ id: `recent-${i}`, embedding: null, lastUsedAt: minutesAgo(i + 1) }));
    await seed({ id: 'never-new', embedding: null, createdAt: minutesAgo(5000) });
    await seed({ id: 'never-old', embedding: null, createdAt: minutesAgo(9000) });
    return used;
  }

  test.each([
    ['the capability is off', () => { setCapabilitiesForTest({ embedding: false }); }],
    ['the model is missing', () => { embeddingError = new Error('No model mapped to topic "embedding". Assign one.'); }],
  ])('%s: the 10 most recently used learned skills, most recent first', async (_label, setup) => {
    const used = await seedMany();
    setup();
    const ids = await discover(ROLE_A, 'anything');
    expect(LEARNED_RECENT_LIMIT).toBe(10);
    expect(ids).toEqual(used);
  });

  test('never-used skills come after used ones, newest first, inside the cap', async () => {
    await seed({ id: 'used', embedding: null, lastUsedAt: minutesAgo(1) });
    await seed({ id: 'never-old', embedding: null, createdAt: minutesAgo(9000) });
    await seed({ id: 'never-new', embedding: null, createdAt: minutesAgo(5000) });
    setCapabilitiesForTest({ embedding: false });
    expect(await discover(ROLE_A)).toEqual(['used', 'never-new', 'never-old']);
  });

  test('a trigger hit still ranks first and is not counted against the cap', async () => {
    const used = await seedMany();
    await seed({ id: 'triggered', embedding: null, triggers: ['invoice'], createdAt: minutesAgo(99999) });
    setCapabilitiesForTest({ embedding: false });
    expect(await discover(ROLE_A, 'send the invoice')).toEqual(['triggered', ...used]);
  });
});

test('with a model, learned skills not embedded yet stay candidates, the 3 most recently updated', async () => {
  const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
  const stale = [];
  for (let i = 0; i < 5; i++) stale.push(await seed({ id: `stale-${i}`, embedding: null, updatedAt: minutesAgo(i + 1) }));
  const near = await seed({ embedding: unit(0) });
  currentEmbedding = unit(0);
  expect(LEARNED_STALE_LIMIT).toBe(3);
  // The vector hit first; then the newest three not yet embedded.
  expect(await discover(ROLE_A)).toEqual([near, ...stale.slice(0, 3)]);
});

describe('shared spaces', () => {
  test('a personal learned skill is not a candidate for an agent in a space; assigned skills are', async () => {
    const learned = await seed({ embedding: unit(0), triggers: ['deploy'] });
    const assigned = await seed({ userId: null, isSystem: true, embedding: unit(0), assign: { topic: ROLE_A } });
    currentEmbedding = unit(0);
    const ids = await discover(ROLE_A, 'deploy', { inSpace: true });
    expect(ids).toEqual([assigned]);
    expect(ids).not.toContain(learned);
    setCapabilitiesForTest({ embedding: false });
    expect(await discover(ROLE_A, 'deploy', { inSpace: true })).not.toContain(learned);
  });

  test('the root path returns none in a space', async () => {
    const learned = await seed({ embedding: unit(0) });
    currentEmbedding = unit(0);
    expect(await discoverLearnedSkillIds({ userId: ME, message: 'x', minSimilarity: 0.5 })).toEqual([learned]);
    expect(await discoverLearnedSkillIds({ userId: ME, message: 'x', minSimilarity: 0.5, inSpace: true })).toEqual([]);
  });
});

describe('discoverLearnedSkillIds (the root turn)', () => {
  test('only learned skills of the user, by the same rule', async () => {
    const learned = await seed({ embedding: unit(0) });
    const far = await seed({ embedding: unit(3) });
    const assigned = await seed({ embedding: unit(0), assign: { topic: 'general' } });
    const system = await seed({ userId: null, isSystem: true, embedding: unit(0), assign: { topic: 'general' } });
    const theirs = await seed({ userId: OTHER, embedding: unit(0) });
    currentEmbedding = unit(0);
    const ids = await discoverLearnedSkillIds({ userId: ME, message: 'x', minSimilarity: 0.5 });
    expect(ids).toEqual([learned]);
    for (const id of [far, assigned, system, theirs]) expect(ids).not.toContain(id);
  });

  test('topic_only mode returns none (the legacy rollback has no learned skills)', async () => {
    await seed({ embedding: unit(0) });
    currentEmbedding = unit(0);
    process.env.SKILL_DISCOVERY_MODE = 'topic_only';
    expect(await discoverLearnedSkillIds({ userId: ME, message: 'x', minSimilarity: 0.5 })).toEqual([]);
  });
});

describe('the root turn block', () => {
  test('lists the learned skills under its own heading, not the role index one a CLI root keys on; none in a space', async () => {
    const learned = await seed({ embedding: unit(0) });
    currentEmbedding = unit(0);
    const { learnedSkillsBlock } = await import('@/core/agent/root-runner');
    const block = await learnedSkillsBlock(ME, 'x', false);
    expect(block).toContain('# Learned Skills');
    expect(block).toContain(`\`${learned}\``);
    expect(block).not.toContain('Available skills (call `get_skill`');
    expect(await learnedSkillsBlock(ME, 'x', true)).toBe('');
    expect(await learnedSkillsBlock(OTHER, 'x', false)).toBe('');
  });
});

describe('the root turn block, bounded', () => {
  test('a user with no learned skill costs one existence query, no embedding call', async () => {
    await seed({ userId: OTHER });
    await seed({ assign: { topic: ROLE_A } });
    const { learnedSkillsBlock } = await import('@/core/agent/root-runner');
    expect(await learnedSkillsBlock(ME, 'deploy the preview', false)).toBe('');
    expect(embedCalls).toBe(0);
  });

  test('a stalled embedding provider drops the block at the start deadline instead of holding the turn', async () => {
    await seed({ embedding: unit(0) });
    embeddingHangs = true;
    const { learnedSkillsBlock } = await import('@/core/agent/root-runner');
    const { START_DEADLINE_MS } = await import('@/core/context-hooks/run');
    const started = Date.now();
    expect(await learnedSkillsBlock(ME, 'x', false)).toBe('');
    expect(embedCalls).toBe(1);
    expect(Date.now() - started).toBeLessThan(START_DEADLINE_MS + 1500);
  }, 15_000);
});
