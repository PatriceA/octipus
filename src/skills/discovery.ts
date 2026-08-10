/**
 * Hybrid skill discovery — Phase 3 of docs/plans/skill-discovery.md.
 *
 * Read-only: never writes embeddings or triggers refill (cron-only).
 * Never throws — worker spawn must always succeed. DB or embedding
 * failures degrade to empty sets with loud error logs.
 *
 * Algorithm: union four candidate sets, all filtered to active assignments
 * for `opts.topic`:
 *   1. always-inject rows
 *   2. trigger substring match (case-insensitive) against opts.message
 *   3. vector similarity (top-k filtered by minSimilarity), if embedding
 *      service available
 *   4. stale fallback — rows with NULL description_embedding (so freshly
 *      edited skills aren't dropped while waiting for cron refill)
 *
 * Env flag `SKILL_DISCOVERY_MODE`:
 *   - 'topic_only' (case-insensitive) → bit-for-bit legacy behavior:
 *     buildPromptFragmentForMessage delegates to buildTopicPromptFragment;
 *     discoverSkillIds returns all active assignments for the topic.
 *   - any other value / unset → hybrid (the algorithm above).
 */
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { cosineSimilarity } from '@/db/schema/embeddings';
import { skillTopicAssignments } from '@/db/schema/skill-topic-assignments';
import { skills } from '@/db/schema/skills';
import { getEmbeddingService } from '@/core/rag/embeddings';
import { getSkillRegistry } from '@/skills/registry';
import { coreLogger } from '@/utils/logger';

export interface DiscoveryOptions {
  topic: string;
  message: string;
  maxByVector?: number;
  minSimilarity?: number;
}

const DEFAULT_MAX_BY_VECTOR = 5;
const DEFAULT_MIN_SIMILARITY = 0.35;

/** Module-level latch — only warn once per process about a missing embedding model. */
let warnedNoEmbeddingModel = false;
/** Latch for unknown env-flag values — warn once per process. */
let warnedUnknownMode = false;

type DiscoveryMode = 'hybrid' | 'topic_only';

function resolveMode(): DiscoveryMode {
  const raw = process.env.SKILL_DISCOVERY_MODE;
  if (raw == null || raw === '') return 'hybrid';
  const lowered = raw.toLowerCase();
  if (lowered === 'topic_only') return 'topic_only';
  if (lowered === 'hybrid') return 'hybrid';
  if (!warnedUnknownMode) {
    warnedUnknownMode = true;
    coreLogger.warn(
      { mode: raw, component: 'skill-discovery' },
      `Unknown SKILL_DISCOVERY_MODE="${raw}" — falling back to hybrid`,
    );
  }
  return 'hybrid';
}

function isNoEmbeddingModelError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  // Same string-match used by scripts/backfill-skill-embeddings.ts:124.
  return message.includes('No model mapped to topic "embedding"');
}

/** Active topic-assignment ids for a topic. */
async function fetchActiveSkillIdsForTopic(topic: string): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .select({ skillId: skillTopicAssignments.skillId })
    .from(skillTopicAssignments)
    .where(
      and(
        eq(skillTopicAssignments.topic, topic),
        eq(skillTopicAssignments.isActive, true),
      ),
    );
  return rows.map(r => r.skillId);
}

/** Always-inject set, filtered to the topic's active assignment ids. */
async function fetchAlwaysInjectIds(topic: string): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .select({ id: skills.id })
    .from(skills)
    .innerJoin(skillTopicAssignments, eq(skillTopicAssignments.skillId, skills.id))
    .where(
      and(
        eq(skillTopicAssignments.topic, topic),
        eq(skillTopicAssignments.isActive, true),
        eq(skills.alwaysInject, true),
      ),
    );
  return rows.map(r => r.id);
}

/**
 * Trigger substring match. Lowercase the message once, then scan each
 * skill's triggers as case-insensitive substrings (NOT regex — see plan
 * anti-pattern: "Do NOT compile triggers as regex without explicit opt-in").
 */
async function fetchTriggerMatchIds(topic: string, message: string): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .select({ id: skills.id, triggers: skills.triggers })
    .from(skills)
    .innerJoin(skillTopicAssignments, eq(skillTopicAssignments.skillId, skills.id))
    .where(
      and(
        eq(skillTopicAssignments.topic, topic),
        eq(skillTopicAssignments.isActive, true),
      ),
    );

  const lowered = message.toLowerCase();
  const matched: string[] = [];
  for (const row of rows) {
    const triggers = (row.triggers as string[] | null) ?? [];
    if (triggers.length === 0) continue;
    for (const trigger of triggers) {
      if (typeof trigger !== 'string' || trigger.length === 0) continue;
      if (lowered.includes(trigger.toLowerCase())) {
        matched.push(row.id);
        break;
      }
    }
  }
  return matched;
}

/** Vector similarity set. Returns [] if embedding service unavailable. */
async function fetchVectorMatchIds(
  topic: string,
  message: string,
  maxByVector: number,
  minSimilarity: number,
): Promise<string[]> {
  let embedding: number[];
  try {
    embedding = await getEmbeddingService().generateEmbedding(message, 'query');
  } catch (err) {
    if (isNoEmbeddingModelError(err)) {
      if (!warnedNoEmbeddingModel) {
        warnedNoEmbeddingModel = true;
        coreLogger.warn(
          { err, topic, messageLength: message.length, component: 'skill-discovery' },
          'Skill discovery: no embedding model configured — vector path disabled. ' +
            'Triggers + always_inject + stale-fallback still apply.',
        );
      }
      return [];
    }
    coreLogger.error(
      { err, topic, messageLength: message.length, component: 'skill-discovery' },
      'Skill discovery: embedding generation failed — vector set empty, other sets still apply',
    );
    return [];
  }

  const db = getDb();
  const similarityExpr = cosineSimilarity(skills.descriptionEmbedding, embedding);
  const rows = await db
    .select({ id: skills.id, similarity: similarityExpr })
    .from(skills)
    .innerJoin(skillTopicAssignments, eq(skillTopicAssignments.skillId, skills.id))
    .where(
      and(
        eq(skillTopicAssignments.topic, topic),
        eq(skillTopicAssignments.isActive, true),
        isNotNull(skills.descriptionEmbedding),
      ),
    )
    .orderBy(sql`${skills.descriptionEmbedding} <=> ${`[${embedding.join(',')}]`}::vector`)
    .limit(maxByVector);

  return rows
    .filter(r => (Number(r.similarity) || 0) >= minSimilarity)
    .map(r => r.id);
}

/** Stale fallback — rows with NULL embedding (cron hasn't refilled yet). */
async function fetchStaleFallbackIds(topic: string): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .select({ id: skills.id })
    .from(skills)
    .innerJoin(skillTopicAssignments, eq(skillTopicAssignments.skillId, skills.id))
    .where(
      and(
        eq(skillTopicAssignments.topic, topic),
        eq(skillTopicAssignments.isActive, true),
        isNull(skills.descriptionEmbedding),
      ),
    );
  return rows.map(r => r.id);
}

/**
 * Discover the union of skill ids relevant to `opts.message` within
 * `opts.topic`. Never throws — returns [] on any unrecoverable failure.
 */
export async function discoverSkillIds(opts: DiscoveryOptions): Promise<string[]> {
  const mode = resolveMode();
  const maxByVector = opts.maxByVector ?? DEFAULT_MAX_BY_VECTOR;
  const minSimilarity = opts.minSimilarity ?? DEFAULT_MIN_SIMILARITY;

  if (mode === 'topic_only') {
    try {
      const ids = await fetchActiveSkillIdsForTopic(opts.topic);
      return [...new Set(ids)].sort();
    } catch (err) {
      coreLogger.error(
        { err, topic: opts.topic, component: 'skill-discovery' },
        'Skill discovery (topic_only): DB query failed — returning empty set',
      );
      return [];
    }
  }

  // Hybrid mode — run all four candidate queries in parallel. Each path
  // logs and returns [] on failure; aggregate failure → empty union.
  const safe = async <T>(fn: () => Promise<T[]>, label: string): Promise<T[]> => {
    try {
      return await fn();
    } catch (err) {
      coreLogger.error(
        { err, topic: opts.topic, messageLength: opts.message.length, set: label, component: 'skill-discovery' },
        `Skill discovery: ${label} query failed — set treated as empty`,
      );
      return [];
    }
  };

  const [alwaysInject, triggerMatches, vectorMatches, staleFallback] = await Promise.all([
    safe(() => fetchAlwaysInjectIds(opts.topic), 'always_inject'),
    safe(() => fetchTriggerMatchIds(opts.topic, opts.message), 'triggers'),
    // Vector path has its own loud-fail handling internally; safe() guards
    // against pure DB faults outside the embedding call.
    safe(() => fetchVectorMatchIds(opts.topic, opts.message, maxByVector, minSimilarity), 'vector'),
    safe(() => fetchStaleFallbackIds(opts.topic), 'stale_fallback'),
  ]);

  const union = new Set<string>();
  for (const id of alwaysInject) union.add(id);
  for (const id of triggerMatches) union.add(id);
  for (const id of vectorMatches) union.add(id);
  for (const id of staleFallback) union.add(id);

  return [...union].sort();
}

/**
 * Build the `# Domain Knowledge` prompt fragment for a message. In
 * `topic_only` mode, delegates to the legacy `buildTopicPromptFragment`
 * for bit-for-bit parity. In hybrid mode, runs discovery and delegates
 * fragment formatting to `SkillRegistry.buildPromptFragment(ids)`.
 *
 * Never throws — returns '' on any unrecoverable failure.
 */
export async function buildPromptFragmentForMessage(opts: DiscoveryOptions): Promise<string> {
  const mode = resolveMode();
  const registry = getSkillRegistry();

  if (mode === 'topic_only') {
    try {
      return await registry.buildTopicPromptFragment(opts.topic);
    } catch (err) {
      coreLogger.error(
        { err, topic: opts.topic, component: 'skill-discovery' },
        'Skill discovery (topic_only): buildTopicPromptFragment failed — returning empty fragment',
      );
      return '';
    }
  }

  const ids = await discoverSkillIds(opts);
  if (ids.length === 0) return '';
  try {
    return await registry.buildPromptFragment(ids);
  } catch (err) {
    coreLogger.error(
      { err, topic: opts.topic, idCount: ids.length, component: 'skill-discovery' },
      'Skill discovery: buildPromptFragment failed — returning empty fragment',
    );
    return '';
  }
}
