import { activateHeartbeatService } from '@/api/heartbeat-settings';
import { apiContext } from '@/api/context';
import { Elysia, t } from '@/api/http';
import { disableRoleHeartbeatHook, ensureRoleHeartbeatHook } from '@/core/heartbeat';
import { auditTaskMutation, changedTaskFields, type TaskMutationOp } from '@/core/tasks/audit';
import { TASK_CHECKOUT_TTL_MS } from '@/core/tasks/checkout';
import { myDay, myDayDate } from '@/core/tasks/my-day';
import { type LinkedNote, linkNote, NoteLinkError, unlinkNote, withLinkedNotes } from '@/core/tasks/note-links';
import { nextActions } from '@/core/tasks/next';
import { parseQuickAdd, quickAddDueAt } from '@/core/tasks/quick-add';
import { dateOnlyToEndOfDay } from '@/core/tasks/rank';
import { normalizeRepeat } from '@/core/tasks/repeat';
import { listRoleAgents, roleAgentToggleError, setRolePipelineTemplate } from '@/core/tasks/role-agents';
import { resolveRoleTemplate } from '@/core/tasks/role-pipelines';
import { ACTIVE_TASK_STATUSES, assigneePatch, isTaskStatus, TASK_ASSIGNEE_KINDS, TASK_STATUSES } from '@/core/tasks/status';
import { normalizeEstimate } from '@/core/tasks/structure';
import { parseTaskDate, rememberDeviceTimezone, resolveUserTimezone } from '@/core/tasks/timezone';
import { queryRaw } from '@/db/postgres';
import { type ContentRepos, contentRepos } from '@/db/repositories/content';
import { getNoteService, NoteExistsError } from '@/core/knowledge/notes';
import type { NewTask } from '@/db/schema/tasks';
import { API_SCOPES } from '@/security/scopes';
import { isAuthenticated, requireScope, type Principal } from '@/security/principal';
import { SpaceError } from '@/security/space-access';
import { apiLogger } from '@/utils/logger';

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

/**
 * Audit a task mutation made through the API. The row is filed under the
 * task's owner; the actor is whoever really acted (an impersonating admin, or
 * an admin editing someone else's task), with `onBehalfOf` naming the owner
 * whenever the two differ. There is no run (the HTTP stack assigns no request
 * id), so `runId` is null.
 */
function auditUserTaskMutation(
  principal: Principal,
  task: { id: string; userId: string },
  op: TaskMutationOp,
  change: string[],
): Promise<void> {
  const actingUserId = principal.actorUserId ?? principal.userId;
  const actor = actingUserId !== task.userId
    ? { kind: 'user' as const, id: actingUserId, onBehalfOf: task.userId }
    : { kind: 'user' as const, id: actingUserId };
  return auditTaskMutation({ userId: task.userId, taskId: task.id, op, change, actor, runId: null });
}

/**
 * Stamp list rows with their lease end and the server's clock, so the board
 * judges "working" vs "claim lapsed" against the database's time rather than
 * the browser's (the checkout itself is judged on the database clock).
 * `leaseExpiresAt` is `checked_out_at + TTL`, computed by the database in the
 * same query that reads its `now()`; null when nobody holds the task.
 */
async function withLeases<T extends { id: string; checkedOutAt: Date | null }>(
  rows: T[],
): Promise<{ serverNow: string; tasks: (T & { leaseExpiresAt: string | null })[] }> {
  const held = rows.filter((r) => r.checkedOutAt);
  const ttl = `${TASK_CHECKOUT_TTL_MS} milliseconds`;
  const { rows: res } = await queryRaw(
    `SELECT now() AS now, coalesce(
       (SELECT json_object_agg(x.id, (x.at::timestamptz + $2::interval))
          FROM json_to_recordset($1::json) AS x(id text, at text)), '{}'::json) AS leases`,
    [JSON.stringify(held.map((r) => ({ id: r.id, at: r.checkedOutAt!.toISOString() }))), ttl],
  );
  const leases = (res[0]?.leases ?? {}) as Record<string, string>;
  const serverNow = new Date(res[0]?.now ?? Date.now()).toISOString();
  return {
    serverNow,
    tasks: rows.map((r) => ({ ...r, leaseExpiresAt: leases[r.id] ? new Date(leases[r.id]).toISOString() : null })),
  };
}

/** Done tasks in one page of the unfiltered list, by default and at most. */
const DONE_PAGE = 50;
const DONE_PAGE_MAX = 500;
/** A `?status=` list's page by default (its cap before paging existed). */
const STATUS_PAGE = 200;
/**
 * The active tasks of the unfiltered list are not paged: the list exists to
 * show them all. This only bounds a runaway (the tasks tool reads as many).
 */
const ACTIVE_LIST_MAX = 5000;

/** A non-negative integer query value, clamped to [min, max]; absent → `fallback`. */
function boundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** De-duplicate an id list from the body; strings only. */
function idList(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

/**
 * A repeat rule in a body: a preset name ("daily", "weekdays", "weekly",
 * "monthly", "yearly") or `{ unit, interval?, weekdays? }`; null clears it.
 * Checked by `normalizeRepeat` (a 400 names what is wrong).
 */
const REPEAT = t.Union([
  t.Null(),
  t.String({ maxLength: 20 }),
  t.Object({
    unit: t.String({ maxLength: 10 }),
    interval: t.Optional(t.Integer()),
    weekdays: t.Optional(t.Union([t.Array(t.Integer(), { maxItems: 7 }), t.Null()])),
  }),
]);

/**
 * Remember the zone a client reported (web: the browser's IANA zone; mobile:
 * a fixed offset), by the rules of `rememberDeviceTimezone`. Never while an
 * admin acts as the user. Detached: the request never waits on or fails by it.
 */
function noteZone(principal: Principal, tz: string | undefined): void {
  if (!tz || principal.actorUserId) return;
  rememberDeviceTimezone(principal.userId, tz).catch((err: unknown) => apiLogger.error({ err, userId: principal.userId }, 'tasks: could not remember the reported time zone'));
}

/** True when any of `fields` is given (`undefined` = left alone). */
function anyGiven(fields: object): boolean {
  return Object.values(fields).some((v) => v !== undefined);
}

/** A link refused by `core/tasks/note-links.ts`, as a status and body; null for any other error. */
function noteLinkError(err: unknown, set: { status?: number | string }): { error: string; code: string } | null {
  if (!(err instanceof NoteLinkError)) return null;
  set.status = err.code === 'not_found' ? 404 : err.code === 'invalid' ? 400 : 409;
  return { error: err.message, code: err.code };
}

/** List rows with the notes each links to that the reader can open (`linkedNotes`). */
async function withNotes<T extends { tasks: { id: string }[] }>(repos: ContentRepos, result: T): Promise<Omit<T, 'tasks'> & { tasks: (T['tasks'][number] & { linkedNotes: LinkedNote[] })[] }> {
  return { ...result, tasks: await withLinkedNotes(repos, result.tasks) };
}

/** One row with its `linkedNotes`. */
async function oneWithNotes<T extends { id: string }>(repos: ContentRepos, row: T): Promise<T & { linkedNotes: LinkedNote[] }> {
  return (await withLinkedNotes(repos, [row]))[0];
}

/**
 * A new note for a to-do: `title` as its first line, at the slug of the
 * title (or, when a note holds that one, the title with a short suffix).
 */
async function newNoteFor(repos: ContentRepos, title: string): Promise<string> {
  const notes = getNoteService();
  for (let attempt = 0; attempt < 3; attempt++) {
    const slug = attempt === 0 ? title : `${title} ${Math.random().toString(36).slice(2, 6)}`;
    try {
      const saved = await notes.save({ scope: repos.noteScope, title, slug, body: `${title}\n\n`, createOnly: true, deferIndex: true });
      return saved.note.id;
    } catch (err) {
      if (!(err instanceof NoteExistsError)) throw err;
    }
  }
  throw new Error('Could not find a free name for the note');
}

/** A manual sort position: any finite number. */
function sortOrderValue(value: number): number {
  if (!Number.isFinite(value)) throw new Error('sortOrder must be a finite number');
  return value;
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

  // List the caller's tasks. ?status= filters, a page at a time (`limit`,
  // default 200, at most 500; `offset`; a `page` summary), finished ones most
  // recent first; without it the list is every active task followed by one
  // page of done ones (`?doneLimit=`, default 50, and `?doneOffset=`), with a
  // `done` summary saying how many there are; archived ones only come with
  // ?status=archived. ?due=today returns tasks due by end of today;
  // ?view=next returns open tasks in next-action order, each with a `bucket`
  // and a one-line `reason` (see core/tasks/rank.ts). `?tz=` is the browser's
  // IANA zone — "today" is the user's day, not the server's.
  .get(
    '/',
    async ({ user, principal, query, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }
      noteZone(principal, query?.tz);
      const repo = contentRepos(principal).tasks;
      if (query?.view === 'next') {
        const limit = query?.limit ? Math.max(1, Math.min(200, Number.parseInt(query.limit, 10) || 200)) : 200;
        const { timezone, ranked } = await nextActions(principal, { category: query?.category, tz: query?.tz, limit });
        const viewed = await repo.withState(ranked.map((r) => r.task));
        return { timezone, ...(await withNotes(contentRepos(principal), await withLeases(viewed.map((task, i) => ({ ...task, bucket: ranked[i].bucket, reason: ranked[i].reason }))))) };
      }
      let dueBefore: Date | undefined;
      if (query?.due === 'today') {
        dueBefore = new Date();
        dueBefore.setHours(23, 59, 59, 999);
      }
      const filter = {
        dueBefore,
        category: query?.category,
        assigneeKind: query?.assigneeKind,
        assigneeRef: query?.assigneeRef,
      };
      if (query?.status) {
        // One status, a page at a time (an archived or completed view).
        const limit = boundedInt(query.limit, STATUS_PAGE, 1, DONE_PAGE_MAX);
        const offset = boundedInt(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
        const [rows, total] = await Promise.all([
          repo.listOwn({ ...filter, status: query.status, limit, offset }),
          repo.countOwn({ ...filter, status: query.status }),
        ]);
        return { ...(await withNotes(contentRepos(principal), await withLeases(await repo.withState(rows)))), page: { total, offset, limit, hasMore: offset + rows.length < total } };
      }
      // No status: every active task, then one page of the done ones (most
      // recently finished first). A shared cap over both let finished tasks
      // push open ones out of the list.
      const doneLimit = boundedInt(query?.doneLimit, DONE_PAGE, 0, DONE_PAGE_MAX);
      const doneOffset = boundedInt(query?.doneOffset, 0, 0, Number.MAX_SAFE_INTEGER);
      const [active, done, doneTotal] = await Promise.all([
        repo.listOwn({ ...filter, statuses: [...ACTIVE_TASK_STATUSES], limit: ACTIVE_LIST_MAX }),
        doneLimit > 0 ? repo.listOwn({ ...filter, status: 'done', limit: doneLimit, offset: doneOffset }) : Promise.resolve([]),
        repo.countOwn({ ...filter, status: 'done' }),
      ]);
      return {
        ...(await withNotes(contentRepos(principal), await withLeases(await repo.withState([...active, ...done])))),
        done: { total: doneTotal, offset: doneOffset, limit: doneLimit, hasMore: doneOffset + done.length < doneTotal },
      };
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
        doneLimit: t.Optional(t.String({ pattern: '^[0-9]+$' })),
        doneOffset: t.Optional(t.String({ pattern: '^[0-9]+$' })),
        /** With `status`: rows to skip (and `limit` the page size, default 200, at most 500). */
        offset: t.Optional(t.String({ pattern: '^[0-9]+$' })),
      }),
      detail: { tags: ['tasks'] },
    }
  )

  // My Day (core/tasks/my-day.ts): today's picks (active and done) and
  // suggestions for it, "today" being the user's day (`?tz=` is the
  // browser's zone). Static path, declared before `/:id`.
  .get(
    '/my-day',
    async ({ user, principal, query, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }
      noteZone(principal, query?.tz);
      const day = await myDay(principal, query?.tz);
      return {
        timezone: day.timezone,
        date: day.date,
        tasks: await withLinkedNotes(contentRepos(principal), day.tasks),
        suggestions: day.suggestions.map((s) => ({ ...s.task, bucket: s.bucket, reason: s.reason })),
      };
    },
    {
      query: t.Object({ tz: t.Optional(t.String({ maxLength: 64 })) }),
      detail: { tags: ['tasks'] },
    }
  )

  // Parse a capture line without creating anything (core/tasks/quick-add.ts),
  // so a client can show the chips the server would read: the parse, plus the
  // `dueAt` it would store and the lists `#name` is matched against.
  .post(
    '/parse',
    async ({ user, principal, body, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }
      noteZone(principal, body.tz);
      const timezone = await resolveUserTimezone(user.id, body.tz);
      const lists = await contentRepos(principal).tasks.categories();
      const parsed = parseQuickAdd(body.text, { timezone, lists });
      return { ...parsed, dueAt: quickAddDueAt(parsed.due, timezone), timezone };
    },
    {
      body: t.Object({
        text: t.String({ minLength: 1, maxLength: 500 }),
        tz: t.Optional(t.String({ maxLength: 64 })),
      }),
      detail: { tags: ['tasks'] },
    }
  )

  // Lists (the `category` values, plus lists made empty). All static paths,
  // declared before `/:id`. In a space the space's lists, written by editors.
  .get(
    '/lists',
    async ({ user, principal, set }) => {
      if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
      return { lists: await contentRepos(principal).tasks.lists() };
    },
    { detail: { tags: ['tasks'] } }
  )
  // Make an empty list (409 when one of that name exists, in any case).
  .post(
    '/lists',
    async ({ user, principal, body, set }) => {
      if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
      try {
        return await contentRepos(principal).tasks.createList(body.name);
      } catch (err) {
        if (err instanceof SpaceError) throw err;
        set.status = /already exists/.test((err as Error).message) ? 409 : 400;
        return { error: (err as Error).message };
      }
    },
    { body: t.Object({ name: t.String({ minLength: 1, maxLength: 100 }) }), detail: { tags: ['tasks'] } }
  )
  // Rename a list: every to-do in it moves (onto an existing name: the lists merge).
  .patch(
    '/lists',
    async ({ user, principal, body, set }) => {
      if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
      try {
        return { name: body.newName.trim(), taskIds: await contentRepos(principal).tasks.renameList(body.name, body.newName) };
      } catch (err) {
        if (err instanceof SpaceError) throw err;
        set.status = 400;
        return { error: (err as Error).message };
      }
    },
    { body: t.Object({ name: t.String({ minLength: 1, maxLength: 100 }), newName: t.String({ minLength: 1, maxLength: 100 }) }), detail: { tags: ['tasks'] } }
  )
  // Delete a list: its to-dos stay, in no list; `taskIds` are the ones moved,
  // for an Undo through POST /lists/move.
  .delete(
    '/lists',
    async ({ user, principal, query, set }) => {
      if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
      return { taskIds: await contentRepos(principal).tasks.deleteList(query.name) };
    },
    { query: t.Object({ name: t.String({ minLength: 1, maxLength: 100 }) }), detail: { tags: ['tasks'] } }
  )
  // Put to-dos into a list (null: no list), e.g. to undo a list's deletion.
  .post(
    '/lists/move',
    async ({ user, principal, body, set }) => {
      if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
      return { taskIds: await contentRepos(principal).tasks.moveToList(body.taskIds, body.name) };
    },
    {
      body: t.Object({ taskIds: t.Array(t.String(), { maxItems: 1000 }), name: t.Union([t.String({ minLength: 1, maxLength: 100 }), t.Null()]) }),
      detail: { tags: ['tasks'] },
    }
  )

  // The tasks page's role-agents panel: every role the caller has tasks
  // assigned to (or already runs a role heartbeat for), with its task counts
  // and whether its heartbeat agent is enabled, plus what else a role turn
  // needs: the tasks/write permission and the server's heartbeat switch.
  // Per user across workspaces, like the hook and its probe (see
  // core/tasks/role-agents.ts). Static path, declared before `/:id`.
  .get(
    '/role-agents',
    async ({ user, principal, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }
      return listRoleAgents(user.id);
    },
    { detail: { tags: ['tasks'] } }
  )

  // Turn a role's heartbeat agent on or off for the caller (idempotent). On
  // creates or re-enables the one heartbeat hook for that role; off disables
  // every hook for it. A malformed or (to turn on) unknown role is a 400;
  // anything else is a logged 500.
  .put(
    '/role-agents',
    async ({ user, principal, body, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }
      if (!requireScope(principal, API_SCOPES.WRITE)) { set.status = 403; return { error: 'Write scope required to change role heartbeat settings' }; }
      const invalid = await roleAgentToggleError(body.role, body.enabled);
      if (invalid) {
        set.status = 400;
        return { error: invalid };
      }
      // How the agent works its tasks: through a pipeline template (checked
      // here, so a template that cannot run unattended is refused now rather
      // than failing on every heartbeat), or itself (null).
      let template: { id: string; name: string } | null | undefined;
      if (body.enabled && body.pipelineTemplate !== undefined) {
        if (body.pipelineTemplate === null || body.pipelineTemplate === '') {
          template = null;
        } else {
          const resolved = await resolveRoleTemplate(user.id, body.pipelineTemplate);
          if ('error' in resolved) {
            set.status = 400;
            return { error: resolved.error };
          }
          template = resolved;
        }
      }
      try {
        if (body.enabled) {
          const hookId = await ensureRoleHeartbeatHook(user.id, body.role);
          // The hook row is read fresh when it fires, so no cache to reload.
          if (template !== undefined) await setRolePipelineTemplate(user.id, body.role, template?.id ?? null);
          await activateHeartbeatService(user, principal);
          return { role: body.role, enabled: true, hookId, ...(template !== undefined ? { pipelineTemplate: template?.id ?? null } : {}) };
        }
        await disableRoleHeartbeatHook(user.id, body.role);
        return { role: body.role, enabled: false };
      } catch (err) {
        apiLogger.error({ err, userId: user.id, role: body.role, enabled: body.enabled }, 'tasks: role agent toggle failed');
        set.status = 500;
        return { error: 'Could not update the role agent' };
      }
    },
    {
      body: t.Object({
        role: t.String({ minLength: 1, maxLength: 64 }),
        enabled: t.Boolean(),
        /** A template id or name to run each task through; null = the agent works tasks itself. */
        pipelineTemplate: t.Optional(t.Union([t.String({ maxLength: 200 }), t.Null()])),
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
      const repo = contentRepos(principal).tasks;
      const task = await repo.findById(params.id);
      if (!task) {
        set.status = 404;
        return { error: 'Task not found' };
      }
      return oneWithNotes(contentRepos(principal), (await repo.withState([task]))[0]);
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
      noteZone(principal, body.tz);
      try {
        // `quick`: a capture line read by the shared parser; any field given
        // explicitly wins over what the line said.
        let quick: { title: string; dueAt: string | null; priority: number | null; important: boolean; category: string | null; repeat: unknown } | null = null;
        if (body.quick !== undefined) {
          const timezone = await resolveUserTimezone(user.id, body.tz);
          const parsed = parseQuickAdd(body.quick, { timezone, lists: await contentRepos(principal).tasks.categories() });
          quick = { ...parsed, dueAt: quickAddDueAt(parsed.due, timezone) };
        }
        const title = (body.title ?? quick?.title ?? '').trim();
        if (!title) throw new Error('title or quick is required');
        const dueAt = body.dueAt ?? quick?.dueAt ?? null;
        const values: Omit<NewTask, 'userId'> = {
          title,
          notes: body.notes ?? null,
          priority: body.priority ?? quick?.priority ?? 0,
          category: normalizeCategory(body.category ?? quick?.category),
          repeat: normalizeRepeat(body.repeat !== undefined ? body.repeat : quick?.repeat),
          dueAt: dueAt ? await parseDueAt(dueAt, user.id, body.tz) : null,
          remindAt: body.remindAt ? await parseTaskDate(body.remindAt, 'remindAt', user.id, body.tz) : null,
          estimate: normalizeEstimate(body.estimate),
          parentId: body.parentId || null,
          blockedBy: body.blockedBy ? idList(body.blockedBy) : [],
          ...assigneePatch(body.assigneeKind, body.assigneeRef),
          source: 'user',
        };
        const repos = contentRepos(principal);
        const repo = repos.tasks;
        // Checked before anything is written: a bad sort order is a 400, not a half-made to-do.
        const sortOrder = body.sortOrder !== undefined ? sortOrderValue(body.sortOrder) : undefined;
        if (body.noteAnchor !== undefined && !body.noteId) throw new Error('noteAnchor needs noteId');
        // The note it is made from must be in reach before anything is written.
        if (body.noteId && !(await repos.notes.getById(body.noteId))) throw new NoteLinkError('not_found', 'Note not found');
        const task = await repo.create(values, { tz: body.tz });
        if (body.noteId) {
          try {
            await linkNote(repos, { taskId: task.id, noteId: body.noteId, anchor: body.noteAnchor ?? null });
          } catch (err) {
            // Not linked (that line is already another to-do): nothing is made.
            await repo.delete(task.id);
            throw err;
          }
        }
        await auditUserTaskMutation(principal, task, 'create', changedTaskFields(values));
        // The creator's own layer: star, My Day, position.
        const important = body.important ?? quick?.important ?? undefined;
        const personal = {
          important: important || undefined,
          myDayOn: body.myDay ? (await myDayDate(user.id, body.tz)).date : undefined,
          sortOrder,
        };
        const view = anyGiven(personal) ? await repo.setPersonal(task.id, personal) : (await repo.withState([task]))[0];
        return view ? oneWithNotes(repos, view) : view;
      } catch (err) {
        // A role refusal keeps its status (403 / 409) through the error handler.
        if (err instanceof SpaceError) throw err;
        const refused = noteLinkError(err, set);
        if (refused) return refused;
        set.status = 400;
        return { error: (err as Error).message };
      }
    },
    {
      body: t.Object({
        /** Required unless `quick` gives one. */
        title: t.Optional(t.String({ minLength: 1, maxLength: 500 })),
        /** A capture line ("call dentist tomorrow 3pm !high #personal"), parsed on the server; explicit fields win. */
        quick: t.Optional(t.String({ minLength: 1, maxLength: 500 })),
        notes: t.Optional(t.String({ maxLength: 10_000 })),
        priority: t.Optional(t.Integer({ minimum: 0, maximum: 3 })),
        category: t.Optional(t.String({ maxLength: 100 })),
        /** The caller's star (per user). */
        important: t.Optional(t.Boolean()),
        /** The caller's position, ascending (per user); default the task's: minus its creation time in ms. */
        sortOrder: t.Optional(t.Number()),
        /** Put it in the caller's My Day for today (today in `tz`). */
        myDay: t.Optional(t.Boolean()),
        repeat: t.Optional(REPEAT),
        dueAt: t.Optional(t.String()),
        /** Follow-up: when the task comes back to the assignee (ISO 8601; a bare date is the start of that day). */
        remindAt: t.Optional(t.String()),
        estimate: t.Optional(t.String({ maxLength: 40 })),
        parentId: t.Optional(t.String()),
        blockedBy: t.Optional(t.Array(t.String(), { maxItems: 100 })),
        assigneeKind: t.Optional(ASSIGNEE_KIND),
        assigneeRef: t.Optional(t.String({ maxLength: 200 })),
        /** Browser zone; decides which day a bare `YYYY-MM-DD` dueAt ends on. */
        tz: t.Optional(t.String({ maxLength: 64 })),
        /** A note to link the new to-do to (one the caller reaches; 404 otherwise). */
        noteId: t.Optional(t.String({ format: 'uuid' })),
        /**
         * With `noteId`: the to-do is made from the note line that carries
         * ` ^todo-<noteAnchor>` (the client writes the marker into the note;
         * src/shared/note-todos.ts). 409 when that line is already another to-do.
         */
        noteAnchor: t.Optional(t.String({ pattern: '^[a-z0-9]{6,16}$' })),
      }),
      detail: { tags: ['tasks'] },
    }
  )

  // Update a task (title/notes/status/priority/due/category/estimate/parent/
  // blockers/assignee, star/sort order/My Day/repeat; a null assigneeKind or
  // assigneeRef unassigns). Manages completedAt. Completing a repeating to-do
  // creates its next occurrence once (the response's `repeatNextId` names it);
  // reopening it takes an untouched next occurrence back (TaskRepo.update). A parent or blocker the caller cannot see, a self-link, or a
  // parent loop is a 400 from the scoped repo. The user is the boss here: a
  // PATCH goes through even while an agent holds the checkout, and moving the
  // task to open, done or archived ends that checkout (the tasks tool, by
  // contrast, refuses an agent that is not the holder).
  .patch(
    '/:id',
    async ({ user, principal, params, body, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }
      const repo = contentRepos(principal).tasks;
      const existing = await repo.findById(params.id);
      if (!existing) {
        set.status = 404;
        return { error: 'Task not found' };
      }
      // `in`, not truthiness: an empty-string status is invalid, not "unchanged".
      if ('status' in body && !isTaskStatus(body.status)) {
        set.status = 400;
        return { error: `Invalid status "${body.status}"` };
      }
      noteZone(principal, body.tz);
      try {
        // The caller's own layer (star, My Day, position) is theirs alone, so
        // any reader may set it; the task's fields need write access.
        const personal = {
          important: body.important,
          sortOrder: body.sortOrder !== undefined ? sortOrderValue(body.sortOrder) : undefined,
          myDayOn: body.myDay !== undefined ? (body.myDay ? (await myDayDate(user.id, body.tz)).date : null) : undefined,
        };
        const patch: Partial<NewTask> = {
          title: body.title,
          notes: body.notes,
          status: body.status,
          priority: body.priority,
          category: body.category !== undefined ? normalizeCategory(body.category) : undefined,
          repeat: body.repeat !== undefined ? normalizeRepeat(body.repeat) : undefined,
          dueAt: body.dueAt !== undefined ? (body.dueAt ? await parseDueAt(body.dueAt, user.id, body.tz) : null) : undefined,
          remindAt: body.remindAt !== undefined ? (body.remindAt ? await parseTaskDate(body.remindAt, 'remindAt', user.id, body.tz) : null) : undefined,
          estimate: body.estimate !== undefined ? normalizeEstimate(body.estimate) : undefined,
          parentId: body.parentId !== undefined ? body.parentId || null : undefined,
          blockedBy: body.blockedBy !== undefined ? idList(body.blockedBy ?? []) : undefined,
          ...assigneePatch(body.assigneeKind, body.assigneeRef),
          ...completionPatch(body.status, Boolean(existing.completedAt)),
        };
        const fieldsGiven = anyGiven(patch) || !anyGiven(personal);
        const updated = fieldsGiven ? await repo.update(params.id, patch, { tz: body.tz }) : existing;
        if (!updated) {
          set.status = 404;
          return { error: 'Task not found' };
        }
        const change = fieldsGiven ? changedTaskFields(patch, existing) : [];
        if (change.length > 0) {
          const op = body.status === 'done' && existing.status !== 'done' ? 'complete' : 'update';
          await auditUserTaskMutation(principal, updated, op, change);
        }
        const repos = contentRepos(principal);
        if (anyGiven(personal)) {
          const viewed = await repo.setPersonal(params.id, personal);
          return oneWithNotes(repos, viewed ? { ...viewed, ...updated, important: viewed.important, myDayOn: viewed.myDayOn, sortOrder: viewed.sortOrder } : updated);
        }
        return oneWithNotes(repos, (await repo.withState([updated]))[0]);
      } catch (err) {
        // A role refusal keeps its status (403 / 409) through the error handler.
        if (err instanceof SpaceError) throw err;
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
        important: t.Optional(t.Boolean()),
        sortOrder: t.Optional(t.Number()),
        /** true puts it in today's My Day (today in `tz`); false or null takes it out. */
        myDay: t.Optional(t.Union([t.Boolean(), t.Null()])),
        /** null stops the repeat. */
        repeat: t.Optional(REPEAT),
        dueAt: t.Optional(t.Union([t.String(), t.Null()])),
        remindAt: t.Optional(t.Union([t.String(), t.Null()])),
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
      const result = await contentRepos(principal).tasks.checkout(params.id, actor, body?.runId ?? null);
      if (result.ok) return result.task;
      if (result.reason === 'not_found') {
        set.status = 404;
        return { error: 'Task not found' };
      }
      set.status = 409;
      if (result.reason === 'blocked') return { error: 'Task is blocked', reason: 'blocked', waiting: result.waiting };
      // A future occurrence of a repeating to-do: not work before its due day.
      if (result.reason === 'not_due') return { error: 'This occurrence is not due yet', reason: 'not_due', dueAt: result.dueAt.toISOString() };
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
      const result = await contentRepos(principal).tasks.release(params.id, actor, { force: body?.force });
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

  // A task's comment thread: the newest 200, oldest first; `truncated` says
  // older ones were left out.
  .get(
    '/:id/comments',
    async ({ user, principal, params, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }
      const thread = await contentRepos(principal).tasks.listComments(params.id);
      if (!thread) {
        set.status = 404;
        return { error: 'Task not found' };
      }
      return thread;
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
      const comment = await contentRepos(principal).tasks.addComment(params.id, {
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

  // Link a note to a to-do: an existing one (`noteId`), or a new one made
  // for it (`title`; its first line is the title). Idempotent; needs write
  // access to the to-do; a note out of reach is 404. Answers the note as the
  // to-do shows it.
  .post(
    '/:id/notes',
    async ({ user, principal, params, body, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }
      if (!body.noteId === !body.title) {
        set.status = 400;
        return { error: 'Give noteId or title' };
      }
      const repos = contentRepos(principal);
      try {
        repos.can('write');
        let noteId = body.noteId;
        if (body.title) {
          const task = await repos.tasks.findById(params.id);
          if (!task) throw new NoteLinkError('not_found', 'Task not found');
          noteId = await newNoteFor(repos, body.title.trim());
        }
        const note = await linkNote(repos, { taskId: params.id, noteId: noteId as string });
        return { note };
      } catch (err) {
        if (err instanceof SpaceError) throw err;
        const refused = noteLinkError(err, set);
        if (refused) return refused;
        throw err;
      }
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        noteId: t.Optional(t.String({ format: 'uuid' })),
        title: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
      }),
      detail: { tags: ['tasks'] },
    }
  )

  // Unlink a note from a to-do (the note, and any line of it, stay as they are).
  .delete(
    '/:id/notes/:noteId',
    async ({ user, principal, params, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }
      if (!(await unlinkNote(contentRepos(principal), params.id, params.noteId))) {
        set.status = 404;
        return { error: 'Link not found' };
      }
      return { unlinked: true };
    },
    {
      params: t.Object({ id: t.String(), noteId: t.String({ format: 'uuid' }) }),
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
      const repo = contentRepos(principal).tasks;
      // Read first: the audit row is filed under the task's owner.
      const existing = await repo.findById(params.id);
      if (!existing || !(await repo.delete(params.id))) {
        set.status = 404;
        return { error: 'Task not found' };
      }
      await auditUserTaskMutation(principal, existing, 'delete', []);
      return { deleted: true };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { tags: ['tasks'] },
    }
  );
