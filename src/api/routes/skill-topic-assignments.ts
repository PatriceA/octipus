import { and, eq } from 'drizzle-orm';
import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { getDb } from '@/db/postgres';
import { skillTopicAssignments } from '@/db/schema/skill-topic-assignments';
import { skills } from '@/db/schema/skills';

export const skillTopicAssignmentRoutes = new Elysia({ prefix: '/skills/topics' })
  .use(apiContext)

  // List all assignments, optionally filtered by topic or skill
  .get(
    '/',
    async ({ query }) => {
      const db = getDb();
      let q = db
        .select({
          id: skillTopicAssignments.id,
          skillId: skillTopicAssignments.skillId,
          skillName: skills.name,
          topic: skillTopicAssignments.topic,
          isActive: skillTopicAssignments.isActive,
          createdAt: skillTopicAssignments.createdAt,
          updatedAt: skillTopicAssignments.updatedAt,
        })
        .from(skillTopicAssignments)
        .innerJoin(skills, eq(skillTopicAssignments.skillId, skills.id));

      if (query.topic) {
        q = q.where(eq(skillTopicAssignments.topic, query.topic)) as typeof q;
      }
      if (query.skillId) {
        q = q.where(eq(skillTopicAssignments.skillId, query.skillId)) as typeof q;
      }

      return { assignments: await q };
    },
    {
      query: t.Object({
        topic: t.Optional(t.String()),
        skillId: t.Optional(t.String()),
      }),
      detail: { tags: ['skills'] },
    },
  )

  // Assign a skill to a topic
  .post(
    '/',
    async ({ user, body }) => {
      if (!user) return { error: 'Not authenticated' };

      const db = getDb();

      // Check skill exists
      const [skill] = await db.select({ id: skills.id }).from(skills).where(eq(skills.id, body.skillId)).limit(1);
      if (!skill) return { error: 'Skill not found' };

      // Check for existing assignment
      const [existing] = await db
        .select({ id: skillTopicAssignments.id })
        .from(skillTopicAssignments)
        .where(
          and(
            eq(skillTopicAssignments.skillId, body.skillId),
            eq(skillTopicAssignments.topic, body.topic),
          ),
        )
        .limit(1);

      if (existing) {
        return { error: 'Assignment already exists', existingId: existing.id };
      }

      const [created] = await db.insert(skillTopicAssignments).values({
        skillId: body.skillId,
        topic: body.topic,
        isActive: body.isActive ?? true,
      }).returning();

      return created;
    },
    {
      body: t.Object({
        skillId: t.String(),
        topic: t.String(),
        isActive: t.Optional(t.Boolean()),
      }),
      detail: { tags: ['skills'] },
    },
  )

  // Toggle active state or update an assignment
  .patch(
    '/:id',
    async ({ user, params, body }) => {
      if (!user) return { error: 'Not authenticated' };

      const db = getDb();
      const updateData: Record<string, unknown> = { updatedAt: new Date() };
      if (body.isActive !== undefined) updateData.isActive = body.isActive;

      const [updated] = await db
        .update(skillTopicAssignments)
        .set(updateData)
        .where(eq(skillTopicAssignments.id, params.id))
        .returning();

      if (!updated) return { error: 'Assignment not found' };
      return updated;
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        isActive: t.Optional(t.Boolean()),
      }),
      detail: { tags: ['skills'] },
    },
  )

  // Bulk toggle: activate or deactivate a skill across all its topic assignments
  .patch(
    '/bulk/:skillId',
    async ({ user, params, body }) => {
      if (!user) return { error: 'Not authenticated' };

      const db = getDb();
      const updated = await db
        .update(skillTopicAssignments)
        .set({ isActive: body.isActive, updatedAt: new Date() })
        .where(eq(skillTopicAssignments.skillId, params.skillId))
        .returning();

      return { updated: updated.length, assignments: updated };
    },
    {
      params: t.Object({ skillId: t.String() }),
      body: t.Object({
        isActive: t.Boolean(),
      }),
      detail: { tags: ['skills'] },
    },
  )

  // Delete an assignment
  .delete(
    '/:id',
    async ({ user, params }) => {
      if (!user) return { error: 'Not authenticated' };

      const db = getDb();
      const result = await db
        .delete(skillTopicAssignments)
        .where(eq(skillTopicAssignments.id, params.id))
        .returning();

      return { deleted: result.length > 0 };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { tags: ['skills'] },
    },
  );
