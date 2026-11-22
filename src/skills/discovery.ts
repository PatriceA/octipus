/**
 * Hybrid skill discovery — Phase 3 of docs/plans/skill-discovery.md, plus the
 * user's learned skills (docs/plans/learning-notes-and-skill-discovery.md).
 *
 * Read-only: never writes embeddings (approval and the daily maintenance do).
 * Never throws — worker spawn must always succeed. DB or embedding failures
 * degrade to empty sets with loud error logs.
 *
 * Candidates, never archived:
 *   - ASSIGNED: an active `skill_topic_assignments` row for `opts.topic` or
 *     the lane it resolves to.
 *   - LEARNED (only with `opts.userId`, and never in a shared space): a skill
 *     of that user — own, not system — with no `skill_topic_assignments`
 *     row for any topic, active or not. A skill that has been assigned
 *     follows its assignments only, and one the user deactivated stays off.
 *
 * Sets, unioned:
 *   1. always-inject rows (assigned only: a learned skill never is)
 *   2. trigger substring match (case-insensitive) against opts.message
 *   3. vector similarity: one top-`maxByVector` over both kinds, filtered by
 *      `minSimilarity`, when the message can be embedded
 *   4. stale fallback — assigned rows with NULL description_embedding (so
 *      freshly edited skills aren't dropped while waiting for a refill), and
 *      the `LEARNED_STALE_LIMIT` most recently updated learned ones
 *   5. without a query embedding (no model, or it failed): the
 *      `LEARNED_RECENT_LIMIT` most recently used learned skills
 *
 * The result is a RANKING, best first (`decideTaskSkills` judges the first
 * few): trigger hits, then vector hits by similarity, then always-inject and
 * mounted assignments, then the stale and recent fallbacks. Prompt text built
 * from the ids is ordered by id on its own (skillRepository.findByIds), so the
 * ranking does not move a cached prefix.
 *
 * Env flag `SKILL_DISCOVERY_MODE`:
 *   - 'topic_only' (case-insensitive) → bit-for-bit legacy behavior:
 *     buildPromptFragmentForMessage delegates to buildTopicPromptFragment;
 *     discoverSkillIds returns all active assignments for the topic (no
 *     learned skills).
 *   - any other value / unset → hybrid (the algorithm above).
 */
import { isCapabilityOn } from '@/core/capabilities/gates';
import { and, desc, eq, exists, inArray, isNotNull, isNull, notExists, or, type SQL, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { canonicalTopic } from '@/models/topics';
import { cosineSimilarity } from '@/db/schema/embeddings';
import { skillTopicAssignments } from '@/db/schema/skill-topic-assignments';
import { skills } from '@/db/schema/skills';
import { getEmbeddingService } from '@/core/rag/embeddings';
import { getSkillRegistry } from '@/skills/registry';
import { isExternalSkillId } from './external-loader';
import { coreLogger } from '@/utils/logger';

export interface DiscoveryOptions {
  topic: string;
  message: string;
  /**
   * The turn's user. Given: their learned skills are candidates, and only ids
   * they can see (system, own, their orgs', not hidden) are returned.
   * Omitted: assigned skills only, unfiltered — the behaviour before learned
   * skills.
   */
  userId?: string;
  /**
   * The agent works in a shared space. Personal learned skills are then not
   * candidates, as personal notes are not recalled there; assigned skills are
   * unchanged.
   */
  inSpace?: boolean;
  maxByVector?: number;
  minSimilarity?: number;
}

export type LearnedDiscoveryOptions = Omit<DiscoveryOptions, 'topic' | 'userId'> & { userId: string };

const DEFAULT_MAX_BY_VECTOR = 5;
const DEFAULT_MIN_SIMILARITY = 0.35;
/** Learned skills listed when the message cannot be embedded. */
export const LEARNED_RECENT_LIMIT = 10;
/** Learned skills with no embedding yet that stay candidates while a model exists. */
export const LEARNED_STALE_LIMIT = 3;

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

/** The topic names an assignment for `topic` may be stored under: the role, and the lane it resolves to. */
function topicNames(topic: string): string[] {
  return [...new Set([topic, canonicalTopic(topic)])];
}

/**
 * Assignments for a role, and for the LANE that role resolves to.
 *
 * Skills are keyed by role on purpose — a lane is a cost class, and `build`
 * covers coding, devops, data, security and architecture at once, so keying
 * skills to it would inject a financial-analysis skill into a devops worker.
 * But the assignment UI lists whatever `GET /topics` returns, which is lanes,
 * so an assignment made there was written under a name no worker ever looks up.
 * Both names are matched, which keeps existing lane assignments working without
 * making a lane the unit of expertise.
 */
export async function fetchActiveSkillIdsForTopic(topic: string): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .select({ skillId: skillTopicAssignments.skillId })
    .from(skillTopicAssignments)
    .where(
      and(
        inArray(skillTopicAssignments.topic, topicNames(topic)),
        eq(skillTopicAssignments.isActive, true),
      ),
    );
  // Sorted: the ids order the prompt text built from them (see
  // skillRepository.findByIds), and the query has no order of its own.
  return [...new Set(rows.map(r => getSkillRegistry().canonicalId(r.skillId)))].sort();
}

/** Which skills a discovery call may return. */
interface Scope {
  /** The role whose active assignments (under its own or its lane's name) are candidates; null: none. */
  topic: string | null;
  /** The user whose learned skills are candidates; null: none. */
  learner: string | null;
}

/** An active assignment of the row for one of `names`. */
function assignedTo(names: string[]): SQL {
  return exists(
    getDb().select({ one: sql`1` }).from(skillTopicAssignments).where(and(
      eq(skillTopicAssignments.skillId, skills.id),
      inArray(skillTopicAssignments.topic, names),
      eq(skillTopicAssignments.isActive, true),
    )),
  );
}

/**
 * A learned skill of `userId`: own, not system, and never assigned — no
 * `skill_topic_assignments` row for any topic, active or inactive. An inactive
 * row is the user switching the skill off for a role; counting it as
 * "unassigned" would bring the skill back for every role. Whoever wrote the
 * skill does not matter: one the user wrote by hand and never assigned is a
 * candidate as well as one approved from a proposal.
 */
function learnedBy(userId: string): SQL {
  return and(
    eq(skills.userId, userId),
    eq(skills.isSystem, false),
    notExists(
      getDb().select({ one: sql`1` }).from(skillTopicAssignments).where(eq(skillTopicAssignments.skillId, skills.id)),
    ),
  ) as SQL;
}

/** Either kind of candidate in `scope`, not archived. Undefined when the scope is empty. */
function candidateWhere(scope: Scope): SQL | undefined {
  const kinds = [
    ...(scope.topic !== null ? [assignedTo(topicNames(scope.topic))] : []),
    ...(scope.learner ? [learnedBy(scope.learner)] : []),
  ];
  if (kinds.length === 0) return undefined;
  return and(isNull(skills.archivedAt), kinds.length === 1 ? kinds[0] : or(...kinds)) as SQL;
}

/** Always-inject set: active assignments only, never a learned skill. */
async function fetchAlwaysInjectIds(names: string[]): Promise<string[]> {
  const rows = await getDb()
    .select({ id: skills.id })
    .from(skills)
    .where(and(isNull(skills.archivedAt), eq(skills.alwaysInject, true), assignedTo(names)));
  return rows.map(r => r.id);
}

/**
 * Trigger substring match. Lowercase the message once, then scan each
 * skill's triggers as case-insensitive substrings (NOT regex — see plan
 * anti-pattern: "Do NOT compile triggers as regex without explicit opt-in").
 */
async function fetchTriggerMatchIds(where: SQL, message: string): Promise<string[]> {
  const rows = await getDb()
    .select({ id: skills.id, triggers: skills.triggers })
    .from(skills)
    .where(where);

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

/** The message's query embedding, or null when there is none (no model, or it failed). */
async function embedQuery(message: string, logTopic: string): Promise<number[] | null> {
  if (!isCapabilityOn('embedding')) return null;
  try {
    return await getEmbeddingService().generateEmbedding(message, 'query');
  } catch (err) {
    if (isNoEmbeddingModelError(err)) {
      if (!warnedNoEmbeddingModel) {
        warnedNoEmbeddingModel = true;
        coreLogger.warn(
          { err, topic: logTopic, messageLength: message.length, component: 'skill-discovery' },
          'Skill discovery: no embedding model configured — vector path disabled. ' +
            'Triggers, always_inject, the stale fallback and the recent learned skills still apply.',
        );
      }
      return null;
    }
    coreLogger.error(
      { err, topic: logTopic, messageLength: message.length, component: 'skill-discovery' },
      'Skill discovery: embedding generation failed — vector set empty, other sets still apply',
    );
    return null;
  }
}

/** Vector similarity set, nearest first, at or above `minSimilarity`. */
async function fetchVectorMatches(
  where: SQL,
  embedding: number[],
  maxByVector: number,
  minSimilarity: number,
): Promise<Array<{ id: string; similarity: number }>> {
  const similarityExpr = cosineSimilarity(skills.descriptionEmbedding, embedding);
  const rows = await getDb()
    .select({ id: skills.id, similarity: similarityExpr })
    .from(skills)
    .where(and(where, isNotNull(skills.descriptionEmbedding)))
    .orderBy(sql`${skills.descriptionEmbedding} <=> ${`[${embedding.join(',')}]`}::vector`)
    .limit(maxByVector);

  return rows
    .map(r => ({ id: r.id, similarity: Number(r.similarity) || 0 }))
    .filter(r => r.similarity >= minSimilarity);
}

/** Stale fallback — assigned rows with NULL embedding (no refill yet). */
async function fetchStaleAssignedIds(names: string[]): Promise<string[]> {
  const rows = await getDb()
    .select({ id: skills.id })
    .from(skills)
    .where(and(isNull(skills.archivedAt), isNull(skills.descriptionEmbedding), assignedTo(names)));
  return rows.map(r => r.id);
}

/** Learned skills with NULL embedding, most recently updated first, at most `LEARNED_STALE_LIMIT`. */
async function fetchStaleLearnedIds(userId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ id: skills.id })
    .from(skills)
    .where(and(isNull(skills.archivedAt), isNull(skills.descriptionEmbedding), learnedBy(userId)))
    .orderBy(desc(skills.updatedAt), skills.id)
    .limit(LEARNED_STALE_LIMIT);
  return rows.map(r => r.id);
}

/** The most recently used learned skills (never used: by creation), at most `LEARNED_RECENT_LIMIT`. */
async function fetchRecentLearnedIds(userId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ id: skills.id })
    .from(skills)
    .where(and(isNull(skills.archivedAt), learnedBy(userId)))
    .orderBy(sql`${skills.lastUsedAt} desc nulls last`, desc(skills.createdAt), skills.id)
    .limit(LEARNED_RECENT_LIMIT);
  return rows.map(r => r.id);
}

/** Rank tiers, best first. An id found by several sets takes its best tier. */
const TIER = { trigger: 0, vector: 1, standing: 2, stale: 3, recent: 4 } as const;

class Ranking {
  private readonly entries = new Map<string, { tier: number; similarity: number; position: number }>();
  private next = 0;

  add(id: string, tier: number, similarity = Number.NEGATIVE_INFINITY): void {
    const current = this.entries.get(id);
    if (!current) {
      this.entries.set(id, { tier, similarity, position: this.next++ });
      return;
    }
    if (tier < current.tier) current.tier = tier;
    if (similarity > current.similarity) current.similarity = similarity;
  }

  /** Tier, then similarity, then the order the sets produced them in. */
  ids(): string[] {
    return [...this.entries]
      .sort(([, a], [, b]) => a.tier - b.tier || b.similarity - a.similarity || a.position - b.position)
      .map(([id]) => id);
  }
}

interface RunOptions {
  message: string;
  maxByVector: number;
  minSimilarity: number;
  logTopic: string;
}

/** The hybrid algorithm over `scope`, ranked. */
async function discoverInScope(scope: Scope, opts: RunOptions): Promise<string[]> {
  const where = candidateWhere(scope);
  if (!where) return [];
  const { topic, learner } = scope;
  const names = topic === null ? null : topicNames(topic);

  // Each path logs and returns [] on failure; aggregate failure → empty union.
  const safe = async <T>(fn: () => Promise<T[]>, label: string): Promise<T[]> => {
    try {
      return await fn();
    } catch (err) {
      coreLogger.error(
        { err, topic: opts.logTopic, messageLength: opts.message.length, set: label, component: 'skill-discovery' },
        `Skill discovery: ${label} query failed — set treated as empty`,
      );
      return [];
    }
  };

  // The sets that do not depend on the query embedding run while it is computed.
  const standing = Promise.all([
    names ? safe(() => fetchAlwaysInjectIds(names), 'always_inject') : [],
    safe(() => fetchTriggerMatchIds(where, opts.message), 'triggers'),
    names ? safe(() => fetchStaleAssignedIds(names), 'stale_fallback') : [],
    topic !== null ? safe(() => fetchActiveSkillIdsForTopic(topic), 'mounted_assignments') : [],
  ]);
  const embedding = await embedQuery(opts.message, opts.logTopic);
  const [vectorMatches, learnedFallback] = await Promise.all([
    embedding ? safe(() => fetchVectorMatches(where, embedding, opts.maxByVector, opts.minSimilarity), 'vector') : [],
    // With a query embedding a learned skill is found by meaning; only one not
    // embedded yet needs the fallback, and a bounded one. Without, the most
    // recently used learned skills stand in for the vector path.
    !learner ? [] : embedding
      ? safe(() => fetchStaleLearnedIds(learner), 'learned_stale_fallback')
      : safe(() => fetchRecentLearnedIds(learner), 'learned_recent'),
  ]);
  const [alwaysInject, triggerMatches, staleAssigned, assigned] = await standing;

  const ranking = new Ranking();
  // Vector similarity orders the trigger hits too, where the vector set found them.
  const similarity = new Map(vectorMatches.map(m => [m.id, m.similarity]));
  for (const id of triggerMatches) ranking.add(id, TIER.trigger, similarity.get(id));
  for (const { id, similarity: sim } of vectorMatches) ranking.add(id, TIER.vector, sim);
  for (const id of alwaysInject) ranking.add(id, TIER.standing);
  for (const id of assigned.filter(isExternalSkillId)) ranking.add(id, TIER.standing);
  for (const id of staleAssigned) ranking.add(id, TIER.stale);
  for (const id of learnedFallback) ranking.add(id, embedding ? TIER.stale : TIER.recent);
  return ranking.ids();
}

/** Only the ids `userId` can see, in the given order. Fails closed: [] when visibility cannot be read. */
async function visibleOnly(ids: string[], userId: string, logTopic: string): Promise<string[]> {
  if (ids.length === 0) return [];
  try {
    const visible = new Set((await getSkillRegistry().getByIds(ids, userId)).map(s => s.id));
    return ids.filter(id => visible.has(id));
  } catch (err) {
    coreLogger.error(
      { err, topic: logTopic, idCount: ids.length, component: 'skill-discovery' },
      'Skill discovery: visibility check failed — returning no skills rather than unchecked ones',
    );
    return [];
  }
}

/**
 * Discover the skills relevant to `opts.message` for an agent of role
 * `opts.topic`, best first. Never throws — returns [] on any unrecoverable
 * failure.
 */
export async function discoverSkillIds(opts: DiscoveryOptions): Promise<string[]> {
  const mode = resolveMode();

  if (mode === 'topic_only') {
    try {
      const ids = [...new Set(await fetchActiveSkillIdsForTopic(opts.topic))].sort();
      return opts.userId ? await visibleOnly(ids, opts.userId, opts.topic) : ids;
    } catch (err) {
      coreLogger.error(
        { err, topic: opts.topic, component: 'skill-discovery' },
        'Skill discovery (topic_only): DB query failed — returning empty set',
      );
      return [];
    }
  }

  const ids = await discoverInScope(
    { topic: opts.topic, learner: opts.userId && !opts.inSpace ? opts.userId : null },
    {
      message: opts.message,
      maxByVector: opts.maxByVector ?? DEFAULT_MAX_BY_VECTOR,
      minSimilarity: opts.minSimilarity ?? DEFAULT_MIN_SIMILARITY,
      logTopic: opts.topic,
    },
  );
  return opts.userId ? visibleOnly(ids, opts.userId, opts.topic) : ids;
}

/**
 * Only the learned-skill half of `discoverSkillIds`, by the same rule: for an
 * agent that gets no role-assignment index of its own from discovery (the
 * root turn). [] in a shared space and in `topic_only` mode.
 */
export async function discoverLearnedSkillIds(opts: LearnedDiscoveryOptions): Promise<string[]> {
  if (opts.inSpace || resolveMode() === 'topic_only') return [];
  const ids = await discoverInScope(
    { topic: null, learner: opts.userId },
    {
      message: opts.message,
      maxByVector: opts.maxByVector ?? DEFAULT_MAX_BY_VECTOR,
      minSimilarity: opts.minSimilarity ?? DEFAULT_MIN_SIMILARITY,
      logTopic: 'learned',
    },
  );
  return visibleOnly(ids, opts.userId, 'learned');
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
    return await registry.buildPromptFragment(ids, opts.userId);
  } catch (err) {
    coreLogger.error(
      { err, topic: opts.topic, idCount: ids.length, component: 'skill-discovery' },
      'Skill discovery: buildPromptFragment failed — returning empty fragment',
    );
    return '';
  }
}
