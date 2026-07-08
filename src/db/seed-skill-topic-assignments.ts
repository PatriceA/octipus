import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { skillTopicAssignments } from '@/db/schema/skill-topic-assignments';
import { logger } from '@/utils/logger';

/**
 * Default skill-topic assignments.
 * Each entry wires a skill to one or more topics.
 * The `isActive` flag controls whether the skill is injected into worker prompts.
 */
const DEFAULT_ASSIGNMENTS: Array<{ skillId: string; topic: string; isActive: boolean }> = [
  // ── Coding topic ──
  { skillId: 'software-architecture', topic: 'coding', isActive: true },
  { skillId: 'data-structures', topic: 'coding', isActive: true },
  { skillId: 'api-design', topic: 'coding', isActive: true },
  { skillId: 'performance-engineering', topic: 'coding', isActive: true },
  { skillId: 'plugin-development', topic: 'coding', isActive: true },

  // ── Architecture topic ──
  { skillId: 'software-architecture', topic: 'architecture', isActive: true },
  { skillId: 'api-design', topic: 'architecture', isActive: true },
  { skillId: 'database-design', topic: 'architecture', isActive: true },

  // ── Review topic ──
  { skillId: 'software-architecture', topic: 'review', isActive: true },
  { skillId: 'test-automation', topic: 'review', isActive: true },
  { skillId: 'security-practices', topic: 'review', isActive: true },
  { skillId: 'performance-engineering', topic: 'review', isActive: true },

  // ── QA topic ──
  { skillId: 'test-automation', topic: 'qa', isActive: true },
  { skillId: 'performance-engineering', topic: 'qa', isActive: true },

  // ── Design topic ──
  { skillId: 'design-principles', topic: 'design', isActive: true },
  { skillId: 'design-frameworks', topic: 'design', isActive: true },

  // ── DevOps topic ──
  { skillId: 'devops-practices', topic: 'devops', isActive: true },
  { skillId: 'container-orchestration', topic: 'devops', isActive: true },
  { skillId: 'cloud-platforms', topic: 'devops', isActive: true },
  { skillId: 'networking', topic: 'devops', isActive: true },

  // ── Security topic ──
  { skillId: 'security-practices', topic: 'security', isActive: true },
  { skillId: 'networking', topic: 'security', isActive: true },
  { skillId: 'cloud-platforms', topic: 'security', isActive: true },

  // ── Data topic ──
  { skillId: 'database-design', topic: 'data', isActive: true },
  { skillId: 'data-engineering', topic: 'data', isActive: true },
  { skillId: 'performance-engineering', topic: 'data', isActive: true },

  // ── AI topic ──
  { skillId: 'ai-engineering', topic: 'ai', isActive: true },
  { skillId: 'machine-learning', topic: 'ai', isActive: true },
  { skillId: 'data-structures', topic: 'ai', isActive: true },

  // ── Finance topic ──
  { skillId: 'financial-analysis', topic: 'finance', isActive: true },

  // ── Automation topic ──
  { skillId: 'automation-patterns', topic: 'automation', isActive: true },
  { skillId: 'devops-practices', topic: 'automation', isActive: true },

  // ── PM topic ──
  { skillId: 'project-management', topic: 'pm', isActive: true },
  { skillId: 'technical-writing', topic: 'pm', isActive: true },

  // ── Writing topic ──
  { skillId: 'technical-writing', topic: 'writing', isActive: true },
  { skillId: 'api-design', topic: 'writing', isActive: true },

  // ── Research topic ──
  // Intentionally no skill assignment: 'technical-writing' here made a small
  // research model drift into writing documentation instead of researching.
  // See docs/postmortems/2026-07-07-run-743d4b66-world-cup-research.md (RC3).

  // ── Caveman — attached to all worker topics, inactive by default ──
  { skillId: 'caveman', topic: 'coding', isActive: false },
  { skillId: 'caveman', topic: 'architecture', isActive: false },
  { skillId: 'caveman', topic: 'review', isActive: false },
  { skillId: 'caveman', topic: 'qa', isActive: false },
  { skillId: 'caveman', topic: 'design', isActive: false },
  { skillId: 'caveman', topic: 'devops', isActive: false },
  { skillId: 'caveman', topic: 'security', isActive: false },
  { skillId: 'caveman', topic: 'data', isActive: false },
  { skillId: 'caveman', topic: 'ai', isActive: false },
  { skillId: 'caveman', topic: 'finance', isActive: false },
  { skillId: 'caveman', topic: 'automation', isActive: false },
  { skillId: 'caveman', topic: 'pm', isActive: false },
  { skillId: 'caveman', topic: 'writing', isActive: false },
  { skillId: 'caveman', topic: 'research', isActive: false },
  { skillId: 'caveman', topic: 'general', isActive: false },
  { skillId: 'caveman', topic: 'communication', isActive: false },
];

/**
 * Seed skill-topic assignments into the database.
 * Idempotent — skips assignments that already exist by (skillId, topic).
 */
/**
 * Assignments removed from DEFAULT_ASSIGNMENTS that must also be DELETED from
 * existing databases (the insert loop below never deletes). Without this the
 * retired row survives and keeps feeding the child via topic discovery.
 */
const RETIRED_ASSIGNMENTS: Array<{ skillId: string; topic: string }> = [
  // See docs/postmortems/2026-07-07-run-743d4b66-world-cup-research.md (RC3):
  // made a small research model drift into writing documentation.
  { skillId: 'technical-writing', topic: 'research' },
];

export async function seedSkillTopicAssignments(): Promise<void> {
  const db = getDb();

  for (const retired of RETIRED_ASSIGNMENTS) {
    const deleted = await db
      .delete(skillTopicAssignments)
      .where(
        and(
          eq(skillTopicAssignments.skillId, retired.skillId),
          eq(skillTopicAssignments.topic, retired.topic),
        ),
      )
      .returning({ id: skillTopicAssignments.id });
    if (deleted.length > 0) {
      logger.info({ skillId: retired.skillId, topic: retired.topic }, 'Removed retired skill-topic assignment');
    }
  }

  for (const assignment of DEFAULT_ASSIGNMENTS) {
    const existing = await db
      .select({ id: skillTopicAssignments.id })
      .from(skillTopicAssignments)
      .where(
        and(
          eq(skillTopicAssignments.skillId, assignment.skillId),
          eq(skillTopicAssignments.topic, assignment.topic),
        ),
      )
      .limit(1);

    if (existing.length > 0) continue;

    await db.insert(skillTopicAssignments).values(assignment);
    logger.info({ skillId: assignment.skillId, topic: assignment.topic }, 'Seeded skill-topic assignment');
  }
}
