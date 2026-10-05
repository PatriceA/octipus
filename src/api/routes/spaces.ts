import { Elysia, t } from '@/api/http';
import { apiContext } from '@/api/context';
import { acceptInvite, createInvite, listInvites, previewInvite, revokeInvite } from '@/core/spaces/invites';
import { purgeSpace } from '@/core/spaces/purge';
import {
  archiveSpace,
  createSpace,
  getSpace,
  listActivity,
  listMembers,
  listSpaces,
  removeMember,
  renameSpace,
  setRole,
  type SpaceActor,
  unarchiveSpace,
} from '@/core/spaces/service';
import { isAuthenticated, type Principal } from '@/security/principal';
import { SpaceError, spaceErrorStatus } from '@/security/space-access';

/**
 * Shared spaces (docs/plans/coworking-spec.md §5.7).
 *
 *   /api/spaces/...        — authenticated; who may do what is the caller's
 *                            membership, read from the database on every call.
 *   /api/invites/:token    — GET is public (an exact method-and-path entry in
 *                            `auth-guard.ts`), POST .../accept checks the
 *                            session itself. Both are rate-limited per IP as
 *                            credential attempts (`rate-limit.ts`).
 *
 * Errors are typed `SpaceError`s: `invalid_*` 400, `not_found` 404 (also for
 * every space a caller is not a member of), `forbidden_role` 403 (a member
 * whose role lacks the action), `last_owner` / `space_full` / `archived` /
 * `not_purgeable` 409.
 */

export type RouteCtx = {
  set: { status?: number | string };
  principal: Principal;
};

/**
 * The caller as a space actor, or null with 401 set. An admin impersonating
 * a user acts with that user's rights and is named in every audit row (I10).
 */
function actorOf(ctx: RouteCtx): SpaceActor | null {
  if (!isAuthenticated(ctx.principal)) {
    ctx.set.status = 401;
    return null;
  }
  const by = ctx.principal.actorUserId;
  return { userId: ctx.principal.userId, impersonatedBy: by && by !== ctx.principal.userId ? by : null };
}

/** Run a space operation, mapping `SpaceError` to its status. Shared by the rooms routes. */
export async function handle<T>(ctx: RouteCtx, run: (actor: SpaceActor) => Promise<T>): Promise<T | { error: string; code?: string }> {
  const actor = actorOf(ctx);
  if (!actor) return { error: 'Authentication required' };
  try {
    return await run(actor);
  } catch (err) {
    if (err instanceof SpaceError) {
      ctx.set.status = spaceErrorStatus(err);
      return { error: err.message, code: err.code };
    }
    throw err;
  }
}

const roleSchema = t.Union([
  t.Literal('owner'),
  t.Literal('editor'),
  t.Literal('commenter'),
  t.Literal('viewer'),
  t.Literal('guest'),
]);
const invitableRoleSchema = t.Union([
  t.Literal('editor'),
  t.Literal('commenter'),
  t.Literal('viewer'),
  t.Literal('guest'),
]);
const scopeSchema = t.Record(t.String(), t.Unknown());

export const spaceRoutes = new Elysia({ prefix: '/spaces' })
  .use(apiContext)

  .get('/', (ctx) => handle(ctx, async (actor) => ({ spaces: await listSpaces(actor) })), {
    detail: { tags: ['spaces'] },
  })

  .post(
    '/',
    (ctx) => handle(ctx, async (actor) => {
      const space = await createSpace(actor, { name: ctx.body.name });
      ctx.set.status = 201;
      return space;
    }),
    {
      body: t.Object({ name: t.String({ minLength: 1, maxLength: 120 }) }, { additionalProperties: false }),
      detail: { tags: ['spaces'] },
    },
  )

  .get('/:id', (ctx) => handle(ctx, (actor) => getSpace(actor, ctx.params.id)), {
    params: t.Object({ id: t.String() }),
    detail: { tags: ['spaces'] },
  })

  .patch('/:id', (ctx) => handle(ctx, (actor) => renameSpace(actor, ctx.params.id, ctx.body.name)), {
    params: t.Object({ id: t.String() }),
    body: t.Object({ name: t.String({ minLength: 1, maxLength: 120 }) }, { additionalProperties: false }),
    detail: { tags: ['spaces'] },
  })

  .post('/:id/archive', (ctx) => handle(ctx, (actor) => archiveSpace(actor, ctx.params.id)), {
    params: t.Object({ id: t.String() }),
    detail: { tags: ['spaces'] },
  })

  .post('/:id/unarchive', (ctx) => handle(ctx, (actor) => unarchiveSpace(actor, ctx.params.id)), {
    params: t.Object({ id: t.String() }),
    detail: { tags: ['spaces'] },
  })

  // Purge (§5.8): only a space archived for `spaces.purgeAfterArchiveDays`.
  .delete('/:id', (ctx) => handle(ctx, async (actor) => {
    const result = await purgeSpace(actor, ctx.params.id);
    return { success: true, leftoverDirectories: result.leftoverDirectories.length };
  }), {
    params: t.Object({ id: t.String() }),
    detail: { tags: ['spaces'] },
  })

  .get('/:id/members', (ctx) => handle(ctx, async (actor) => ({ members: await listMembers(actor, ctx.params.id) })), {
    params: t.Object({ id: t.String() }),
    detail: { tags: ['spaces'] },
  })

  .patch(
    '/:id/members/:userId',
    (ctx) => handle(ctx, (actor) => setRole(actor, ctx.params.id, ctx.params.userId, { role: ctx.body.role, scope: ctx.body.scope })),
    {
      params: t.Object({ id: t.String(), userId: t.String() }),
      body: t.Object({ role: roleSchema, scope: t.Optional(scopeSchema) }, { additionalProperties: false }),
      detail: { tags: ['spaces'] },
    },
  )

  // Owner removes a member, or a member removes themselves (leaves).
  .delete('/:id/members/:userId', (ctx) => handle(ctx, async (actor) => {
    // The removal stands even when a follow-up step failed; `warning` says which.
    return { success: true, ...(await removeMember(actor, ctx.params.id, ctx.params.userId)) };
  }), {
    params: t.Object({ id: t.String(), userId: t.String() }),
    detail: { tags: ['spaces'] },
  })

  .get('/:id/invites', (ctx) => handle(ctx, async (actor) => ({ invites: await listInvites(actor, ctx.params.id) })), {
    params: t.Object({ id: t.String() }),
    detail: { tags: ['spaces'] },
  })

  .post(
    '/:id/invites',
    (ctx) => handle(ctx, async (actor) => {
      const invite = await createInvite(actor, ctx.params.id, ctx.body);
      ctx.set.status = 201;
      return invite;
    }),
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        role: invitableRoleSchema,
        scope: t.Optional(scopeSchema),
        expiresInHours: t.Optional(t.Number({ minimum: 0 })),
        maxUses: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
      }, { additionalProperties: false }),
      detail: { tags: ['spaces'] },
    },
  )

  .delete('/:id/invites/:inviteId', (ctx) => handle(ctx, async (actor) => {
    await revokeInvite(actor, ctx.params.id, ctx.params.inviteId);
    return { success: true };
  }), {
    params: t.Object({ id: t.String(), inviteId: t.String() }),
    detail: { tags: ['spaces'] },
  })

  .get('/:id/activity', (ctx) => handle(ctx, async (actor) => {
    const limit = ctx.query.limit === undefined ? undefined : Number(ctx.query.limit);
    if (limit !== undefined && !Number.isInteger(limit)) throw new SpaceError('invalid_input', 'limit must be an integer');
    const before = ctx.query.before === undefined ? undefined : new Date(ctx.query.before);
    if (before && Number.isNaN(before.getTime())) throw new SpaceError('invalid_input', 'before must be a timestamp');
    return { activity: await listActivity(actor, ctx.params.id, { limit, before }) };
  }), {
    params: t.Object({ id: t.String() }),
    query: t.Object({ limit: t.Optional(t.String()), before: t.Optional(t.String()) }),
    detail: { tags: ['spaces'] },
  });

/**
 * Invite links. `GET /api/invites/:token` is the only public route here; the
 * guard lists it by method and exact shape, so `POST .../accept` is not
 * public and is checked again below.
 */
export const inviteRoutes = new Elysia({ prefix: '/invites' })
  .use(apiContext)

  .get('/:token', async (ctx) => {
    const preview = await previewInvite(ctx.params.token);
    if (!preview) {
      ctx.set.status = 404;
      return { error: 'Invite not found or expired' };
    }
    return preview;
  }, {
    params: t.Object({ token: t.String() }),
    detail: { tags: ['spaces'] },
  })

  .post('/:token/accept', (ctx) => handle(ctx, (actor) => acceptInvite(actor, ctx.params.token)), {
    params: t.Object({ token: t.String() }),
    detail: { tags: ['spaces'] },
  });
