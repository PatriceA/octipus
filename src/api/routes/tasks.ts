import { Elysia, t } from '@/api/http';
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

/** Parse an ISO due-date, throwing a clear error on garbage rather than storing NaN. */
function parseDueAt(value: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid dueAt "${value}" — expected an ISO 8601 date`);
  return d;
}

/** Trim a category; empty string → null (uncategorized). */
function normalizeCategory(value: string | null | undefined): string | null {
  if (value == null) return null;
  const c = value.trim();
  return c === '' ? null : c;
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
    async ({ user, principal, query, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }
      let dueBefore: Date | undefined;
      if (query?.due === 'today') {
        dueBefore = new Date();
        dueBefore.setHours(23, 59, 59, 999);
      }
      const tasks = await scopedRepos(principal).tasks.listOwn({ status: query?.status, dueBefore, category: query?.category });
      return { tasks };
    },
    {
      query: t.Object({
        status: t.Optional(t.Union(STATUSES.map((s) => t.Literal(s)))),
        due: t.Optional(t.String()),
        category: t.Optional(t.String()),
      }),
      detail: { tags: ['tasks'] },
    }
  )

  // Get one task.
  .get(
    '/:id',
    async ({ user, principal, params, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }
      const task = await scopedRepos(principal).tasks.findById(params.id);
      if (!task) {
        set.status = 404;
        return { error: 'Task not found' };
      }
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
    async ({ user, principal, body, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }
      try {
        const task = await scopedRepos(principal).tasks.create({
          title: body.title,
          notes: body.notes ?? null,
          priority: body.priority ?? 0,
          category: normalizeCategory(body.category),
          dueAt: body.dueAt ? parseDueAt(body.dueAt) : null,
          source: 'user',
        });
        return task;
      } catch (err) {
        set.status = 400;
        return { error: (err as Error).message };
      }
    },
    {
      body: t.Object({
        title: t.String({ minLength: 1, maxLength: 500 }),
        notes: t.Optional(t.String({ maxLength: 10_000 })),
        priority: t.Optional(t.Integer({ minimum: 0, maximum: 3 })),
        category: t.Optional(t.String({ maxLength: 100 })),
        dueAt: t.Optional(t.String()),
      }),
      detail: { tags: ['tasks'] },
    }
  )

  // Update a task (title/notes/status/priority/due/category). Manages completedAt.
  .patch(
    '/:id',
    async ({ user, principal, params, body, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }
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
      try {
        const updated = await repo.update(params.id, {
          title: body.title,
          notes: body.notes,
          status: body.status,
          priority: body.priority,
          category: body.category !== undefined ? normalizeCategory(body.category) : undefined,
          dueAt: body.dueAt !== undefined ? (body.dueAt ? parseDueAt(body.dueAt) : null) : undefined,
          ...completionPatch(body.status, Boolean(existing.completedAt)),
        });
        if (!updated) {
          set.status = 404;
          return { error: 'Task not found' };
        }
        return updated;
      } catch (err) {
        set.status = 400;
        return { error: (err as Error).message };
      }
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        title: t.Optional(t.String({ minLength: 1, maxLength: 500 })),
        notes: t.Optional(t.Union([t.String({ maxLength: 10_000 }), t.Null()])),
        status: t.Optional(t.String()),
        priority: t.Optional(t.Integer({ minimum: 0, maximum: 3 })),
        category: t.Optional(t.Union([t.String({ maxLength: 100 }), t.Null()])),
        dueAt: t.Optional(t.Union([t.String(), t.Null()])),
      }),
      detail: { tags: ['tasks'] },
    }
  )

  // Delete a task.
  .delete(
    '/:id',
    async ({ user, principal, params, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }
      const deleted = await scopedRepos(principal).tasks.delete(params.id);
      if (!deleted) {
        set.status = 404;
        return { error: 'Task not found' };
      }
      return { deleted };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { tags: ['tasks'] },
    }
  );
