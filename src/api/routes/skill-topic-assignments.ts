import { and, eq, inArray } from 'drizzle-orm';
import { Elysia, t } from '@/api/http';
import { apiContext } from '@/api/context';
import { adminDenied } from '@/api/admin-guard';
import { getDb } from '@/db/postgres';
import { skillTopicAssignments } from '@/db/schema/skill-topic-assignments';
import { skills } from '@/db/schema/skills';
import { getSkillRegistry } from '@/skills/registry';
import { isAdmin, isAuthenticated } from '@/security/principal';

// Assignments are install-global: they decide which skills every user's
// workers get per topic. Anyone signed in reads those for skills they can
// see; only an admin changes them.
export const skillTopicAssignmentRoutes = new Elysia({ prefix: '/skills/topics' })
  .use(apiContext)

  // List all assignments, optionally filtered by topic or skill
  .get(
    '/',
    async ({ user, principal, query, set }) => {
      if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
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
        .leftJoin(skills, eq(skillTopicAssignments.skillId, skills.id));

      const registry = getSkillRegistry();
      q = q.where(and(
        query.topic ? eq(skillTopicAssignments.topic, query.topic) : undefined,
        query.skillId ? inArray(skillTopicAssignments.skillId, registry.sourceIds(query.skillId)) : undefined,
      )) as typeof q;
      let rows = await q;
      if (!isAdmin(principal)) {
        // Another user's private skill stays invisible, name included.
        const visible = new Set((await registry.getAll(user.id)).flatMap(skill => registry.sourceIds(skill.id)));
        rows = rows.filter(row => visible.has(row.skillId));
      }
      return { assignments: rows.map(row => ({ ...row,
        skillId: registry.canonicalId(row.skillId),
        skillName: row.skillName ?? registry.getExternalSkills().find(skill => skill.id === registry.canonicalId(row.skillId))?.name ?? row.skillId,
      })) };
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
    async ({ user, principal, body, set }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied || !user) return denied;

      const db = getDb();

      // Check skill exists
      const skill = await getSkillRegistry().get(body.skillId, user.id);
      if (!skill) return { error: 'Skill not found' };
      body.skillId = skill.id;

      // Check for existing assignment
      const [existing] = await db
        .select({ id: skillTopicAssignments.id })
        .from(skillTopicAssignments)
        .where(
          and(
            inArray(skillTopicAssignments.skillId, getSkillRegistry().sourceIds(body.skillId)),
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
    async ({ user, principal, params, body, set }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;

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
    async ({ user, principal, params, body, set }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;

      const db = getDb();
      const updated = await db
        .update(skillTopicAssignments)
        .set({ isActive: body.isActive, updatedAt: new Date() })
        .where(inArray(skillTopicAssignments.skillId, getSkillRegistry().sourceIds(params.skillId)))
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
    async ({ user, principal, params, set }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;

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
