import { eq, or, inArray, and } from 'drizzle-orm';
import { getDb } from '../postgres';
import { skills, type Skill } from '../schema/skills';
import { skillTopicAssignments } from '../schema/skill-topic-assignments';

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
      return this.db.select().from(skills).where(
        or(eq(skills.isSystem, true), eq(skills.userId, userId)),
      );
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
