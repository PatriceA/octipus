import { and, eq, inArray, or } from 'drizzle-orm';
import { getUserOrgIds } from '@/services/org-membership';
import { getDb } from '../postgres';
import { skillTopicAssignments } from '../schema/skill-topic-assignments';
import { type Skill, skills } from '../schema/skills';

/**
 * Fields that affect the embedding hash (sha256(name + description)). When
 * any of these change, we must NULL out `description_embedding` and
 * `description_hash` so the backfill cron picks the row up. We do NOT
 * compute a new hash here and we do NOT call the embedding service —
 * cron-only refill, per docs/plans/skill-discovery.md Phase 2.
 */
const EMBEDDING_RELEVANT_FIELDS = ['name', 'description'] as const;
type EmbeddingRelevantField = typeof EMBEDDING_RELEVANT_FIELDS[number];

export type SkillUpdate = Partial<Pick<Skill,
  | 'name'
  | 'category'
  | 'description'
  | 'content'
  | 'principles'
  | 'bestPractices'
  | 'antiPatterns'
  | 'frameworks'
  | 'triggers'
  | 'alwaysInject'
>>;

/**
 * Repository for skills + skill-topic assignments. The high-level
 * `SkillRegistry` (in `src/skills/registry.ts`) builds prompt fragments;
 * raw DB access lives here so the rest of the codebase follows one rule:
 * data goes through repositories, never `getDb()` directly.
 */
export class SkillRepository {
  private get db() { return getDb(); }

  async findAll(userId?: string): Promise<Skill[]> {
    if (userId) {
      const orgIds = await getUserOrgIds(userId);
      const clauses = [eq(skills.isSystem, true), eq(skills.userId, userId)];
      if (orgIds.length > 0) clauses.push(inArray(skills.orgId, orgIds));
      return this.db.select().from(skills).where(or(...clauses));
    }
    return this.db.select().from(skills);
  }

  async findById(skillId: string): Promise<Skill | undefined> {
    const [row] = await this.db.select().from(skills).where(eq(skills.id, skillId)).limit(1);
    return row;
  }

  async findByIds(skillIds: string[]): Promise<Skill[]> {
    if (skillIds.length === 0) return [];
    return this.db.select().from(skills).where(inArray(skills.id, skillIds));
  }

  /**
   * Update a skill row. If any embedding-relevant field (name/description)
   * is in the input AND differs from the current row, NULL out
   * `descriptionEmbedding` and `descriptionHash` in the same UPDATE so the
   * backfill cron picks the row up. The embedding service is NOT called
   * here — refill is cron-only.
   *
   * Returns the updated row, or undefined if no row matched.
   *
   * Errors propagate to the caller (loud-failure principle); no swallowing.
   */
  async update(skillId: string, data: SkillUpdate): Promise<Skill | undefined> {
    const db = this.db;
    const [existing] = await db.select().from(skills).where(eq(skills.id, skillId)).limit(1);
    if (!existing) return undefined;

    let invalidateEmbedding = false;
    for (const field of EMBEDDING_RELEVANT_FIELDS) {
      const next = data[field as EmbeddingRelevantField];
      if (next !== undefined && next !== existing[field]) {
        invalidateEmbedding = true;
        break;
      }
    }

    const updateSet: Record<string, unknown> = { ...data, updatedAt: new Date() };
    if (invalidateEmbedding) {
      updateSet.descriptionEmbedding = null;
      updateSet.descriptionHash = null;
    }

    const [updated] = await db
      .update(skills)
      .set(updateSet)
      .where(eq(skills.id, skillId))
      .returning();
    return updated;
  }

  async findActiveByTopic(topic: string): Promise<Skill[]> {
    const rows = await this.db
      .select({ skill: skills })
      .from(skillTopicAssignments)
      .innerJoin(skills, eq(skillTopicAssignments.skillId, skills.id))
      .where(
        and(
          eq(skillTopicAssignments.topic, topic),
          eq(skillTopicAssignments.isActive, true),
        ),
      );
    return rows.map(r => r.skill);
  }
}

export const skillRepository = new SkillRepository();
