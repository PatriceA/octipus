/**
 * "Do we already have this skill?" — decides what filing a distilled skill
 * does: drop it, merge it into an open proposal, or insert a new one
 * (docs/plans/self-learning-consolidation.md, "Dedup and filing").
 *
 * Order, cheapest first:
 *   1. fingerprint (normalized name) on this user's latest proposal:
 *      pending/candidate → merge; rejected and still suppressed → drop;
 *      merged → follow `merged_into_id` once and treat that row the same way;
 *      promoted (or anything else) → go on.
 *   2. live skill with the same normalized name, or embedding similarity at
 *      or above `learning.duplicateSimilarity` → drop.
 *   3. this user's open or still-suppressed rejected non-patch proposals,
 *      compared in SQL by their stored embedding: suppressed duplicate →
 *      drop; `extendsProposalId` naming an open one → merge; open duplicate →
 *      merge; open one in the related band → merge with `allowDistinct`.
 *   4. otherwise insert.
 *
 * Without an embedding model the name checks and `extendsProposalId` still
 * work. Every decision is logged as `{ decision, similarity, against }`
 * (calibration data for the thresholds).
 */
import { and, desc, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { getConfig } from '@/config';
import { isCapabilityOn } from '@/core/capabilities/gates';
import { getEmbeddingService } from '@/core/rag/embeddings';
import { getDb } from '@/db/postgres';
import { cosineSimilarity } from '@/db/schema/embeddings';
import { type SkillProposalRecord, skillProposals } from '@/db/schema/skill-proposals';
import { skills } from '@/db/schema/skills';
import { ensureProposalEmbeddings, ensureSkillEmbeddings } from '@/skills/embedding-backfill';
import { toolLogger } from '@/utils/logger';
import { type DistilledSkill, normalizeSkillName, similarityText } from './distiller';

/** The latest proposal of a fingerprint, when it still blocks filing the same one again. */
export type ProposalHit =
  /** Open (pending or a not yet shown candidate). */
  | { kind: 'pending'; id: string; name: string; status: 'pending' | 'candidate' }
  /** The user rejected it and the suppression window is still open. */
  | { kind: 'suppressed'; id: string; name: string; until: Date }
  /** Approved already. A skill proposal falls through to the live-skill check; an identical patch is a duplicate. */
  | { kind: 'promoted'; id: string; name: string };

/**
 * Shared with patch proposals (src/services/file-skill-proposal.ts):
 * `userId`'s latest proposal with this fingerprint — open, rejected and still
 * inside its suppression, or promoted. Null when there is none, its rejection
 * has expired, or it was merged into another.
 */
export async function findProposalByFingerprint(userId: string, fingerprint: string): Promise<ProposalHit | null> {
  const row = await latestByFingerprint(userId, fingerprint);
  return row ? hitOf(row) : null;
}

function hitOf(row: Pick<SkillProposalRecord, 'id' | 'name' | 'status' | 'rejectedUntil'>): ProposalHit | null {
  if (row.status === 'pending' || row.status === 'candidate') return { kind: 'pending', id: row.id, name: row.name, status: row.status };
  if (row.status === 'promoted') return { kind: 'promoted', id: row.id, name: row.name };
  if (row.status === 'rejected' && row.rejectedUntil && row.rejectedUntil > new Date()) {
    return { kind: 'suppressed', id: row.id, name: row.name, until: row.rejectedUntil };
  }
  return null;
}

async function latestByFingerprint(userId: string, fingerprint: string): Promise<SkillProposalRecord | null> {
  const [row] = await getDb().select().from(skillProposals)
    .where(and(eq(skillProposals.fingerprint, fingerprint), eq(skillProposals.userId, userId)))
    .orderBy(desc(skillProposals.createdAt))
    .limit(1);
  return row ?? null;
}

/** What filing a distilled skill should do. `embedding` is the incoming skill's, null without a model. */
export type DedupDecision =
  /** Already a live skill: nothing filed. */
  | { action: 'drop'; reason: 'skill'; id: string; name: string; similarity?: number }
  /** The user rejected this skill (or one equal to it) and it is still suppressed. */
  | { action: 'drop'; reason: 'suppressed'; id: string; name: string; until: Date; similarity?: number }
  /**
   * Merge into the open proposal `target`. With `allowDistinct` (the related
   * band) the merge model may answer that it is a different skill; the caller
   * then inserts.
   */
  | {
    action: 'merge';
    via: 'fingerprint' | 'extends' | 'similarity' | 'related';
    target: SkillProposalRecord;
    allowDistinct: boolean;
    similarity?: number;
    embedding: number[] | null;
  }
  /** Nothing like it: file a new proposal. */
  | { action: 'insert'; embedding: number[] | null };

export interface DedupOptions {
  /** An open proposal of the user the reviewer said this extends (a bare id or `proposal:<id>`). */
  extendsProposalId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN_STATUSES: Array<'pending' | 'candidate'> = ['pending', 'candidate'];

function logDecision(decision: DedupDecision, userId: string, name: string): DedupDecision {
  const label = decision.action === 'drop' ? `drop:${decision.reason}`
    : decision.action === 'merge' ? `merge:${decision.via}${decision.allowDistinct ? ':allow-distinct' : ''}` : 'insert';
  const against = decision.action === 'drop' ? decision.id : decision.action === 'merge' ? decision.target.id : null;
  const similarity = decision.action === 'insert' ? null : (decision.similarity ?? null);
  toolLogger.info({ decision: label, similarity, against, userId, name }, 'Skill proposal dedup decision');
  return decision;
}

/** Step 1 on one row: what its status means for filing again. Null: go on. */
function byRow(row: SkillProposalRecord): DedupDecision | null {
  const hit = hitOf(row);
  if (hit?.kind === 'pending') return { action: 'merge', via: 'fingerprint', target: row, allowDistinct: false, embedding: null };
  if (hit?.kind === 'suppressed') return { action: 'drop', reason: 'suppressed', id: hit.id, name: hit.name, until: hit.until };
  return null;
}

async function openProposalOf(userId: string, id: string): Promise<SkillProposalRecord | null> {
  const [row] = await getDb().select().from(skillProposals)
    .where(and(eq(skillProposals.id, id), eq(skillProposals.userId, userId), inArray(skillProposals.status, OPEN_STATUSES), ne(skillProposals.kind, 'patch')))
    .limit(1);
  return row ?? null;
}

/** The incoming skill's embedding, after bringing the stored ones up to date. Null without a model. */
async function incomingEmbedding(userId: string, distilled: DistilledSkill): Promise<number[] | null> {
  if (!isCapabilityOn('embedding')) return null;
  await ensureSkillEmbeddings({ limit: 20 });
  await ensureProposalEmbeddings(userId, { limit: 20 });
  try {
    return await getEmbeddingService().generateEmbedding(similarityText(distilled), 'document');
  } catch (err) {
    toolLogger.warn({ err, userId }, 'Skill dedup: no embedding available — name checks only');
    return null;
  }
}

/** Stored vectors of another dimension (an earlier embedding model) cannot be compared and are skipped. */
function sameDims(column: typeof skills.descriptionEmbedding | typeof skillProposals.embedding, embedding: number[]) {
  return sql`vector_dims(${column}) = ${embedding.length}`;
}

function distanceOrder(column: typeof skills.descriptionEmbedding | typeof skillProposals.embedding, embedding: number[]) {
  return sql`${column} <=> ${`[${embedding.join(',')}]`}::vector`;
}

/**
 * What filing `distilled` for `userId` should do (see the module comment).
 * Throws on database errors only; an unavailable embedding model degrades to
 * the name checks.
 */
export async function decideSkillProposal(
  userId: string,
  fingerprint: string,
  distilled: DistilledSkill,
  opts: DedupOptions = {},
): Promise<DedupDecision> {
  const db = getDb();
  const { duplicateSimilarity, relatedSimilarity } = getConfig().learning;
  const decide = (decision: DedupDecision) => logDecision(decision, userId, distilled.name);

  // 1. Same normalized name, same user. A merged row is followed once.
  const latest = await latestByFingerprint(userId, fingerprint);
  if (latest) {
    let decision = byRow(latest);
    if (!decision && latest.status === 'merged' && latest.mergedIntoId) {
      const [into] = await db.select().from(skillProposals)
        .where(and(eq(skillProposals.id, latest.mergedIntoId), eq(skillProposals.userId, userId))).limit(1);
      if (into) decision = byRow(into);
    }
    if (decision) return decide(decision);
  }

  const visibleSkills = and(
    or(eq(skills.userId, userId), eq(skills.isSystem, true)),
    isNull(skills.archivedAt),
  );

  // 2a. Same normalized name as a live skill. Skipped for a name that
  // normalizes to nothing ('---'), which would otherwise match every other
  // such name.
  const normalized = normalizeSkillName(distilled.name);
  const [named] = normalized ? await db
    .select({ id: skills.id, name: skills.name })
    .from(skills)
    .where(and(
      visibleSkills,
      // Same normalization as normalizeSkillName(), in SQL.
      sql`trim(both '-' from lower(regexp_replace(${skills.name}, '[^a-zA-Z0-9]+', '-', 'g'))) = ${normalized}`,
    ))
    .limit(1) : [];
  if (named) return decide({ action: 'drop', reason: 'skill', id: named.id, name: named.name });

  const embedding = await incomingEmbedding(userId, distilled);

  // 2b. Semantically the same as a live skill.
  if (embedding) {
    const [similarSkill] = await db
      .select({ id: skills.id, name: skills.name, similarity: cosineSimilarity(skills.descriptionEmbedding, embedding) })
      .from(skills)
      .where(and(visibleSkills, isNotNull(skills.descriptionEmbedding), sameDims(skills.descriptionEmbedding, embedding)))
      .orderBy(distanceOrder(skills.descriptionEmbedding, embedding))
      .limit(1);
    const similarity = Number(similarSkill?.similarity);
    if (similarSkill && similarity >= duplicateSimilarity) {
      return decide({ action: 'drop', reason: 'skill', id: similarSkill.id, name: similarSkill.name, similarity });
    }
  }

  // 3. The user's other proposals. A patch proposal's draft is an existing
  // skill's text, not a new skill, so patches never take part.
  const nearest = async (status: 'open' | 'suppressed', vector: number[]) => {
    const statusWhere = status === 'open'
      ? inArray(skillProposals.status, OPEN_STATUSES)
      : and(eq(skillProposals.status, 'rejected'), gt(skillProposals.rejectedUntil, new Date()));
    const [row] = await db
      .select({ id: skillProposals.id, similarity: cosineSimilarity(skillProposals.embedding, vector) })
      .from(skillProposals)
      .where(and(
        eq(skillProposals.userId, userId),
        ne(skillProposals.kind, 'patch'),
        statusWhere,
        isNotNull(skillProposals.embedding),
        sameDims(skillProposals.embedding, vector),
      ))
      .orderBy(distanceOrder(skillProposals.embedding, vector))
      .limit(1);
    return row ? { id: row.id, similarity: Number(row.similarity) } : null;
  };

  if (embedding) {
    const suppressed = await nearest('suppressed', embedding);
    if (suppressed && suppressed.similarity >= duplicateSimilarity) {
      const [row] = await db.select({ id: skillProposals.id, name: skillProposals.name, rejectedUntil: skillProposals.rejectedUntil })
        .from(skillProposals).where(eq(skillProposals.id, suppressed.id)).limit(1);
      if (row?.rejectedUntil) {
        return decide({ action: 'drop', reason: 'suppressed', id: row.id, name: row.name, until: row.rejectedUntil, similarity: suppressed.similarity });
      }
    }
  }

  if (opts.extendsProposalId) {
    const id = opts.extendsProposalId.replace(/^proposal:/, '');
    const target = UUID.test(id) ? await openProposalOf(userId, id) : null;
    if (target) return decide({ action: 'merge', via: 'extends', target, allowDistinct: false, embedding });
    toolLogger.warn({ userId, extendsProposalId: opts.extendsProposalId }, 'Skill dedup: extendsProposalId names no open proposal of the user; ignored');
  }

  if (embedding) {
    const open = await nearest('open', embedding);
    if (open && open.similarity >= relatedSimilarity) {
      const target = await openProposalOf(userId, open.id);
      if (target) {
        const duplicate = open.similarity >= duplicateSimilarity;
        return decide({
          action: 'merge', via: duplicate ? 'similarity' : 'related', target,
          allowDistinct: !duplicate, similarity: open.similarity, embedding,
        });
      }
    }
  }

  return decide({ action: 'insert', embedding });
}
