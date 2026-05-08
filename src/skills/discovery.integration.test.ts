/**
 * Integration tests for hybrid skill discovery (Phase 5 of
 * docs/plans/skill-discovery.md).
 *
 * Seeds 5 skills with mixed configurations (always_inject / triggers /
 * embeddings / NULL embedding / no triggers and no embedding),
 * assigns them all to a single test topic, then asserts the union
 * returned for several messages.
 *
 * Like the unit suite, this uses ephemeral PGlite + a module-level
 * mock for the embedding service so vector behaviour is deterministic.
 * The two test files use distinct DATA_DIRs and distinct test topics
 * so they don't share state when the suite runs in parallel.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';
process.env.STORAGE_MODE = 'embedded';
const DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-skill-discovery-int-'));
process.env.DATA_DIR = DATA_DIR;

let currentEmbedding: number[] | null = null;

mock.module('@/core/rag/embeddings', () => ({
  getEmbeddingService: () => ({
    generateEmbedding: async (_text: string) => {
      if (!currentEmbedding) return new Array(1024).fill(0).map((_, i) => (i === 0 ? 1 : 0));
      return currentEmbedding;
    },
  }),
}));

import { eq } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { skillTopicAssignments } from '@/db/schema/skill-topic-assignments';
import { skills } from '@/db/schema/skills';

const TEST_TOPIC = `int-discovery-${rand(4)}`;

// Three orthogonal unit vectors → cosine sim is 1.0 (same) or 0.0 (different).
const PYTHON_VEC = new Array(1024).fill(0).map((_, i) => (i === 10 ? 1 : 0));
const GIT_VEC = new Array(1024).fill(0).map((_, i) => (i === 11 ? 1 : 0));
const ARCH_VEC = new Array(1024).fill(0).map((_, i) => (i === 12 ? 1 : 0));

const SEEDED_SKILL_IDS = [
  'int-skill-always',
  'int-skill-trigger',
  'int-skill-vector',
  'int-skill-stale',
  'int-skill-orphan',
];

beforeAll(async () => {
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();

  const db = getDb();
  // 1. always_inject — appears in every spawn for the topic.
  await db.insert(skills).values({
    id: 'int-skill-always',
    name: 'Always-On Skill',
    description: 'Tiny critical guidance that always applies',
    alwaysInject: true,
    isSystem: true,
  });
  // 2. trigger — keyword match. Has its own (non-PYTHON) embedding so
  // it isn't pulled in via stale-fallback or vector-similarity by default.
  await db.insert(skills).values({
    id: 'int-skill-trigger',
    name: 'Git Workflow',
    description: 'How to use git effectively',
    triggers: ['push', 'commit', 'rebase'],
    descriptionEmbedding: GIT_VEC,
    isSystem: true,
  });
  // 3. vector — only matched via embedding similarity.
  await db.insert(skills).values({
    id: 'int-skill-vector',
    name: 'Python Tips',
    description: 'Python idioms and tooling',
    descriptionEmbedding: PYTHON_VEC,
    isSystem: true,
  });
  // 4. stale — embedding is NULL (cron hasn't backfilled yet).
  await db.insert(skills).values({
    id: 'int-skill-stale',
    name: 'Newly Edited Skill',
    description: 'Description was just changed',
    isSystem: true,
  });
  // 5. orphan — no triggers, no embedding, not always_inject. Should
  //    appear via stale-fallback (NULL embedding) but never via
  //    triggers or vector.
  await db.insert(skills).values({
    id: 'int-skill-orphan',
    name: 'Architecture Notes',
    description: 'High-level architecture references',
    descriptionEmbedding: ARCH_VEC,
    isSystem: true,
  });

  // Assign all 5 to the test topic, all active.
  for (const id of SEEDED_SKILL_IDS) {
    await db.insert(skillTopicAssignments).values({
      skillId: id,
      topic: TEST_TOPIC,
      isActive: true,
    });
  }
});

afterAll(async () => {
  // Clean up everything we seeded — per memory feedback_e2e_session_cleanup.
  try {
    const db = getDb();
    await db.delete(skillTopicAssignments).where(eq(skillTopicAssignments.topic, TEST_TOPIC));
    for (const id of SEEDED_SKILL_IDS) {
      await db.delete(skills).where(eq(skills.id, id));
    }
  } catch {
    // best-effort
  }
  try {
    const { closeDb } = await import('@/db/postgres');
    await closeDb();
  } catch {}
  rmSync(DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  currentEmbedding = null;
  delete process.env.SKILL_DISCOVERY_MODE;
});

describe('discoverSkillIds — integration: 5-skill seeded fixture', () => {
  test('"hello" (no triggers, neutral vector) → only always_inject + stale row', async () => {
    currentEmbedding = new Array(1024).fill(0).map((_, i) => (i === 50 ? 1 : 0)); // unrelated
    const { discoverSkillIds } = await import('./discovery');
    const ids = await discoverSkillIds({
      topic: TEST_TOPIC,
      message: 'hello',
      minSimilarity: 0.5,
    });
    expect(ids).toContain('int-skill-always');
    expect(ids).toContain('int-skill-stale'); // NULL embedding → stale fallback
    expect(ids).not.toContain('int-skill-trigger');
    expect(ids).not.toContain('int-skill-vector');
    expect(ids).not.toContain('int-skill-orphan');
  });

  test('"please push my changes" → trigger hit on git skill, plus always-inject + stale', async () => {
    currentEmbedding = new Array(1024).fill(0).map((_, i) => (i === 50 ? 1 : 0));
    const { discoverSkillIds } = await import('./discovery');
    const ids = await discoverSkillIds({
      topic: TEST_TOPIC,
      message: 'please push my changes',
      minSimilarity: 0.5,
    });
    expect(ids).toContain('int-skill-trigger');
    expect(ids).toContain('int-skill-always');
    expect(ids).toContain('int-skill-stale');
    expect(ids).not.toContain('int-skill-vector');
  });

  test('python message vector hit → vector skill included (mocked PYTHON_VEC)', async () => {
    currentEmbedding = PYTHON_VEC;
    const { discoverSkillIds } = await import('./discovery');
    const ids = await discoverSkillIds({
      topic: TEST_TOPIC,
      message: 'help with snakes', // doesn't match any trigger
      minSimilarity: 0.5,
    });
    expect(ids).toContain('int-skill-vector');
    expect(ids).toContain('int-skill-always');
    expect(ids).toContain('int-skill-stale');
    expect(ids).not.toContain('int-skill-trigger');
  });

  test('combined message ("push and python") → trigger AND vector both hit, dedupe holds', async () => {
    currentEmbedding = PYTHON_VEC;
    const { discoverSkillIds } = await import('./discovery');
    const ids = await discoverSkillIds({
      topic: TEST_TOPIC,
      message: 'push and python work',
      minSimilarity: 0.5,
    });
    expect(ids).toContain('int-skill-trigger');
    expect(ids).toContain('int-skill-vector');
    expect(ids).toContain('int-skill-always');
    expect(ids).toContain('int-skill-stale');

    // No duplicates anywhere.
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('SKILL_DISCOVERY_MODE=topic_only ↔ legacy registry equivalence', () => {
  test('topic_only output equals registry.getActiveSkillsForTopic mapped to ids', async () => {
    process.env.SKILL_DISCOVERY_MODE = 'topic_only';

    const { discoverSkillIds } = await import('./discovery');
    const { getSkillRegistry } = await import('./registry');

    const discovered = await discoverSkillIds({
      topic: TEST_TOPIC,
      message: 'any message — topic_only ignores it',
    });
    const legacy = (await getSkillRegistry().getActiveSkillsForTopic(TEST_TOPIC))
      .map((s) => s.id)
      .sort();

    expect(discovered.sort()).toEqual(legacy);
    // Sanity: should contain all 5 seeded skills.
    expect(discovered).toContain('int-skill-always');
    expect(discovered).toContain('int-skill-trigger');
    expect(discovered).toContain('int-skill-vector');
    expect(discovered).toContain('int-skill-stale');
    expect(discovered).toContain('int-skill-orphan');
  });
});
