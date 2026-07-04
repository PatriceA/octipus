import { eq, or, } from 'drizzle-orm';
import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { getDb } from '@/db/postgres';
import { experts } from '@/db/schema/experts';
import { TOPICS } from '@/models/topics';

/** Lanes an expert can be assigned to: the text-class topics (agents/chat/voice). */
function assignableLanes(): string[] {
  return TOPICS.filter((t) => t.kind === 'text').map((t) => t.value);
}

function isAssignableLane(topic: string): boolean {
  return assignableLanes().includes(topic);
}

export const expertRoutes = new Elysia({ prefix: '/experts' })
  .use(apiContext)

  // List experts (system experts + current user's experts)
  .get(
    '/',
    async ({ user }) => {
      const db = getDb();

      if (user) {
        if (user.id === 'system') {
          const all = await db.select().from(experts);
          return { experts: all };
        }

        const results = await db
          .select()
          .from(experts)
          .where(
            or(
              eq(experts.isSystem, true),
              eq(experts.userId, user.id),
            )
          );

        return { experts: results };
      }

      const systemExperts = await db
        .select()
        .from(experts)
        .where(eq(experts.isSystem, true));

      return { experts: systemExperts };
    },
    { detail: { tags: ['experts'] } }
  )

  // Get single expert by ID
  .get(
    '/:id',
    async ({ user, params }) => {
      const db = getDb();

      const [expert] = await db
        .select()
        .from(experts)
        .where(eq(experts.id, params.id))
        .limit(1);

      if (!expert) {
        return { error: 'Expert not found' };
      }

      if (!expert.isSystem) {
        if (!user) {
          return { error: 'Not authenticated' };
        }
        if (!user.isAdmin && expert.userId !== user.id) {
          return { error: 'Not authorized' };
        }
      }

      return expert;
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { tags: ['experts'] },
    }
  )

  // Create custom expert
  .post(
    '/',
    async ({ user, body }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      if (body.topic !== undefined && !isAssignableLane(body.topic)) {
        return { error: `Unknown topic lane: ${body.topic}. Valid lanes: ${assignableLanes().join(', ')}` };
      }

      const db = getDb();

      const [created] = await db.insert(experts).values({
        userId: user.id === 'system' ? null : user.id,
        name: body.name,
        description: body.description,
        icon: body.icon,
        role: body.role,
        topic: body.topic ?? 'agents',
        systemPrompt: body.systemPrompt,
        modelPreference: body.modelPreference,
        toolIds: body.toolIds ?? [],
        skillIds: body.skillIds ?? [],
        parameters: body.parameters ?? {},
        isSystem: false,
      }).returning();

      return created;
    },
    {
      body: t.Object({
        name: t.String(),
        description: t.Optional(t.String()),
        icon: t.Optional(t.String()),
        role: t.String(),
        topic: t.Optional(t.String()),
        systemPrompt: t.Optional(t.String()),
        // Nullable: `null` = no override, use the lane's model. TypeBox
        // `Optional` alone allows only `undefined`, so the UI's explicit
        // `modelPreference: null` used to 422 here.
        modelPreference: t.Optional(t.Union([t.String(), t.Null()])),
        toolIds: t.Optional(t.Array(t.String())),
        skillIds: t.Optional(t.Array(t.String())),
        parameters: t.Optional(t.Object({
          temperature: t.Optional(t.Number()),
          maxTokens: t.Optional(t.Number()),
          maxIterations: t.Optional(t.Number()),
          timeout: t.Optional(t.Number()),
        })),
      }),
      detail: { tags: ['experts'] },
    }
  )

  // Update expert
  .patch(
    '/:id',
    async ({ user, params, body }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const db = getDb();

      const [existing] = await db
        .select()
        .from(experts)
        .where(eq(experts.id, params.id))
        .limit(1);

      if (!existing) {
        return { error: 'Expert not found' };
      }

      if (!user.isAdmin && existing.userId !== user.id) {
        return { error: 'Not authorized' };
      }

      if (body.topic !== undefined && !isAssignableLane(body.topic)) {
        return { error: `Unknown topic lane: ${body.topic}. Valid lanes: ${assignableLanes().join(', ')}` };
      }

      const updateData: Record<string, unknown> = { updatedAt: new Date() };
      if (body.name !== undefined) updateData.name = body.name;
      if (body.description !== undefined) updateData.description = body.description;
      if (body.icon !== undefined) updateData.icon = body.icon;
      if (body.role !== undefined) updateData.role = body.role;
      if (body.topic !== undefined) updateData.topic = body.topic;
      if (body.systemPrompt !== undefined) updateData.systemPrompt = body.systemPrompt;
      if (body.modelPreference !== undefined) updateData.modelPreference = body.modelPreference;
      if (body.toolIds !== undefined) updateData.toolIds = body.toolIds;
      if (body.skillIds !== undefined) updateData.skillIds = body.skillIds;
      if (body.parameters !== undefined) updateData.parameters = body.parameters;

      const [updated] = await db
        .update(experts)
        .set(updateData)
        .where(eq(experts.id, params.id))
        .returning();

      return updated;
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        name: t.Optional(t.String()),
        description: t.Optional(t.String()),
        icon: t.Optional(t.String()),
        role: t.Optional(t.String()),
        topic: t.Optional(t.String()),
        systemPrompt: t.Optional(t.String()),
        // `null` clears the override (fall back to the lane's model); the
        // handler passes it through and the DB column is nullable.
        modelPreference: t.Optional(t.Union([t.String(), t.Null()])),
        toolIds: t.Optional(t.Array(t.String())),
        skillIds: t.Optional(t.Array(t.String())),
        parameters: t.Optional(t.Object({
          temperature: t.Optional(t.Number()),
          maxTokens: t.Optional(t.Number()),
          maxIterations: t.Optional(t.Number()),
          timeout: t.Optional(t.Number()),
        })),
      }),
      detail: { tags: ['experts'] },
    }
  )

  // Delete expert (only user-created, not system)
  .delete(
    '/:id',
    async ({ user, params }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const db = getDb();

      const [existing] = await db
        .select()
        .from(experts)
        .where(eq(experts.id, params.id))
        .limit(1);

      if (!existing) {
        return { error: 'Expert not found' };
      }

      if (existing.isSystem) {
        return { error: 'Cannot delete system experts' };
      }

      if (!user.isAdmin && existing.userId !== user.id) {
        return { error: 'Not authorized' };
      }

      const result = await db
        .delete(experts)
        .where(eq(experts.id, params.id))
        .returning();

      return { deleted: result.length > 0 };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { tags: ['experts'] },
    }
  );
