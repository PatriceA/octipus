import { Elysia, t } from '@/api/http';
import { apiContext } from '@/api/context';
import { EXTERNAL_CHANNEL_TYPES, EXTERNAL_CHANNELS } from '@/channels/ownership';
import { auditRepository } from '@/db/repositories/audit-repository';
import { userRepository } from '@/db/repositories/user-repository';
import { recordedClientIp } from '@/security/client-ip';
import { isAdmin, isAuthenticated } from '@/security/principal';
import { forgetInstallAccess } from '@/models/install-access';
import { onUserChanged, setUserActive } from '@/security/user-lifecycle';
import { hashPassword } from '@/utils/crypto';
import { assertLocalUsername, InvalidUsernameError } from '@/security/user-kinds';

/**
 * Admin console — Phase 2c multi-user.
 *
 * Surfaces user management and the audit log under `/api/admin/*`.
 * Every endpoint requires `principal.isAdmin === true`; non-admin
 * callers get `403`. Anonymous callers get the standard `401` from
 * the auth guard.
 *
 * Scope intentionally limited to what's actionable today:
 *   - User CRUD (list, create, set-active, set-admin)
 *   - Audit log viewer (list with filters)
 *
 * Out of scope for this slice (follow-up commits):
 *   - Impersonation (start/stop with banner) — needs careful auth
 *     plumbing through the gateway.
 *   - Quotas dashboard — we don't have per-user quotas instrumented
 *     yet; would render an empty page.
 *   - Password reset flow — needs an email/secondary-channel design.
 */

// Elysia's `set` type widens `status` to a union of code-or-name —
// we just use plain numbers, so the helper takes the loosest shape.
type AdminCtx = {
  set: { status?: number | string };
  user: { isAdmin?: boolean } | null;
  principal: import('@/security/principal').Principal;
};

function requireAdmin(ctx: AdminCtx): { ok: true } | { ok: false; body: { error: string } } {
  if (!ctx.user || !isAuthenticated(ctx.principal)) {
    ctx.set.status = 401;
    return { ok: false, body: { error: 'Authentication required' } };
  }
  if (!isAdmin(ctx.principal)) {
    ctx.set.status = 403;
    return { ok: false, body: { error: 'Admin access required' } };
  }
  return { ok: true };
}

/** Strip sensitive fields so the JSON response never exposes them. */
function publicUser(u: import('@/db/schema/users').User) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    isAdmin: u.isAdmin,
    isActive: u.isActive,
    installModels: u.installModels,
    totpEnabled: u.totpEnabled,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
    lastLoginAt: u.lastLoginAt,
  };
}


const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

export const adminRoutes = new Elysia({ prefix: '/admin' })
  .use(apiContext)

  // ── Users ──────────────────────────────────────────────────────
  .get(
    '/users',
    async (ctx) => {
      const guard = requireAdmin(ctx);
      if (!guard.ok) return guard.body;
      // The install's own accounts: remote members (S7) are not listed.
      const users = await userRepository.listLocal();
      return { users: users.map(publicUser) };
    },
    { detail: { tags: ['admin'] } },
  )

  .post(
    '/users',
    async (ctx) => {
      const guard = requireAdmin(ctx);
      if (!guard.ok) return guard.body;

      const { body, principal, set } = ctx;
      try {
        assertLocalUsername(body.username);
      } catch (err) {
        if (!(err instanceof InvalidUsernameError)) throw err;
        set.status = 400;
        return { error: err.message };
      }
      const passwordHash = body.password ? await hashPassword(body.password) : null;

      const user = await userRepository.create({
        username: body.username,
        email: body.email ?? null,
        passwordHash,
        isAdmin: body.isAdmin ?? false,
        isActive: body.isActive ?? true,
        deactivatedBy: body.isActive === false ? 'admin' : null,
        installModels: body.installModels ?? true,
      });

      await auditRepository.log({
        userId: principal.userId,
        action: 'user_created',
        resourceType: 'user',
        resourceId: user.id,
        details: { username: user.username, isAdmin: user.isAdmin, byAdmin: principal.userId },
      });

      return publicUser(user);
    },
    {
      body: t.Object({
        username: t.String({ minLength: 1, maxLength: 64 }),
        email: t.Optional(t.String()),
        password: t.Optional(t.String({ minLength: 8 })),
        isAdmin: t.Optional(t.Boolean()),
        isActive: t.Optional(t.Boolean()),
        installModels: t.Optional(t.Boolean()),
      }),
      detail: { tags: ['admin'] },
    },
  )

  .patch(
    '/users/:id',
    async (ctx) => {
      const guard = requireAdmin(ctx);
      if (!guard.ok) return guard.body;

      const { params, body, principal, set } = ctx;

      // Prevent an admin from accidentally locking themselves out by
      // demoting the only remaining admin or disabling themselves.
      if (params.id === principal.userId && (body.isAdmin === false || body.isActive === false)) {
        set.status = 400;
        return { error: 'You cannot demote or disable yourself. Use a different admin account.' };
      }

      const before = await userRepository.findById(params.id);
      // A remote member (S7) is not one of the install's accounts to edit.
      if (!before || before.kind === 'remote') {
        set.status = 404;
        return { error: 'User not found' };
      }

      const updates: Record<string, unknown> = {};
      if (body.email !== undefined) updates.email = body.email;
      if (body.isAdmin !== undefined) updates.isAdmin = body.isAdmin;
      if (body.installModels !== undefined) updates.installModels = body.installModels;
      if (body.password) updates.passwordHash = await hashPassword(body.password);

      // `is_active` has one writer, which also ends the account's sessions,
      // sockets, agents and pending prompts on deactivation. A consequence
      // that failed does not drop the rest of the edit: it is reported back.
      const warnings: string[] = [];
      if (body.isActive !== undefined) {
        const outcome = await setUserActive(params.id, body.isActive, principal.userId, 'admin');
        if (outcome.status === 'not_found') {
          set.status = 404;
          return { error: 'User not found' };
        }
        if (outcome.status === 'changed') {
          for (const step of outcome.failedSteps) warnings.push(`Deactivation step failed: ${step}`);
        }
      }

      const updated = Object.keys(updates).length > 0
        ? await userRepository.update(params.id, updates as Partial<import('@/db/schema/users').NewUser>)
        : await userRepository.findById(params.id);
      if (!updated) {
        set.status = 404;
        return { error: 'User not found' };
      }
      // Admin rights are fixed on a gateway connection at auth: reconnect it.
      if (body.isAdmin !== undefined && body.isAdmin !== before.isAdmin) await onUserChanged(params.id);
      // Who may run on the install's models is cached for a few seconds.
      if (body.isAdmin !== undefined || body.installModels !== undefined) forgetInstallAccess(params.id);

      await auditRepository.log({
        userId: principal.userId,
        action: 'user_updated',
        resourceType: 'user',
        resourceId: updated.id,
        details: {
          changes: [...Object.keys(updates), ...(body.isActive !== undefined ? ['isActive'] : [])],
          targetUser: updated.username,
          byAdmin: principal.userId,
          ...(warnings.length > 0 ? { warnings } : {}),
        },
      });

      return warnings.length > 0 ? { ...publicUser(updated), warnings } : publicUser(updated);
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        email: t.Optional(t.String()),
        password: t.Optional(t.String({ minLength: 8 })),
        isAdmin: t.Optional(t.Boolean()),
        isActive: t.Optional(t.Boolean()),
        installModels: t.Optional(t.Boolean()),
      }),
      detail: { tags: ['admin'] },
    },
  )

  // ── Quotas (Phase 3c-1) ────────────────────────────────────────
  // GET    /quotas         — list users with their effective quota +
  //                          current usage. Cheap O(N) over users
  //                          since the admin console is the only
  //                          caller and N is small.
  // GET    /quotas/:userId — single-user detail.
  // PATCH  /quotas/:userId — set/clear per-field overrides; pass
  //                          null to clear, omit to leave unchanged.
  // DELETE /quotas/:userId — drop the override row entirely (every
  //                          field reverts to the global default).
  //
  // These routes don't enforce anything — Phase 3c-2 wires the gates
  // into the agent worker and rate-limiter. This commit ships the
  // visibility + management surface so operators can act before
  // enforcement lands.
  .get(
    '/quotas',
    async (ctx) => {
      const guard = requireAdmin(ctx);
      if (!guard.ok) return guard.body;

      const { userRepository } = await import('@/db/repositories/user-repository');
      const { getQuotaManager } = await import('@/security/quotas');
      const mgr = getQuotaManager();
      const users = await userRepository.listLocal();

      const rows = await Promise.all(users.map(async (u) => {
        const [quota, usage] = await Promise.all([
          mgr.getEffectiveQuota(u.id),
          mgr.getUsage(u.id),
        ]);
        return {
          userId: u.id,
          username: u.username,
          isAdmin: u.isAdmin,
          isActive: u.isActive,
          quota,
          usage,
        };
      }));
      return { quotas: rows };
    },
    { detail: { tags: ['admin'] } },
  )

  .get(
    '/quotas/:userId',
    async (ctx) => {
      const guard = requireAdmin(ctx);
      if (!guard.ok) return guard.body;
      const { params, set } = ctx;

      const { userRepository } = await import('@/db/repositories/user-repository');
      const user = await userRepository.findById(params.userId);
      if (!user) {
        set.status = 404;
        return { error: 'User not found' };
      }
      const { getQuotaManager } = await import('@/security/quotas');
      const mgr = getQuotaManager();
      const [quota, usage] = await Promise.all([
        mgr.getEffectiveQuota(user.id),
        mgr.getUsage(user.id),
      ]);
      return {
        userId: user.id,
        username: user.username,
        isAdmin: user.isAdmin,
        isActive: user.isActive,
        quota,
        usage,
      };
    },
    {
      params: t.Object({ userId: t.String() }),
      detail: { tags: ['admin'] },
    },
  )

  .patch(
    '/quotas/:userId',
    async (ctx) => {
      const guard = requireAdmin(ctx);
      if (!guard.ok) return guard.body;
      const { params, body, principal, set } = ctx;

      const { userRepository } = await import('@/db/repositories/user-repository');
      const user = await userRepository.findById(params.userId);
      if (!user) {
        set.status = 404;
        return { error: 'User not found' };
      }

      // Reject negative or zero values: a "quota" of 0 would lock
      // the user out entirely; clearer to require an explicit null
      // or DELETE for "no override" semantics.
      for (const k of ['maxConcurrentAgents', 'maxTokensPerDay', 'maxApiCallsPerMinute'] as const) {
        const v = (body as Record<string, unknown>)[k];
        if (v !== undefined && v !== null && (typeof v !== 'number' || v < 1 || !Number.isInteger(v))) {
          set.status = 400;
          return { error: `${k} must be a positive integer or null` };
        }
      }

      const { getQuotaManager } = await import('@/security/quotas');
      const updated = await getQuotaManager().setOverride(user.id, body);

      await auditRepository.log({
        userId: principal.userId,
        action: 'settings_changed',
        resourceType: 'user_quota',
        resourceId: user.id,
        details: { changes: Object.keys(body), targetUser: user.username, byAdmin: principal.userId },
      });

      return updated;
    },
    {
      params: t.Object({ userId: t.String() }),
      body: t.Object({
        maxConcurrentAgents: t.Optional(t.Union([t.Number(), t.Null()])),
        maxTokensPerDay: t.Optional(t.Union([t.Number(), t.Null()])),
        maxApiCallsPerMinute: t.Optional(t.Union([t.Number(), t.Null()])),
      }),
      detail: { tags: ['admin'] },
    },
  )

  .delete(
    '/quotas/:userId',
    async (ctx) => {
      const guard = requireAdmin(ctx);
      if (!guard.ok) return guard.body;
      const { params, principal, set } = ctx;

      const { getQuotaManager } = await import('@/security/quotas');
      const cleared = await getQuotaManager().clearOverride(params.userId);
      if (!cleared) {
        set.status = 404;
        return { error: 'No quota override for this user' };
      }
      await auditRepository.log({
        userId: principal.userId,
        action: 'settings_changed',
        resourceType: 'user_quota',
        resourceId: params.userId,
        details: { cleared: true, byAdmin: principal.userId },
      });
      return { cleared: true };
    },
    {
      params: t.Object({ userId: t.String() }),
      detail: { tags: ['admin'] },
    },
  )

  // ── Spend budgets (USD caps) ───────────────────────────────────
  // GET    /spend-budgets             — list (optionally ?userId=).
  // PUT    /spend-budgets             — upsert by (user, scope, period);
  //                                     clears any warning / pause. A
  //                                     group_channel budget (scopeRef = the
  //                                     enrolment id) is filed under the
  //                                     channel's owner, one per period.
  // DELETE /spend-budgets/:id         — drop a budget.
  // POST   /spend-budgets/:id/resume  — clear the pause.
  // Enforcement: src/security/spend-budgets.ts (checkSpend).
  // scopeRef: role name (trimmed) or workspace id (UUID, lowercased). A
  // workspace budget attributes spend via the agent's workspace, falling back
  // to the session's; cost rows with neither count toward user budgets only.
  .get(
    '/spend-budgets',
    async (ctx) => {
      const guard = requireAdmin(ctx);
      if (!guard.ok) return guard.body;
      const { listBudgets, budgetStatusesFor } = await import('@/security/spend-budgets');
      const userId = ctx.query.userId;
      // With a user, also return each budget's current-period spend and
      // state — the same view that user sees at /api/spend-budgets/me.
      // `budgets` stays the raw rows (the endpoint's existing contract);
      // `statuses` is derived from the same rows, not a second read.
      if (userId) {
        const budgets = await listBudgets(userId);
        return { budgets, statuses: await budgetStatusesFor(userId, new Date(), budgets) };
      }
      return { budgets: await listBudgets() };
    },
    {
      query: t.Object({ userId: t.Optional(t.String({ pattern: UUID_PATTERN })) }),
      detail: { tags: ['admin'] },
    },
  )

  // Workspaces a user owns — the scope picker for a workspace budget.
  .get(
    '/users/:id/workspaces',
    async (ctx) => {
      const guard = requireAdmin(ctx);
      if (!guard.ok) return guard.body;
      const { getOrgWorkspaceManager } = await import('@/security/orgs');
      const items = await getOrgWorkspaceManager().listOwn(ctx.params.id);
      return { workspaces: items.map(w => ({ id: w.id, name: w.name, slug: w.slug, isDefault: w.isDefault })) };
    },
    {
      params: t.Object({ id: t.String({ pattern: UUID_PATTERN }) }),
      detail: { tags: ['admin'] },
    },
  )

  .put(
    '/spend-budgets',
    async (ctx) => {
      const guard = requireAdmin(ctx);
      if (!guard.ok) return guard.body;
      const { body: input, principal, set } = ctx;

      // A group channel's budget is filed under the channel's current owner,
      // whatever user the request names.
      let body = input;
      if (input.scopeKind === 'group_channel') {
        const { findGroupChannelById } = await import('@/channels/group-channels');
        const group = await findGroupChannelById(input.scopeRef?.trim() ?? '');
        if (!group) {
          set.status = 404;
          return { error: 'Group channel not found' };
        }
        body = { ...input, userId: group.ownerUserId, scopeRef: group.id };
      }

      const user = await userRepository.findById(body.userId);
      if (!user) {
        set.status = 404;
        return { error: 'User not found' };
      }
      if (!(body.limitUsd > 0)) {
        set.status = 400;
        return { error: 'limitUsd must be a positive number' };
      }
      if (body.warnRatio !== undefined && !(body.warnRatio > 0 && body.warnRatio <= 1)) {
        set.status = 400;
        return { error: 'warnRatio must be in (0, 1]' };
      }
      if (body.scopeKind !== 'user' && !body.scopeRef?.trim()) {
        set.status = 400;
        return { error: `scopeRef is required for a ${body.scopeKind} budget` };
      }
      if (body.scopeKind === 'workspace' && !new RegExp(UUID_PATTERN).test(body.scopeRef?.trim() ?? '')) {
        set.status = 400;
        return { error: 'scopeRef must be a workspace id (UUID) for a workspace budget' };
      }

      const { upsertBudget } = await import('@/security/spend-budgets');
      const budget = await upsertBudget(body);
      await auditRepository.log({
        userId: principal.userId,
        action: 'settings_changed',
        resourceType: 'spend_budget',
        resourceId: budget.id,
        details: { ...body, targetUser: user.username, byAdmin: principal.userId },
      });
      return budget;
    },
    {
      body: t.Object({
        userId: t.String({ pattern: UUID_PATTERN }),
        scopeKind: t.Union([t.Literal('user'), t.Literal('role'), t.Literal('workspace'), t.Literal('group_channel')]),
        scopeRef: t.Optional(t.Union([t.String({ minLength: 1 }), t.Null()])),
        period: t.Union([t.Literal('day'), t.Literal('month')]),
        limitUsd: t.Number(),
        warnRatio: t.Optional(t.Number()),
      }),
      detail: { tags: ['admin'] },
    },
  )

  .delete(
    '/spend-budgets/:id',
    async (ctx) => {
      const guard = requireAdmin(ctx);
      if (!guard.ok) return guard.body;
      const { params, principal, set } = ctx;

      const { deleteBudget } = await import('@/security/spend-budgets');
      if (!(await deleteBudget(params.id))) {
        set.status = 404;
        return { error: 'Spend budget not found' };
      }
      await auditRepository.log({
        userId: principal.userId,
        action: 'settings_changed',
        resourceType: 'spend_budget',
        resourceId: params.id,
        details: { deleted: true, byAdmin: principal.userId },
      });
      return { deleted: true };
    },
    {
      params: t.Object({ id: t.String({ pattern: UUID_PATTERN }) }),
      detail: { tags: ['admin'] },
    },
  )

  .post(
    '/spend-budgets/:id/resume',
    async (ctx) => {
      const guard = requireAdmin(ctx);
      if (!guard.ok) return guard.body;
      const { params, principal, set } = ctx;

      const { resetPause } = await import('@/security/spend-budgets');
      const budget = await resetPause(params.id);
      if (!budget) {
        set.status = 404;
        return { error: 'Spend budget not found' };
      }
      await auditRepository.log({
        userId: principal.userId,
        action: 'settings_changed',
        resourceType: 'spend_budget',
        resourceId: params.id,
        details: { resumed: true, byAdmin: principal.userId },
      });
      return budget;
    },
    {
      params: t.Object({ id: t.String({ pattern: UUID_PATTERN }) }),
      detail: { tags: ['admin'] },
    },
  )

  // ── Notification destinations ─────────────────────────────────
  // Shared chats (a Slack #alerts channel, a Telegram group) that hooks,
  // notifications, monitors and unattended agents may message besides the
  // owner's own linked chats. orgId null = every user; otherwise that org's
  // members. Enforcement: src/channels/ownership.ts.
  // GET    /notification-destinations
  // POST   /notification-destinations      { channelType, channelId, label?, orgId? }
  // DELETE /notification-destinations/:id
  // ── Group channels (docs/plans/group-chat-bot.md) ────────────────────
  // GET    /group-channels       every enrolment, with owner and workspace
  // PATCH  /group-channels/:id   mode, quiet hours, rate limit (audited)
  // DELETE /group-channels/:id   revoke one (audited; the bot goes quiet there)
  .get(
    '/group-channels',
    async (ctx) => {
      const guard = requireAdmin(ctx);
      if (!guard.ok) return guard.body;
      const { listAllGroupChannels } = await import('@/channels/group-channels');
      const { groupChannelBudgetStatuses } = await import('@/security/spend-budgets');
      const groups = await listAllGroupChannels();
      // Each channel's spend budget, with this period's spend (Admin → Group channels).
      const now = new Date();
      return {
        groupChannels: await Promise.all(groups.map(async (g) => ({ ...g, budgets: await groupChannelBudgetStatuses(g.id, now) }))),
      };
    },
    { detail: { tags: ['admin'] } },
  )

  .patch(
    '/group-channels/:id',
    async (ctx) => {
      const guard = requireAdmin(ctx);
      if (!guard.ok) return guard.body;
      const { params, principal, body, set } = ctx;
      const { GroupChannelSettingsError, updateGroupChannelSettings } = await import('@/channels/group-channels');
      try {
        const updated = await updateGroupChannelSettings(params.id, { userId: principal.userId, isAdmin: true }, body);
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
      detail: { tags: ['admin'] },
    },
  )

  .delete(
    '/group-channels/:id',
    async (ctx) => {
      const guard = requireAdmin(ctx);
      if (!guard.ok) return guard.body;
      const { params, principal, set } = ctx;
      const { removeGroupChannel } = await import('@/channels/group-channels');
      const removed = await removeGroupChannel(params.id, { userId: principal.userId, isAdmin: true });
      if (!removed) {
        set.status = 404;
        return { error: 'Group channel not found' };
      }
      return { deleted: true };
    },
    {
      params: t.Object({ id: t.String({ pattern: UUID_PATTERN }) }),
      detail: { tags: ['admin'] },
    },
  )

  .get(
    '/notification-destinations',
    async (ctx) => {
      const guard = requireAdmin(ctx);
      if (!guard.ok) return guard.body;
      const { listDestinations } = await import('@/channels/notification-destinations');
      return { destinations: await listDestinations(), channelTypes: EXTERNAL_CHANNEL_TYPES };
    },
    { detail: { tags: ['admin'] } },
  )

  .post(
    '/notification-destinations',
    async (ctx) => {
      const guard = requireAdmin(ctx);
      if (!guard.ok) return guard.body;
      const { body, principal, set } = ctx;
      const channelType = body.channelType.trim().toLowerCase();
      const channelId = body.channelId.trim();
      if (!EXTERNAL_CHANNELS.has(channelType)) {
        set.status = 400;
        return { error: `channelType must be one of ${EXTERNAL_CHANNEL_TYPES.join(', ')}` };
      }
      if (!channelId) {
        set.status = 400;
        return { error: 'channelId is required' };
      }
      const { addDestination } = await import('@/channels/notification-destinations');
      const result = await addDestination({
        channelType,
        channelId,
        label: body.label?.trim() || null,
        orgId: body.orgId ?? null,
        createdBy: principal.userId,
      });
      if ('unknownOrg' in result) {
        set.status = 404;
        return { error: 'Organization not found' };
      }
      if ('conflict' in result) {
        set.status = 409;
        return { error: 'This destination is already approved' };
      }
      await auditRepository.log({
        userId: principal.userId,
        action: 'settings_changed',
        resourceType: 'notification_destination',
        resourceId: result.destination.id,
        details: { channelType, channelId, orgId: body.orgId ?? null, label: body.label ?? null, byAdmin: principal.userId },
      });
      set.status = 201;
      return result.destination;
    },
    {
      body: t.Object({
        channelType: t.String({ minLength: 1, maxLength: 32 }),
        channelId: t.String({ minLength: 1, maxLength: 512 }),
        label: t.Optional(t.Union([t.String({ maxLength: 200 }), t.Null()])),
        orgId: t.Optional(t.Union([t.String({ pattern: UUID_PATTERN }), t.Null()])),
      }),
      detail: { tags: ['admin'] },
    },
  )

  .delete(
    '/notification-destinations/:id',
    async (ctx) => {
      const guard = requireAdmin(ctx);
      if (!guard.ok) return guard.body;
      const { params, principal, set } = ctx;
      const { removeDestination } = await import('@/channels/notification-destinations');
      const removed = await removeDestination(params.id);
      if (!removed) {
        set.status = 404;
        return { error: 'Notification destination not found' };
      }
      await auditRepository.log({
        userId: principal.userId,
        action: 'settings_changed',
        resourceType: 'notification_destination',
        resourceId: params.id,
        details: { deleted: true, channelType: removed.channelType, channelId: removed.channelId, orgId: removed.orgId, byAdmin: principal.userId },
      });
      return { deleted: true };
    },
    {
      params: t.Object({ id: t.String({ pattern: UUID_PATTERN }) }),
      detail: { tags: ['admin'] },
    },
  )

  // ── Impersonation (Phase 3d) ───────────────────────────────────
  // POST   /impersonate/:userId  — start an "act as <user>" session
  //                                bound to the admin's session token.
  //                                Idempotent on re-issue: the prior
  //                                session is closed (ended_reason='replaced').
  // POST   /impersonate/stop     — end the active session for the
  //                                calling admin's token.
  // GET    /impersonate          — list recent sessions (audit view).
  //
  // Strong audit: start writes paired audit_log rows under both
  // actor + target. Every state-changing request during the window
  // is dual-tagged by the audit-shadow middleware.
  //
  // Important: the admin's session token (`session.token`) IS the
  // lookup key — when the auth-derive middleware sees a request
  // whose token matches an active impersonation row, it swaps the
  // request's identity to the target user. The token itself isn't
  // re-issued; the existing one just routes differently while the
  // window is open.
  .post(
    '/impersonate/:userId',
    async (ctx) => {
      const guard = requireAdmin(ctx);
      if (!guard.ok) return guard.body;
      const { params, body, session, request, set, socketAddress } = ctx as any;

      if (!session?.token) {
        set.status = 400;
        return { error: 'Impersonation requires a real session token (no MASTER_KEY fallback)' };
      }

      const { getImpersonationManager } = await import('@/security/impersonation');
      const ipAddress = recordedClientIp(request, socketAddress);

      const result = await getImpersonationManager().start(
        { id: ctx.principal.userId, username: ctx.principal.username, isAdmin: true },
        params.userId,
        session.token,
        { reason: body?.reason, ipAddress },
      );
      if (!result.ok) {
        switch (result.reason) {
          case 'self':            set.status = 400; return { error: 'Cannot impersonate yourself' };
          case 'target_not_found': set.status = 404; return { error: 'Target user not found' };
          case 'target_inactive':  set.status = 400; return { error: 'Target user is disabled' };
          case 'target_remote':    set.status = 400; return { error: 'Members from other installs cannot be impersonated' };
          default:                  set.status = 400; return { error: result.reason };
        }
      }
      return {
        sessionId: result.session.id,
        targetUserId: result.target.id,
        targetUsername: result.target.username,
        expiresAt: result.session.expiresAt,
      };
    },
    {
      params: t.Object({ userId: t.String() }),
      body: t.Optional(t.Object({ reason: t.Optional(t.String({ maxLength: 500 })) })),
      detail: { tags: ['admin'] },
    },
  )

  .post(
    '/impersonate/stop',
    async (ctx) => {
      // The caller here is the admin acting as themselves OR the
      // target while still inside the impersonation window — both
      // share the same session token, so either can stop. Audit
      // records the actor regardless.
      if (!ctx.user || !isAuthenticated(ctx.principal)) {
        ctx.set.status = 401;
        return { error: 'Authentication required' };
      }
      const session = (ctx as any).session;
      if (!session?.token) {
        ctx.set.status = 400;
        return { error: 'No active session token' };
      }
      const { getImpersonationManager } = await import('@/security/impersonation');
      const stopped = await getImpersonationManager().stop(session.token, 'explicit');
      if (!stopped) {
        ctx.set.status = 404;
        return { error: 'No active impersonation session' };
      }
      return { stopped: true, sessionId: stopped.id };
    },
    { detail: { tags: ['admin'] } },
  )

  .get(
    '/impersonate',
    async (ctx) => {
      const guard = requireAdmin(ctx);
      if (!guard.ok) return guard.body;
      const limit = Math.min(parseInt((ctx as any).query?.limit ?? '50', 10) || 50, 200);
      const { getImpersonationManager } = await import('@/security/impersonation');
      const sessions = await getImpersonationManager().listRecent(limit);
      return { sessions };
    },
    {
      query: t.Object({ limit: t.Optional(t.String()) }),
      detail: { tags: ['admin'] },
    },
  )

  // ── Audit log ──────────────────────────────────────────────────
  .get(
    '/audit',
    async (ctx) => {
      const guard = requireAdmin(ctx);
      if (!guard.ok) return guard.body;

      const { query } = ctx;
      const limit = Math.min(parseInt(query.limit || '100', 10) || 100, 1000);

      let entries;
      if (query.userId) {
        entries = await auditRepository.findByUser(query.userId, limit);
      } else if (query.action) {
        entries = await auditRepository.findByAction(query.action, limit);
      } else {
        entries = await auditRepository.listRecent(limit);
      }
      return { entries };
    },
    {
      query: t.Object({
        limit: t.Optional(t.String()),
        userId: t.Optional(t.String()),
        action: t.Optional(t.String()),
      }),
      detail: { tags: ['admin'] },
    },
  );
