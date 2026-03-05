import { Elysia, t } from 'elysia';
import { eq, or } from 'drizzle-orm';
import { apiContext } from '@/api/context';
import { getDb } from '@/db/postgres';
import { skills } from '@/db/schema/skills';

export const skillRoutes = new Elysia({ prefix: '/skills' })
  .use(apiContext)

  .get(
    '/',
    async ({ user }) => {
      const db = getDb();

      if (user) {
        if (user.id === 'system') {
          return { skills: await db.select().from(skills) };
        }
        return {
          skills: await db.select().from(skills).where(
            or(eq(skills.isSystem, true), eq(skills.userId, user.id))
          ),
        };
      }

      return {
        skills: await db.select().from(skills).where(eq(skills.isSystem, true)),
      };
    },
    { detail: { tags: ['skills'] } }
  )

  .get(
    '/:id',
    async ({ user, params }) => {
      const db = getDb();
      const [skill] = await db.select().from(skills).where(eq(skills.id, params.id)).limit(1);

      if (!skill) return { error: 'Skill not found' };

      if (!skill.isSystem && user && !user.isAdmin && skill.userId !== user.id) {
        return { error: 'Not authorized' };
      }

      return skill;
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { tags: ['skills'] },
    }
  )

  .post(
    '/',
    async ({ user, body }) => {
      if (!user) return { error: 'Not authenticated' };

      const db = getDb();
      const [created] = await db.insert(skills).values({
        id: body.id ?? crypto.randomUUID(),
        name: body.name,
        category: body.category ?? 'engineering',
        description: body.description,
        principles: body.principles ?? [],
        bestPractices: body.bestPractices ?? [],
        antiPatterns: body.antiPatterns ?? [],
        frameworks: body.frameworks ?? [],
        isSystem: false,
        userId: user.id === 'system' ? null : user.id,
      }).returning();

      return created;
    },
    {
      body: t.Object({
        id: t.Optional(t.String()),
        name: t.String(),
        category: t.Optional(t.String()),
        description: t.String(),
        principles: t.Optional(t.Array(t.String())),
        bestPractices: t.Optional(t.Array(t.String())),
        antiPatterns: t.Optional(t.Array(t.String())),
        frameworks: t.Optional(t.Array(t.String())),
      }),
      detail: { tags: ['skills'] },
    }
  )

  .patch(
    '/:id',
    async ({ user, params, body }) => {
      if (!user) return { error: 'Not authenticated' };

      const db = getDb();
      const [existing] = await db.select().from(skills).where(eq(skills.id, params.id)).limit(1);

      if (!existing) return { error: 'Skill not found' };
      if (!user.isAdmin && existing.userId !== user.id) return { error: 'Not authorized' };

      const updateData: Record<string, unknown> = { updatedAt: new Date() };
      if (body.name !== undefined) updateData.name = body.name;
      if (body.category !== undefined) updateData.category = body.category;
      if (body.description !== undefined) updateData.description = body.description;
      if (body.principles !== undefined) updateData.principles = body.principles;
      if (body.bestPractices !== undefined) updateData.bestPractices = body.bestPractices;
      if (body.antiPatterns !== undefined) updateData.antiPatterns = body.antiPatterns;
      if (body.frameworks !== undefined) updateData.frameworks = body.frameworks;

      const [updated] = await db
        .update(skills)
        .set(updateData)
        .where(eq(skills.id, params.id))
        .returning();

      return updated;
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        name: t.Optional(t.String()),
        category: t.Optional(t.String()),
        description: t.Optional(t.String()),
        principles: t.Optional(t.Array(t.String())),
        bestPractices: t.Optional(t.Array(t.String())),
        antiPatterns: t.Optional(t.Array(t.String())),
        frameworks: t.Optional(t.Array(t.String())),
      }),
      detail: { tags: ['skills'] },
    }
  )

  .delete(
    '/:id',
    async ({ user, params }) => {
      if (!user) return { error: 'Not authenticated' };

      const db = getDb();
      const [existing] = await db.select().from(skills).where(eq(skills.id, params.id)).limit(1);

      if (!existing) return { error: 'Skill not found' };
      if (existing.isSystem) return { error: 'Cannot delete system skills' };
      if (!user.isAdmin && existing.userId !== user.id) return { error: 'Not authorized' };

      const result = await db.delete(skills).where(eq(skills.id, params.id)).returning();
      return { deleted: result.length > 0 };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { tags: ['skills'] },
    }
  );
