import { Elysia, t } from '@/api/http';
import { apiContext } from '@/api/context';
import { isAuthenticated } from '@/security/principal';

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
      }),
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
