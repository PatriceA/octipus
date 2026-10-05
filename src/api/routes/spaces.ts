import { Elysia, t } from '@/api/http';
import { apiContext } from '@/api/context';
import {
  acquireLease,
  InvalidLeasePathError,
  leaseViews,
  listLeases,
  normalizeLeasePath,
  releaseLease,
  renewLease,
} from '@/core/docs/file-leases';
import { acceptInvite, createInvite, listInvites, previewInvite, revokeInvite } from '@/core/spaces/invites';
import { setSpaceFunding } from '@/core/spaces/funding';
import { purgeSpace } from '@/core/spaces/purge';
import {
  archiveSpace,
  createSpace,
  getMembership,
  getSpace,
  isSpaceArchived,
  listActivity,
  listMembers,
  listSpaces,
  removeMember,
  renameSpace,
  setAgentEditMode,
  setRole,
  type SpaceActor,
  unarchiveSpace,
} from '@/core/spaces/service';
import { isAuthenticated, type Principal } from '@/security/principal';
import { requireCan, type SpaceAction, SpaceError, spaceErrorStatus } from '@/security/space-access';

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
 * `not_purgeable` / `funding_off` 409.
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

/**
 * The actor may `action` in the space (membership read now, D5); anything
 * but reading also needs the space open.
 */
async function requireMember(actor: SpaceActor, workspaceId: string, action: SpaceAction): Promise<void> {
  requireCan(await getMembership(actor.userId, workspaceId), action);
  if (action !== 'read' && await isSpaceArchived(workspaceId)) throw new SpaceError('archived', 'This space is archived');
}

/** A lease path from the request, normalized relative to the space's files root. */
function leasePath(raw: string): string {
  try {
    return normalizeLeasePath(raw);
  } catch (err) {
    if (err instanceof InvalidLeasePathError) throw new SpaceError('invalid_input', err.message);
    throw err;
  }
}

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

  // How the agent edits the space's notes (§7.4): owners only.
  .put('/:id/agent-edit-mode', (ctx) => handle(ctx, (actor) => setAgentEditMode(actor, ctx.params.id, ctx.body.mode)), {
    params: t.Object({ id: t.String() }),
    body: t.Object({ mode: t.Union([t.Literal('suggest'), t.Literal('direct')]) }, { additionalProperties: false }),
    detail: { tags: ['spaces'] },
  })

  // Who pays for the agent (§9.1): owners. `sponsor: 'me'` names the caller
  // as the sponsor, null clears it; only the sponsor lists sponsor models.
  .put('/:id/funding', (ctx) => handle(ctx, (actor) => setSpaceFunding(actor, ctx.params.id, ctx.body)), {
    params: t.Object({ id: t.String() }),
    body: t.Object({
      mode: t.Optional(t.Union([t.Literal('own'), t.Literal('unattended'), t.Literal('sponsored')])),
      sponsor: t.Optional(t.Union([t.Literal('me'), t.Null()])),
      sponsorModels: t.Optional(t.Array(t.String({ minLength: 1, maxLength: 200 }), { maxItems: 20 })),
    }, { additionalProperties: false }),
    detail: { tags: ['spaces'] },
  })

  // The space's budgets (§9.2) with their spend this period; the member cap
  // shows the caller's own share. Any member reads them.
  .get('/:id/budget', (ctx) => handle(ctx, async (actor) => {
    await requireMember(actor, ctx.params.id, 'read');
    const { spaceBudgetStatuses } = await import('@/security/spend-budgets');
    return { budgets: await spaceBudgetStatuses(ctx.params.id, actor.userId) };
  }), {
    params: t.Object({ id: t.String() }),
    detail: { tags: ['spaces'] },
  })

  // Set (or, with `limitUsd: null`, remove) a space budget: owners. `space`
  // caps everything the sponsor pays in the space, `space_member` each
  // member's share. Audited (I10).
  .put('/:id/budget', (ctx) => handle(ctx, async (actor) => {
    await requireMember(actor, ctx.params.id, 'manage_space');
    const { limitUsd, warnRatio } = ctx.body;
    if (limitUsd !== null && !(limitUsd > 0)) throw new SpaceError('invalid_input', 'limitUsd must be a positive number or null');
    if (warnRatio !== undefined && !(warnRatio > 0 && warnRatio <= 1)) throw new SpaceError('invalid_input', 'warnRatio must be in (0, 1]');
    const { setSpaceBudget, spaceBudgetStatuses } = await import('@/security/spend-budgets');
    const { auditActor, writeSpaceAudit } = await import('@/core/spaces/service');
    const { getDb } = await import('@/db/postgres');
    await getDb().transaction(async (tx) => {
      const budget = await setSpaceBudget({
        workspaceId: ctx.params.id, authorId: actor.userId, kind: ctx.body.kind, period: ctx.body.period, limitUsd, warnRatio,
      }, tx);
        await writeSpaceAudit(tx, {
        ...auditActor(actor),
        action: 'space_updated',
        workspaceId: ctx.params.id,
        resourceType: 'spend_budget',
        resourceId: budget?.id ?? ctx.params.id,
        details: { field: 'budget', kind: ctx.body.kind, period: ctx.body.period, newValue: limitUsd, ...(warnRatio !== undefined ? { warnRatio } : {}) },
      });
    });
    return { budgets: await spaceBudgetStatuses(ctx.params.id, actor.userId) };
  }), {
    params: t.Object({ id: t.String() }),
    body: t.Object({
      kind: t.Union([t.Literal('space'), t.Literal('space_member')]),
      period: t.Union([t.Literal('day'), t.Literal('month')]),
      limitUsd: t.Union([t.Number(), t.Null()]),
      warnRatio: t.Optional(t.Number()),
    }, { additionalProperties: false }),
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
  })

  // ── File leases ("Ben is editing", §7.5) ────────────────────────────
  // A member editing a space file holds its lease and renews it while the
  // editor is open; every member sees who holds what. Changes are also
  // pushed as `file.leases` to the space's gateway subscribers.

  .get('/:id/file-leases', (ctx) => handle(ctx, async (actor) => {
    await requireMember(actor, ctx.params.id, 'read');
    return { leases: await leaseViews(await listLeases(ctx.params.id)) };
  }), {
    params: t.Object({ id: t.String() }),
    detail: { tags: ['spaces'] },
  })

  // Take the lease, or renew it (`renew: true` refuses when it was lost).
  .post('/:id/file-leases', (ctx) => handle(ctx, async (actor) => {
    await requireMember(actor, ctx.params.id, 'write');
    const path = leasePath(ctx.body.path);
    const holder = { userId: actor.userId, kind: 'human' as const };
    if (ctx.body.renew) {
      const lease = await renewLease(ctx.params.id, path, holder);
      if (!lease) {
        ctx.set.status = 409;
        return { error: 'The lease expired and is held by someone else now', code: 'lease_lost' };
      }
      return { lease: (await leaseViews([lease]))[0] };
    }
    const result = await acquireLease(ctx.params.id, path, holder);
    if (!result.ok) {
      ctx.set.status = 409;
      return { error: `${path} is being edited by someone else`, code: 'lease_held', heldBy: await leaseViews(result.heldBy) };
    }
    return { lease: (await leaseViews([result.lease]))[0] };
  }), {
    params: t.Object({ id: t.String() }),
    body: t.Object({ path: t.String({ minLength: 1, maxLength: 4096 }), renew: t.Optional(t.Boolean()) }, { additionalProperties: false }),
    detail: { tags: ['spaces'] },
  })

  .delete('/:id/file-leases', (ctx) => handle(ctx, async (actor) => {
    await requireMember(actor, ctx.params.id, 'read');
    const released = await releaseLease(ctx.params.id, leasePath(ctx.query.path), { userId: actor.userId, kind: 'human' });
    return { released };
  }), {
    params: t.Object({ id: t.String() }),
    query: t.Object({ path: t.String({ minLength: 1, maxLength: 4096 }) }),
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
