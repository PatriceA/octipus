import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import type { NewTask } from '@/db/schema/tasks';
import { scopedRepos } from '@/db/repositories/scoped';
import { isAuthenticated } from '@/security/principal';

const STATUSES = ['open', 'done', 'archived'] as const;

/** Derive completedAt transitions from a status change. */
function completionPatch(nextStatus: string | undefined, wasCompleted: boolean): Partial<NewTask> {
  if (nextStatus === 'done' && !wasCompleted) return { completedAt: new Date() };
  if (nextStatus && nextStatus !== 'done' && wasCompleted) return { completedAt: null };
  return {};
}

/**
 * Personal tasks/todos (feature #6). All access is through the scoped repo, so
 * cross-tenant ids return "not found" (IDOR-safe). Bodies are TypeBox-validated
 * at the boundary — malformed input is rejected, not coerced.
 */
export const taskRoutes = new Elysia({ prefix: '/tasks' })
  .use(apiContext)

  // List the caller's tasks. ?status= filters; ?due=today returns tasks due by end of today.
  .get(
    '/',
    async ({ user, principal, query }) => {
      if (!user || !isAuthenticated(principal)) return { error: 'Not authenticated' };
      let dueBefore: Date | undefined;
      if (query?.due === 'today') {
        dueBefore = new Date();
        dueBefore.setHours(23, 59, 59, 999);
      }
      const tasks = await scopedRepos(principal).tasks.listOwn({ status: query?.status, dueBefore });
      return { tasks };
    },
    {
      query: t.Object({
        status: t.Optional(t.String()),
        due: t.Optional(t.String()),
      }),
      detail: { tags: ['tasks'] },
    }
  )

  // Get one task.
  .get(
    '/:id',
    async ({ user, principal, params }) => {
      if (!user || !isAuthenticated(principal)) return { error: 'Not authenticated' };
      const task = await scopedRepos(principal).tasks.findById(params.id);
      if (!task) return { error: 'Task not found' };
      return task;
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { tags: ['tasks'] },
    }
  )

  // Create a task.
  .post(
    '/',
    async ({ user, principal, body }) => {
      if (!user || !isAuthenticated(principal)) return { error: 'Not authenticated' };
      const task = await scopedRepos(principal).tasks.create({
        title: body.title,
        notes: body.notes ?? null,
        priority: body.priority ?? 0,
        dueAt: body.dueAt ? new Date(body.dueAt) : null,
        source: 'user',
      });
      return task;
    },
    {
      body: t.Object({
        title: t.String({ minLength: 1 }),
        notes: t.Optional(t.String()),
        priority: t.Optional(t.Integer({ minimum: 0, maximum: 3 })),
        dueAt: t.Optional(t.String()),
      }),
      detail: { tags: ['tasks'] },
    }
  )

  // Update a task (title/notes/status/priority/due). Manages completedAt.
  .patch(
    '/:id',
    async ({ user, principal, params, body, set }) => {
      if (!user || !isAuthenticated(principal)) return { error: 'Not authenticated' };
      const repo = scopedRepos(principal).tasks;
      const existing = await repo.findById(params.id);
      if (!existing) {
        set.status = 404;
        return { error: 'Task not found' };
      }
      if (body.status && !STATUSES.includes(body.status as (typeof STATUSES)[number])) {
        set.status = 400;
        return { error: `Invalid status "${body.status}"` };
      }
      const updated = await repo.update(params.id, {
        title: body.title,
        notes: body.notes,
        status: body.status,
        priority: body.priority,
        dueAt: body.dueAt !== undefined ? (body.dueAt ? new Date(body.dueAt) : null) : undefined,
        ...completionPatch(body.status, Boolean(existing.completedAt)),
      });
      return updated;
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        title: t.Optional(t.String({ minLength: 1 })),
        notes: t.Optional(t.Union([t.String(), t.Null()])),
        status: t.Optional(t.String()),
        priority: t.Optional(t.Integer({ minimum: 0, maximum: 3 })),
        dueAt: t.Optional(t.Union([t.String(), t.Null()])),
      }),
      detail: { tags: ['tasks'] },
    }
  )

  // Delete a task.
  .delete(
    '/:id',
    async ({ user, principal, params }) => {
      if (!user || !isAuthenticated(principal)) return { error: 'Not authenticated' };
      const deleted = await scopedRepos(principal).tasks.delete(params.id);
      if (!deleted) return { error: 'Task not found' };
      return { deleted };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { tags: ['tasks'] },
    }
  );
