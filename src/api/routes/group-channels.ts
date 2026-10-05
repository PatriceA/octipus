import { Elysia, t } from '@/api/http';
import { apiContext } from '@/api/context';
import { isAuthenticated, type Principal } from '@/security/principal';
import { SpaceError, spaceErrorStatus } from '@/security/space-access';

/** A bridge operation as the caller, `SpaceError` mapped to its status. */
async function bridge<T>(
  ctx: { principal: Principal; set: { status?: number | string } },
  run: (actor: { userId: string; impersonatedBy: string | null }) => Promise<T>,
): Promise<T | { error: string; code?: string }> {
  if (!isAuthenticated(ctx.principal)) {
    ctx.set.status = 401;
    return { error: 'Authentication required' };
  }
  const by = ctx.principal.actorUserId;
  try {
    return await run({ userId: ctx.principal.userId, impersonatedBy: by && by !== ctx.principal.userId ? by : null });
  } catch (err) {
    if (!(err instanceof SpaceError)) throw err;
    ctx.set.status = spaceErrorStatus(err);
    return { error: err.message, code: err.code };
  }
}

const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

/**
 * Group channels the caller enrolled (`@octipus join` in the channel).
 *
 * Mounted at `/api/me/group-channels`. Enrolment itself only happens from
 * inside the channel — that is what proves the owner is a member — so there
 * is no POST. Owners can set an enrolment's mode, quiet hours and rate limit,
 * and remove it; admins see and change all of them under
 * `/api/admin/group-channels`.
 * Other users' rows answer 404, the same as missing ones.
 *
 * `POST /:id/bind` binds the channel to a space the caller owns (coworking
 * §9.4) — with `acknowledged: true`, the owner's statement that everyone in
 * the channel can read what the room shows; `DELETE /:id/bind` unbinds it
 * (the channel's owner, or an owner of the space).
 */
export const groupChannelRoutes = new Elysia({ prefix: '/me/group-channels' })
  .use(apiContext)

  .get(
    '/',
    async ({ user, principal, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Authentication required' };
      }
      const { listGroupChannelsForOwner } = await import('@/channels/group-channels');
      return { groupChannels: await listGroupChannelsForOwner(principal.userId) };
    },
    { detail: { tags: ['channels'] } },
  )

  .patch(
    '/:id',
    async ({ user, principal, params, body, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Authentication required' };
      }
      const { GroupChannelSettingsError, updateGroupChannelSettings } = await import('@/channels/group-channels');
      try {
        // Owner-only here, even for admins: the admin route is the audited override.
        const updated = await updateGroupChannelSettings(params.id, { userId: principal.userId, isAdmin: false }, body);
        if (!updated) {
          set.status = 404;
          return { error: 'Group channel not found' };
        }
        return { groupChannel: updated };
      } catch (err) {
        if (!(err instanceof GroupChannelSettingsError)) throw err;
        set.status = 400;
        return { error: err.message };
      }
    },
    {
      params: t.Object({ id: t.String({ pattern: UUID_PATTERN }) }),
      body: t.Object({
        mode: t.Optional(t.Union([t.Literal('mention'), t.Literal('listen'), t.Literal('proactive')])),
        quietHoursStart: t.Optional(t.Union([t.Integer({ minimum: 0, maximum: 23 }), t.Null()])),
        quietHoursEnd: t.Optional(t.Union([t.Integer({ minimum: 0, maximum: 23 }), t.Null()])),
        timezone: t.Optional(t.String({ minLength: 1, maxLength: 64 })),
        maxUnpromptedPerDay: t.Optional(t.Integer({ minimum: 1, maximum: 48 })),
        minMinutesBetween: t.Optional(t.Integer({ minimum: 10, maximum: 1440 })),
      }, { additionalProperties: false }),
      detail: { tags: ['channels'] },
    },
  )

  .post(
    '/:id/bind',
    (ctx) => bridge(ctx, async (actor) => {
      const { bindGroupChannel } = await import('@/channels/group-bridge');
      return { groupChannel: await bindGroupChannel(actor, ctx.params.id, ctx.body) };
    }),
    {
      params: t.Object({ id: t.String({ pattern: UUID_PATTERN }) }),
      body: t.Object({
        workspaceId: t.String({ pattern: UUID_PATTERN }),
        acknowledged: t.Boolean(),
        roomId: t.Optional(t.String({ pattern: UUID_PATTERN })),
      }, { additionalProperties: false }),
      detail: { tags: ['channels'] },
    },
  )

  .delete(
    '/:id/bind',
    (ctx) => bridge(ctx, async (actor) => {
      const { unbindGroupChannel } = await import('@/channels/group-bridge');
      return { groupChannel: await unbindGroupChannel(actor, ctx.params.id) };
    }),
    {
      params: t.Object({ id: t.String({ pattern: UUID_PATTERN }) }),
      detail: { tags: ['channels'] },
    },
  )

  .delete(
    '/:id',
    async ({ user, principal, params, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Authentication required' };
      }
      const { removeGroupChannel } = await import('@/channels/group-channels');
      // Owner-only here, even for admins: the admin route is the audited override.
      const removed = await removeGroupChannel(params.id, { userId: principal.userId, isAdmin: false });
      if (!removed) {
        set.status = 404;
        return { error: 'Group channel not found' };
      }
      return { deleted: true };
    },
    {
      params: t.Object({ id: t.String({ pattern: UUID_PATTERN }) }),
      detail: { tags: ['channels'] },
    },
  );
