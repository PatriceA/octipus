/**
 * "Do we already have this skill?" — the guard that stops the distiller filing
 * the same procedure over and over.
 *
 * Three checks, cheapest first:
 *   1. fingerprint (normalized name) against this user's proposals — including
 *      REJECTED ones still inside their 90-day suppression window, which
 *      nothing read before, so a rejection stopped nothing.
 *   2. normalized name against live skills.
 *   3. embedding similarity against live skills and pending proposals — the
 *      only check that catches the same procedure under a different name
 *      ("vault-token-rotation" vs "secure-credential-rotation").
 *
 * Never throws: an unavailable embedding model degrades to checks 1-2.
 */
import { and, desc, eq, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { getEmbeddingService } from '@/core/rag/embeddings';
import { getDb } from '@/db/postgres';
import { cosineSimilarity } from '@/db/schema/embeddings';
import { skillProposals } from '@/db/schema/skill-proposals';
import { skills } from '@/db/schema/skills';
import { toolLogger } from '@/utils/logger';
import {
  cosine,
  type DistilledSkill,
  NEAR_DUPLICATE_SIMILARITY,
  normalizeSkillName,
  similarityText,
} from './distiller';

export type DedupHit =
  /** An open proposal for this skill is already queued for review. */
  | { kind: 'pending'; id: string; name: string; similarity?: number }
  /** The user rejected this skill and the suppression window is still open. */
  | { kind: 'suppressed'; id: string; name: string; until: Date }
  /** It is already a live skill. */
  | { kind: 'skill'; id: string; name: string; similarity?: number };

/** Cap on the proposals embedded per call — the pending queue is small by design. */
const MAX_PENDING_COMPARED = 20;

/**
 * The existing skill or proposal this distillation duplicates, or null when it
 * is genuinely new.
 */
export async function findExisting(
  userId: string,
  fingerprint: string,
  distilled: DistilledSkill,
): Promise<DedupHit | null> {
  const db = getDb();

  // 1. Same normalized name, same user — whatever state it is in.
  const [byFingerprint] = await db
    .select()
    .from(skillProposals)
    .where(and(eq(skillProposals.fingerprint, fingerprint), eq(skillProposals.userId, userId)))
    .orderBy(desc(skillProposals.createdAt))
    .limit(1);

  if (byFingerprint) {
    if (byFingerprint.status === 'pending') {
      return { kind: 'pending', id: byFingerprint.id, name: byFingerprint.name };
    }
    if (byFingerprint.status === 'rejected' && byFingerprint.rejectedUntil && byFingerprint.rejectedUntil > new Date()) {
      return {
        kind: 'suppressed',
        id: byFingerprint.id,
        name: byFingerprint.name,
        until: byFingerprint.rejectedUntil,
      };
    }
    // 'promoted' falls through to the live-skill checks below, which name the
    // skill it became; an expired rejection is fair game to re-propose.
  }

  const visibleSkills = and(
    or(eq(skills.userId, userId), eq(skills.isSystem, true)),
    isNull(skills.archivedAt),
  );

  // 2. Same normalized name as a live skill. Skipped for a name that
  // normalizes to nothing ('---'), which would otherwise match every other
  // such name.
  const normalized = normalizeSkillName(distilled.name);
  const [named] = normalized ? await db
    .select({ id: skills.id, name: skills.name })
    .from(skills)
    .where(
      and(
        visibleSkills,
        // Same normalization as normalizeSkillName(), in SQL.
        sql`trim(both '-' from lower(regexp_replace(${skills.name}, '[^a-zA-Z0-9]+', '-', 'g'))) = ${normalized}`,
      ),
    )
    .limit(1) : [];
  if (named) return { kind: 'skill', id: named.id, name: named.name };

  // 3. Semantically the same thing under another name.
  let embedding: number[];
  try {
    embedding = await getEmbeddingService().generateEmbedding(similarityText(distilled), 'document');
  } catch (err) {
    toolLogger.warn({ err }, 'Skill dedup: no embedding available — name checks only');
    return null;
  }

  const [similarSkill] = await db
    .select({ id: skills.id, name: skills.name, similarity: cosineSimilarity(skills.descriptionEmbedding, embedding) })
    .from(skills)
    .where(and(visibleSkills, isNotNull(skills.descriptionEmbedding)))
    .orderBy(sql`${skills.descriptionEmbedding} <=> ${`[${embedding.join(',')}]`}::vector`)
    .limit(1);
  if (similarSkill && Number(similarSkill.similarity) >= NEAR_DUPLICATE_SIMILARITY) {
    return {
      kind: 'skill',
      id: similarSkill.id,
      name: similarSkill.name,
      similarity: Number(similarSkill.similarity),
    };
  }

  // Proposals carry no stored embedding, so the pending queue is embedded on
  // the fly. It is capped and short-lived, so this stays a handful of calls.
  const pending = await db
    .select()
    .from(skillProposals)
    .where(and(eq(skillProposals.userId, userId), eq(skillProposals.status, 'pending')))
    .orderBy(desc(skillProposals.createdAt))
    .limit(MAX_PENDING_COMPARED);

  for (const candidate of pending) {
    let candidateEmbedding: number[];
    try {
      candidateEmbedding = await getEmbeddingService().generateEmbedding(similarityText(candidate), 'document');
    } catch {
      break;
    }
    const similarity = cosine(embedding, candidateEmbedding);
    if (similarity >= NEAR_DUPLICATE_SIMILARITY) {
      return { kind: 'pending', id: candidate.id, name: candidate.name, similarity };
    }
  }

  return null;
}
