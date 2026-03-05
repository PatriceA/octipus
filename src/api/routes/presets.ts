import { Elysia, t } from 'elysia';
import { eq, or, isNull, and } from 'drizzle-orm';
import { apiContext } from '@/api/context';
import { getDb } from '@/db/postgres';
import { presets } from '@/db/schema/presets';
import { apiLogger } from '@/utils/logger';

export const presetRoutes = new Elysia({ prefix: '/presets' })
  .use(apiContext)

  // List presets (system presets + current user's presets)
  .get(
    '/',
    async ({ user }) => {
      const db = getDb();

      // If authenticated, return system presets + user's own presets
      if (user) {
        // System user (MASTER_KEY) -- show all presets
        if (user.id === 'system') {
          const all = await db.select().from(presets);
          return { presets: all };
        }

        const results = await db
          .select()
          .from(presets)
          .where(
            or(
              eq(presets.isSystem, true),
              eq(presets.userId, user.id),
            )
          );

        return { presets: results };
      }

      // Not authenticated -- only system presets
      const systemPresets = await db
        .select()
        .from(presets)
        .where(eq(presets.isSystem, true));

      return { presets: systemPresets };
    },
    { detail: { tags: ['presets'] } }
  )

  // Get single preset by ID
  .get(
    '/:id',
    async ({ user, params }) => {
      const db = getDb();

      const [preset] = await db
        .select()
        .from(presets)
        .where(eq(presets.id, params.id))
        .limit(1);

      if (!preset) {
        return { error: 'Preset not found' };
      }

      // System presets are public; user presets require ownership or admin
      if (!preset.isSystem) {
        if (!user) {
          return { error: 'Not authenticated' };
        }
        if (!user.isAdmin && preset.userId !== user.id) {
          return { error: 'Not authorized' };
        }
      }

      return preset;
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { tags: ['presets'] },
    }
  )

  // Create custom preset
  .post(
    '/',
    async ({ user, body }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const db = getDb();

      const [created] = await db.insert(presets).values({
        userId: user.id === 'system' ? null : user.id,
        name: body.name,
        description: body.description,
        icon: body.icon,
        role: body.role,
        systemPrompt: body.systemPrompt,
        modelPreference: body.modelPreference,
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
        systemPrompt: t.Optional(t.String()),
        modelPreference: t.Optional(t.String()),
        skillIds: t.Optional(t.Array(t.String())),
        parameters: t.Optional(t.Object({
          temperature: t.Optional(t.Number()),
          maxTokens: t.Optional(t.Number()),
          maxIterations: t.Optional(t.Number()),
          timeout: t.Optional(t.Number()),
        })),
      }),
      detail: { tags: ['presets'] },
    }
  )

  // Update preset (only if user owns it or is admin)
  .patch(
    '/:id',
    async ({ user, params, body }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const db = getDb();

      const [existing] = await db
        .select()
        .from(presets)
        .where(eq(presets.id, params.id))
        .limit(1);

      if (!existing) {
        return { error: 'Preset not found' };
      }

      if (!user.isAdmin && existing.userId !== user.id) {
        return { error: 'Not authorized' };
      }

      const updateData: Record<string, unknown> = { updatedAt: new Date() };
      if (body.name !== undefined) updateData.name = body.name;
      if (body.description !== undefined) updateData.description = body.description;
      if (body.icon !== undefined) updateData.icon = body.icon;
      if (body.role !== undefined) updateData.role = body.role;
      if (body.systemPrompt !== undefined) updateData.systemPrompt = body.systemPrompt;
      if (body.modelPreference !== undefined) updateData.modelPreference = body.modelPreference;
      if (body.skillIds !== undefined) updateData.skillIds = body.skillIds;
      if (body.parameters !== undefined) updateData.parameters = body.parameters;

      const [updated] = await db
        .update(presets)
        .set(updateData)
        .where(eq(presets.id, params.id))
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
        systemPrompt: t.Optional(t.String()),
        modelPreference: t.Optional(t.String()),
        skillIds: t.Optional(t.Array(t.String())),
        parameters: t.Optional(t.Object({
          temperature: t.Optional(t.Number()),
          maxTokens: t.Optional(t.Number()),
          maxIterations: t.Optional(t.Number()),
          timeout: t.Optional(t.Number()),
        })),
      }),
      detail: { tags: ['presets'] },
    }
  )

  // Delete preset (only user-created, not system)
  .delete(
    '/:id',
    async ({ user, params }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const db = getDb();

      const [existing] = await db
        .select()
        .from(presets)
        .where(eq(presets.id, params.id))
        .limit(1);

      if (!existing) {
        return { error: 'Preset not found' };
      }

      if (existing.isSystem) {
        return { error: 'Cannot delete system presets' };
      }

      if (!user.isAdmin && existing.userId !== user.id) {
        return { error: 'Not authorized' };
      }

      const result = await db
        .delete(presets)
        .where(eq(presets.id, params.id))
        .returning();

      return { deleted: result.length > 0 };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { tags: ['presets'] },
    }
  );
