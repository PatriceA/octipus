/**
 * Unit tests for hybrid skill discovery (Phase 5 of
 * docs/plans/skill-discovery.md).
 *
 * Strategy: ephemeral PGlite + module-level mock of
 * `@/core/rag/embeddings` so vector tests use deterministic vectors and
 * never call the real provider. Each test seeds rows it needs and the
 * `afterAll` hook drops the DB directory entirely — no shared state
 * leaks across the suite.
 *
 * Branches covered (Phase 3 verification list):
 *   - always_inject hit
 *   - trigger hit (case-insensitive)
 *   - vector hit (mocked deterministic embedding)
 *   - all-empty (no candidates, no assignments)
 *   - embedding-unavailable (mock throws "no model" → vector set empty,
 *     other sets still work, no exception bubbles up)
 *   - env-flag-off (SKILL_DISCOVERY_MODE=topic_only → all active
 *     assignments returned, regardless of message)
 *   - dedupe (skill matched by trigger AND vector appears once)
 *   - minSimilarity floor (vector hit below threshold excluded)
 *   - stale-fallback (description_embedding NULL row included)
 *   - staleness invalidation (skillRepository.update() NULLs the
 *     embedding column so the next discovery call still sees the row).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── Required env (must be set before any import that reads config) ──
const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';
process.env.STORAGE_MODE = 'embedded';
const DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-skill-discovery-'));
process.env.DATA_DIR = DATA_DIR;

// ── Module mocks (must come BEFORE the SUT import) ──────────────────
//
// `currentEmbedding` lets each test swap the vector returned by the
// embedding service. `embeddingError` lets us simulate the
// "no embedding model configured" path (which the SUT detects via
// substring match on the error message).
let currentEmbedding: number[] | null = null;
let embeddingError: Error | null = null;

// Eagerly load the real module before we replace it. `mock.module` is
// process-wide in bun, so we must spread the real exports into the mock —
// otherwise other test files that legitimately import the real module
// (e.g. src/core/rag/embeddings.test.ts uses the real `EmbeddingService`
// class directly) end up with `undefined` exports.
import * as realEmbeddings from '@/core/rag/embeddings';

mock.module('@/core/rag/embeddings', () => ({
  ...realEmbeddings,
  getEmbeddingService: () => ({
    generateEmbedding: async (_text: string) => {
      if (embeddingError) throw embeddingError;
      if (!currentEmbedding) {
        // Default — neutral zero-ish vector (won't match anything via cosine).
        return new Array(1024).fill(0).map((_, i) => (i === 0 ? 1 : 0));
      }
      return currentEmbedding;
    },
  }),
}));

// ── Imports (must come after mock.module) ──────────────────────────
import { eq } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { skillTopicAssignments } from '@/db/schema/skill-topic-assignments';
import { skills } from '@/db/schema/skills';
import { skillRepository } from '@/db/repositories/skill-repository';
// Note: discoverSkillIds is imported lazily inside each test so env-flag
// changes (SKILL_DISCOVERY_MODE) take effect — the SUT reads
// process.env on every call so eager import is also fine, but lazy keeps
// the intent explicit.

// ── Test topic — unique per file run so we never collide with other tests ──
const TEST_TOPIC = `test-discovery-${rand(4)}`;

// Three orthogonal, normalized 1024-dim vectors so cosine sim is
// deterministic: same vector ⇒ sim ~1.0, orthogonal ⇒ sim ~0.0.
const VEC_A = new Array(1024).fill(0).map((_, i) => (i === 0 ? 1 : 0));
const VEC_B = new Array(1024).fill(0).map((_, i) => (i === 1 ? 1 : 0));
const VEC_C = new Array(1024).fill(0).map((_, i) => (i === 2 ? 1 : 0));

beforeAll(async () => {
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
});

afterAll(async () => {
  // Best-effort: clean up everything we added under TEST_TOPIC, then
  // close the DB and rm the data dir.
  try {
    const db = getDb();
    const ourRows = await db
      .select({ skillId: skillTopicAssignments.skillId })
      .from(skillTopicAssignments)
      .where(eq(skillTopicAssignments.topic, TEST_TOPIC));
    const ourSkillIds = ourRows.map((r) => r.skillId);
    await db.delete(skillTopicAssignments).where(eq(skillTopicAssignments.topic, TEST_TOPIC));
    for (const id of ourSkillIds) {
      await db.delete(skills).where(eq(skills.id, id));
    }
  } catch {
    // swallow — cleanup is best-effort, the rmSync below guarantees isolation
  }
  try {
    const { closeDb } = await import('@/db/postgres');
    await closeDb();
  } catch (err) {
    // Teardown best-effort — surface it at debug level so a hung
    // connection is still discoverable in logs without failing the
    // test cleanup itself.
    console.debug('discovery.test teardown: closeDb failed', err);
  }
  rmSync(DATA_DIR, { recursive: true, force: true });
});

// Wipe rows assigned to TEST_TOPIC between tests so each one starts clean.
async function clearTestTopic(): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({ skillId: skillTopicAssignments.skillId })
    .from(skillTopicAssignments)
    .where(eq(skillTopicAssignments.topic, TEST_TOPIC));
  const ids = rows.map((r) => r.skillId);
  await db.delete(skillTopicAssignments).where(eq(skillTopicAssignments.topic, TEST_TOPIC));
  for (const id of ids) {
    await db.delete(skills).where(eq(skills.id, id));
  }
}

interface SeedOpts {
  id: string;
  name?: string;
  description?: string;
  triggers?: string[];
  alwaysInject?: boolean;
  embedding?: number[] | null; // null ⇒ stale fallback path
  assignToTopic?: boolean;     // default true
}

async function seedSkill(opts: SeedOpts): Promise<void> {
  const db = getDb();
  await db.insert(skills).values({
    id: opts.id,
    name: opts.name ?? opts.id,
    description: opts.description ?? `${opts.id} description`,
    triggers: opts.triggers ?? [],
    alwaysInject: opts.alwaysInject ?? false,
    descriptionEmbedding: opts.embedding === undefined ? null : opts.embedding,
    isSystem: true,
  });
  if (opts.assignToTopic !== false) {
    await db.insert(skillTopicAssignments).values({
      skillId: opts.id,
      topic: TEST_TOPIC,
      isActive: true,
    });
  }
}

beforeEach(async () => {
  // Reset all per-test state.
  currentEmbedding = null;
  embeddingError = null;
  delete process.env.SKILL_DISCOVERY_MODE;
  await clearTestTopic();
});

// ─────────────────────────────────────────────────────────────────────
// Branch tests
// ─────────────────────────────────────────────────────────────────────

describe('discoverSkillIds — hybrid mode', () => {
  test('always_inject hit: skill appears for any message regardless of triggers/vector', async () => {
    await seedSkill({ id: 'always-1', alwaysInject: true });
    await seedSkill({ id: 'unrelated-1' });
    const { discoverSkillIds } = await import('./discovery');
    const ids = await discoverSkillIds({ topic: TEST_TOPIC, message: 'completely unrelated message' });
    expect(ids).toContain('always-1');
  });

  test('trigger hit: case-insensitive substring match ("Push" → trigger "push")', async () => {
    // Both rows get a non-null (orthogonal) embedding so neither is pulled
    // in via stale-fallback — we want to assert the trigger path in isolation.
    await seedSkill({ id: 'git-skill', triggers: ['push', 'commit'], embedding: VEC_A });
    await seedSkill({ id: 'no-trigger', embedding: VEC_B });
    currentEmbedding = VEC_C; // orthogonal to both → no vector hits above floor
    const { discoverSkillIds } = await import('./discovery');
    const ids = await discoverSkillIds({
      topic: TEST_TOPIC,
      message: 'Please Push my changes',
      minSimilarity: 0.5,
    });
    expect(ids).toContain('git-skill');
    expect(ids).not.toContain('no-trigger');
  });

  test('vector hit: skill with matching embedding above minSimilarity is returned', async () => {
    await seedSkill({ id: 'vec-hit', embedding: VEC_A });
    await seedSkill({ id: 'vec-miss', embedding: VEC_B });
    currentEmbedding = VEC_A; // message embeds to VEC_A → sim(vec-hit)=1, sim(vec-miss)=0
    const { discoverSkillIds } = await import('./discovery');
    const ids = await discoverSkillIds({
      topic: TEST_TOPIC,
      message: 'pretend this embeds to VEC_A',
      minSimilarity: 0.5,
    });
    expect(ids).toContain('vec-hit');
    expect(ids).not.toContain('vec-miss');
  });

  test('minSimilarity floor: vector hit below threshold is excluded', async () => {
    // Two skills, both with embeddings but neither close to message vector.
    await seedSkill({ id: 'vec-far-1', embedding: VEC_B });
    await seedSkill({ id: 'vec-far-2', embedding: VEC_C });
    currentEmbedding = VEC_A;
    const { discoverSkillIds } = await import('./discovery');
    const ids = await discoverSkillIds({
      topic: TEST_TOPIC,
      message: 'unrelated',
      minSimilarity: 0.5,
    });
    expect(ids).not.toContain('vec-far-1');
    expect(ids).not.toContain('vec-far-2');
  });

  test('all-empty: no assignments → returns []', async () => {
    const { discoverSkillIds } = await import('./discovery');
    const ids = await discoverSkillIds({ topic: TEST_TOPIC, message: 'whatever' });
    expect(ids).toEqual([]);
  });

  test('embedding-unavailable: vector set empty, other sets still work', async () => {
    embeddingError = new Error('No model mapped to topic "embedding". Assign one in the Models page.');
    await seedSkill({ id: 'always-2', alwaysInject: true });
    await seedSkill({ id: 'trig-2', triggers: ['hello'] });
    await seedSkill({ id: 'vec-2', embedding: VEC_A });

    const { discoverSkillIds } = await import('./discovery');
    const ids = await discoverSkillIds({ topic: TEST_TOPIC, message: 'hello world' });
    expect(ids).toContain('always-2');
    expect(ids).toContain('trig-2');
    // vec-2 has a non-null embedding, so it's NOT included via stale fallback,
    // and the vector set is empty because the embedding service threw.
    expect(ids).not.toContain('vec-2');
  });

  test('embedding-unavailable does not throw — discovery degrades gracefully', async () => {
    embeddingError = new Error('No model mapped to topic "embedding". Assign one in the Models page.');
    await seedSkill({ id: 'any-skill' });
    const { discoverSkillIds } = await import('./discovery');
    // Just assert it resolves rather than rejects.
    await expect(
      discoverSkillIds({ topic: TEST_TOPIC, message: 'hi' })
    ).resolves.toBeArray();
  });

  test('dedupe: skill matched by trigger AND vector appears once', async () => {
    await seedSkill({ id: 'both-paths', triggers: ['python'], embedding: VEC_A });
    currentEmbedding = VEC_A;
    const { discoverSkillIds } = await import('./discovery');
    const ids = await discoverSkillIds({
      topic: TEST_TOPIC,
      message: 'write some Python code',
      minSimilarity: 0.5,
    });
    const occurrences = ids.filter((x) => x === 'both-paths').length;
    expect(occurrences).toBe(1);
  });

  test('stale-fallback: skill with NULL description_embedding is included automatically', async () => {
    await seedSkill({ id: 'stale-1', embedding: null });
    currentEmbedding = VEC_B; // unrelated to test that vector path didn't match it
    const { discoverSkillIds } = await import('./discovery');
    const ids = await discoverSkillIds({
      topic: TEST_TOPIC,
      message: 'anything',
      minSimilarity: 0.5,
    });
    expect(ids).toContain('stale-1');
  });

  test('inactive assignment is excluded even with always_inject=true', async () => {
    const db = getDb();
    await db.insert(skills).values({
      id: 'inactive-1',
      name: 'inactive-1',
      description: 'd',
      alwaysInject: true,
      isSystem: true,
    });
    await db.insert(skillTopicAssignments).values({
      skillId: 'inactive-1',
      topic: TEST_TOPIC,
      isActive: false, // <-- inactive
    });
    const { discoverSkillIds } = await import('./discovery');
    const ids = await discoverSkillIds({ topic: TEST_TOPIC, message: 'anything' });
    expect(ids).not.toContain('inactive-1');
  });
});

describe('discoverSkillIds — env-flag rollback (topic_only)', () => {
  test('SKILL_DISCOVERY_MODE=topic_only returns all active assignments regardless of message', async () => {
    await seedSkill({ id: 't-1' });
    await seedSkill({ id: 't-2', triggers: ['python'] });
    await seedSkill({ id: 't-3', alwaysInject: true });
    process.env.SKILL_DISCOVERY_MODE = 'topic_only';
    const { discoverSkillIds } = await import('./discovery');
    const ids = await discoverSkillIds({
      topic: TEST_TOPIC,
      message: 'totally unrelated message — would not trigger anything',
    });
    // All three active assignments included.
    expect([...ids].sort()).toEqual(['t-1', 't-2', 't-3']);
  });

  test('topic_only output equals legacy registry.getActiveSkillsForTopic mapped to ids', async () => {
    await seedSkill({ id: 'leg-a' });
    await seedSkill({ id: 'leg-b' });
    process.env.SKILL_DISCOVERY_MODE = 'topic_only';

    const { discoverSkillIds } = await import('./discovery');
    const { getSkillRegistry } = await import('./registry');

    const discovered = await discoverSkillIds({ topic: TEST_TOPIC, message: 'x' });
    const legacy = (await getSkillRegistry().getActiveSkillsForTopic(TEST_TOPIC))
      .map((s) => s.id)
      .sort();

    expect(discovered.sort()).toEqual(legacy);
  });

  test('SKILL_DISCOVERY_MODE casing is normalized (TOPIC_ONLY also works)', async () => {
    await seedSkill({ id: 'c-1' });
    process.env.SKILL_DISCOVERY_MODE = 'TOPIC_ONLY';
    const { discoverSkillIds } = await import('./discovery');
    const ids = await discoverSkillIds({ topic: TEST_TOPIC, message: 'x' });
    expect(ids).toContain('c-1');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Staleness invalidation: skillRepository.update() NULLs the embedding,
// and the next discovery call still picks the row up via stale-fallback.
// ─────────────────────────────────────────────────────────────────────

describe('staleness invalidation', () => {
  test('updating description NULLs description_embedding AND row stays discoverable via stale fallback', async () => {
    await seedSkill({
      id: 'stale-update',
      name: 'Original Name',
      description: 'Original description text',
      embedding: VEC_A,
    });

    // Sanity check: row currently has a non-null embedding.
    const db = getDb();
    const [before] = await db.select().from(skills).where(eq(skills.id, 'stale-update'));
    expect(before.descriptionEmbedding).not.toBeNull();

    // Update the description — repository should NULL the embedding column.
    const updated = await skillRepository.update('stale-update', {
      description: 'Brand new description text',
    });
    expect(updated).toBeDefined();

    const [after] = await db.select().from(skills).where(eq(skills.id, 'stale-update'));
    expect(after.descriptionEmbedding).toBeNull();
    expect(after.descriptionHash).toBeNull();

    // Now run discovery — vector path won't match, but stale fallback must include it.
    currentEmbedding = VEC_B; // unrelated
    const { discoverSkillIds } = await import('./discovery');
    const ids = await discoverSkillIds({
      topic: TEST_TOPIC,
      message: 'totally unrelated',
      minSimilarity: 0.5,
    });
    expect(ids).toContain('stale-update');
  });
});

// ─────────────────────────────────────────────────────────────────────
// buildPromptFragmentForMessage — wire-in seam.
//
// Proves the function (used by both worker-spawner and swarm/spawner)
// produces fragments that vary by message. This is the cheaper proxy
// for the "wire-in capture-prompt test" — it validates the API the
// wire-in calls, without standing up agent infra.
// ─────────────────────────────────────────────────────────────────────

describe('buildPromptFragmentForMessage — output varies by message', () => {
  test('two different messages yield different fragments when triggers differentiate them', async () => {
    // Non-null embeddings on both so stale-fallback doesn't pull in the
    // negative case; we want only the trigger path to differentiate them.
    await seedSkill({
      id: 'git-frag',
      name: 'Git Workflow',
      description: 'How to use git effectively',
      triggers: ['push', 'commit'],
      embedding: VEC_A,
    });
    await seedSkill({
      id: 'py-frag',
      name: 'Python Tips',
      description: 'Python idioms and tooling',
      triggers: ['python'],
      embedding: VEC_B,
    });

    currentEmbedding = VEC_C; // orthogonal to both → no vector hits
    const { buildPromptFragmentForMessage } = await import('./discovery');
    const fragGit = await buildPromptFragmentForMessage({
      topic: TEST_TOPIC,
      message: 'please push my changes',
    });
    const fragPy = await buildPromptFragmentForMessage({
      topic: TEST_TOPIC,
      message: 'help me write a python function',
    });

    expect(fragGit).toContain('Git Workflow');
    expect(fragGit).not.toContain('Python Tips');

    expect(fragPy).toContain('Python Tips');
    expect(fragPy).not.toContain('Git Workflow');

    expect(fragGit).not.toEqual(fragPy);
  });

  test('topic_only mode produces same fragment regardless of message', async () => {
    await seedSkill({
      id: 'leg-frag-1',
      name: 'Skill One',
      description: 'first',
    });
    await seedSkill({
      id: 'leg-frag-2',
      name: 'Skill Two',
      description: 'second',
    });
    process.env.SKILL_DISCOVERY_MODE = 'topic_only';
    const { buildPromptFragmentForMessage } = await import('./discovery');

    const a = await buildPromptFragmentForMessage({ topic: TEST_TOPIC, message: 'foo' });
    const b = await buildPromptFragmentForMessage({ topic: TEST_TOPIC, message: 'bar' });
    expect(a).toEqual(b);
    expect(a).toContain('Skill One');
    expect(a).toContain('Skill Two');
  });
});
