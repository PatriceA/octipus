import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { getDb } from '@/db/postgres';
import { recurringTasks } from '@/db/schema/recurring-tasks';
import { eq, and, desc } from 'drizzle-orm';
import { getNextCronDate } from '@/core/cron-runner';

export const recurringTaskRoutes = new Elysia({ prefix: '/recurring-tasks' })
  .use(apiContext)

  .get('/', async ({ user }) => {
    if (!user) return { error: 'Not authenticated' };
    const db = getDb();
    const tasks = await db
      .select()
      .from(recurringTasks)
      .where(eq(recurringTasks.userId, user.id))
      .orderBy(desc(recurringTasks.createdAt));
    return { tasks };
  }, { detail: { tags: ['recurring-tasks'] } })

  .get('/:id', async ({ user, params }) => {
    if (!user) return { error: 'Not authenticated' };
    const db = getDb();
    const [task] = await db
      .select()
      .from(recurringTasks)
      .where(and(eq(recurringTasks.id, params.id), eq(recurringTasks.userId, user.id)))
      .limit(1);
    if (!task) return { error: 'Task not found' };
    return { task };
  }, { params: t.Object({ id: t.String() }), detail: { tags: ['recurring-tasks'] } })

  .post('/', async ({ user, body }) => {
    if (!user) return { error: 'Not authenticated' };
    const db = getDb();

    const nextRunAt = getNextCronDate(body.cronExpression, body.timezone);

    const [task] = await db
      .insert(recurringTasks)
      .values({
        userId: user.id,
        name: body.name,
        description: body.description,
        cronExpression: body.cronExpression,
        timezone: body.timezone || 'UTC',
        actionType: body.actionType,
        actionConfig: body.actionConfig,
        nextRunAt,
      })
      .returning();

    return { task };
  }, {
    body: t.Object({
      name: t.String({ minLength: 1 }),
      description: t.Optional(t.String()),
      cronExpression: t.String({ minLength: 1 }),
      timezone: t.Optional(t.String()),
      actionType: t.String({ minLength: 1 }),
      actionConfig: t.Any(),
    }),
    detail: { tags: ['recurring-tasks'] },
  })

  .patch('/:id', async ({ user, params, body }) => {
    if (!user) return { error: 'Not authenticated' };
    const db = getDb();

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (body.name !== undefined) updateData.name = body.name;
    if (body.description !== undefined) updateData.description = body.description;
    if (body.isEnabled !== undefined) {
      updateData.isEnabled = body.isEnabled;
      if (body.isEnabled) updateData.status = 'active';
    }
    if (body.cronExpression !== undefined) {
      updateData.cronExpression = body.cronExpression;
      updateData.nextRunAt = getNextCronDate(body.cronExpression, body.timezone);
    }

    const [task] = await db
      .update(recurringTasks)
      .set(updateData)
      .where(and(eq(recurringTasks.id, params.id), eq(recurringTasks.userId, user.id)))
      .returning();

    if (!task) return { error: 'Task not found' };
    return { task };
  }, {
    params: t.Object({ id: t.String() }),
    body: t.Object({
      name: t.Optional(t.String()),
      description: t.Optional(t.String()),
      cronExpression: t.Optional(t.String()),
      timezone: t.Optional(t.String()),
      isEnabled: t.Optional(t.Boolean()),
    }),
    detail: { tags: ['recurring-tasks'] },
  })

  .delete('/:id', async ({ user, params }) => {
    if (!user) return { error: 'Not authenticated' };
    const db = getDb();

    const result = await db
      .delete(recurringTasks)
      .where(and(eq(recurringTasks.id, params.id), eq(recurringTasks.userId, user.id)))
      .returning({ id: recurringTasks.id });

    if (result.length === 0) return { error: 'Task not found' };
    return { deleted: true };
  }, { params: t.Object({ id: t.String() }), detail: { tags: ['recurring-tasks'] } });
