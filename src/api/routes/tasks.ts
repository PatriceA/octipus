import { apiContext } from '@/api/context';
import { Elysia, t } from '@/api/http';
import { nextActions } from '@/core/tasks/next';
import { dateOnlyToEndOfDay } from '@/core/tasks/rank';
import { assigneePatch, isTaskStatus, TASK_ASSIGNEE_KINDS, TASK_STATUSES } from '@/core/tasks/status';
import { normalizeEstimate } from '@/core/tasks/structure';
import { resolveUserTimezone } from '@/core/tasks/timezone';
import { scopedRepos } from '@/db/repositories/scoped';
import type { NewTask } from '@/db/schema/tasks';
import { isAuthenticated } from '@/security/principal';

const STATUSES = TASK_STATUSES;
const ASSIGNEE_KIND = t.Union(TASK_ASSIGNEE_KINDS.map((k) => t.Literal(k)));

/** Derive completedAt transitions from a status change. */
function completionPatch(nextStatus: string | undefined, wasCompleted: boolean): Partial<NewTask> {
  if (nextStatus === 'done' && !wasCompleted) return { completedAt: new Date() };
  if (nextStatus && nextStatus !== 'done' && wasCompleted) return { completedAt: null };
  return {};
}

/**
 * Parse a due date. A bare `YYYY-MM-DD` (what the date picker sends) means
 * the end of that day in the user's zone; anything else is ISO 8601. Throws
 * a clear error on garbage rather than storing NaN.
 */
async function parseDueAt(value: string, userId: string, tz: string | undefined): Promise<Date> {
  const dateOnly = dateOnlyToEndOfDay(value, await resolveUserTimezone(userId, tz));
  if (dateOnly) return dateOnly;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid dueAt "${value}" — expected an ISO 8601 date`);
  return d;
}

/** De-duplicate an id list from the body; strings only. */
function idList(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
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

  // List the caller's tasks. ?status= filters; ?due=today returns tasks due by
  // end of today; ?view=next returns open tasks in next-action order, each
  // with a `bucket` and a one-line `reason` (see core/tasks/rank.ts). `?tz=`
  // is the browser's IANA zone — "today" is the user's day, not the server's.
  .get(
    '/',
    async ({ user, principal, query, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }
      if (query?.view === 'next') {
        const limit = query?.limit ? Math.max(1, Math.min(200, Number.parseInt(query.limit, 10) || 200)) : 200;
        const { timezone, ranked } = await nextActions(principal, { category: query?.category, tz: query?.tz, limit });
        return { timezone, tasks: ranked.map((r) => ({ ...r.task, bucket: r.bucket, reason: r.reason })) };
      }
      let dueBefore: Date | undefined;
      if (query?.due === 'today') {
        dueBefore = new Date();
        dueBefore.setHours(23, 59, 59, 999);
      }
      const tasks = await scopedRepos(principal).tasks.listOwn({
        status: query?.status,
        dueBefore,
        category: query?.category,
        assigneeKind: query?.assigneeKind,
        assigneeRef: query?.assigneeRef,
      });
      return { tasks };
    },
    {
      query: t.Object({
        status: t.Optional(t.Union(STATUSES.map((s) => t.Literal(s)))),
        due: t.Optional(t.String()),
        category: t.Optional(t.String()),
        assigneeKind: t.Optional(ASSIGNEE_KIND),
        assigneeRef: t.Optional(t.String({ maxLength: 200 })),
        view: t.Optional(t.Literal('next')),
        limit: t.Optional(t.String()),
        tz: t.Optional(t.String({ maxLength: 64 })),
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
          dueAt: body.dueAt ? await parseDueAt(body.dueAt, user.id, body.tz) : null,
          estimate: normalizeEstimate(body.estimate),
          parentId: body.parentId || null,
          blockedBy: body.blockedBy ? idList(body.blockedBy) : [],
          ...assigneePatch(body.assigneeKind, body.assigneeRef),
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
        estimate: t.Optional(t.String({ maxLength: 40 })),
        parentId: t.Optional(t.String()),
        blockedBy: t.Optional(t.Array(t.String(), { maxItems: 100 })),
        assigneeKind: t.Optional(ASSIGNEE_KIND),
        assigneeRef: t.Optional(t.String({ maxLength: 200 })),
        /** Browser zone; decides which day a bare `YYYY-MM-DD` dueAt ends on. */
        tz: t.Optional(t.String({ maxLength: 64 })),
      }),
      detail: { tags: ['tasks'] },
    }
  )

  // Update a task (title/notes/status/priority/due/category/estimate/parent/
  // blockers/assignee; a null assigneeKind unassigns). Manages completedAt. A parent or blocker the caller cannot
  // see, a self-link, or a parent loop is a 400 from the scoped repo.
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
      if (body.status && !isTaskStatus(body.status)) {
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
          dueAt: body.dueAt !== undefined ? (body.dueAt ? await parseDueAt(body.dueAt, user.id, body.tz) : null) : undefined,
          estimate: body.estimate !== undefined ? normalizeEstimate(body.estimate) : undefined,
          parentId: body.parentId !== undefined ? body.parentId || null : undefined,
          blockedBy: body.blockedBy !== undefined ? idList(body.blockedBy ?? []) : undefined,
          ...assigneePatch(body.assigneeKind, body.assigneeRef),
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
        estimate: t.Optional(t.Union([t.String({ maxLength: 40 }), t.Null()])),
        parentId: t.Optional(t.Union([t.String(), t.Null()])),
        blockedBy: t.Optional(t.Union([t.Array(t.String(), { maxItems: 100 }), t.Null()])),
        assigneeKind: t.Optional(t.Union([ASSIGNEE_KIND, t.Null()])),
        assigneeRef: t.Optional(t.Union([t.String({ maxLength: 200 }), t.Null()])),
        tz: t.Optional(t.String({ maxLength: 64 })),
      }),
      detail: { tags: ['tasks'] },
    }
  )

  // Claim a task for work (board, after Paperclip). One conditional UPDATE, so
  // of two concurrent claimers one gets 200 and the other 409 naming the
  // holder; a task waiting on open blockers or sub-tasks is 409 'blocked'.
  // `actor` names the worker (an agent or runner acting for the user) and
  // defaults to the user; re-checkout by the same actor is idempotent.
  .post(
    '/:id/checkout',
    async ({ user, principal, params, body, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }
      const actor = body?.actor?.trim() || `user:${user.id}`;
      const result = await scopedRepos(principal).tasks.checkout(params.id, actor, body?.runId ?? null);
      if (result.ok) return result.task;
      if (result.reason === 'not_found') {
        set.status = 404;
        return { error: 'Task not found' };
      }
      set.status = 409;
      if (result.reason === 'blocked') return { error: 'Task is blocked', reason: 'blocked', waiting: result.waiting };
      return {
        error: result.holder ? `Task is checked out by ${result.holder}` : `Task is ${result.status}`,
        reason: 'conflict',
        holder: result.holder,
        status: result.status,
      };
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Optional(t.Object({
        actor: t.Optional(t.String({ maxLength: 200 })),
        runId: t.Optional(t.String({ maxLength: 200 })),
      })),
      detail: { tags: ['tasks'] },
    }
  )

  // Give a checkout back; the task returns to open. Only the holder may
  // release, unless `force` — the owner clearing a claim a dead agent left.
  .post(
    '/:id/release',
    async ({ user, principal, params, body, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }
      const actor = body?.actor?.trim() || `user:${user.id}`;
      const result = await scopedRepos(principal).tasks.release(params.id, actor, { force: body?.force });
      if (result.ok) return result.task;
      if (result.reason === 'not_found') {
        set.status = 404;
        return { error: 'Task not found' };
      }
      set.status = 409;
      return { error: `Task is checked out by ${result.holder}`, reason: 'conflict', holder: result.holder };
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Optional(t.Object({
        actor: t.Optional(t.String({ maxLength: 200 })),
        force: t.Optional(t.Boolean()),
      })),
      detail: { tags: ['tasks'] },
    }
  )

  // A task's comment thread, oldest first.
  .get(
    '/:id/comments',
    async ({ user, principal, params, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }
      const comments = await scopedRepos(principal).tasks.listComments(params.id);
      if (!comments) {
        set.status = 404;
        return { error: 'Task not found' };
      }
      return { comments };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { tags: ['tasks'] },
    }
  )

  // Comment on a task as the user (agents comment through the tasks tool).
  .post(
    '/:id/comments',
    async ({ user, principal, params, body, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }
      const comment = await scopedRepos(principal).tasks.addComment(params.id, {
        authorKind: 'user',
        authorRef: user.id,
        body: body.body,
      });
      if (!comment) {
        set.status = 404;
        return { error: 'Task not found' };
      }
      return comment;
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({ body: t.String({ minLength: 1, maxLength: 10_000 }) }),
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
