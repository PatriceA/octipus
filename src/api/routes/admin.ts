import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { auditRepository } from '@/db/repositories/audit-repository';
import { userRepository } from '@/db/repositories/user-repository';
import { isAdmin, isAuthenticated } from '@/security/principal';
import { hashPassword } from '@/utils/crypto';

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
    totpEnabled: u.totpEnabled,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
    lastLoginAt: u.lastLoginAt,
  };
}

export const adminRoutes = new Elysia({ prefix: '/admin' })
  .use(apiContext)

  // ── Users ──────────────────────────────────────────────────────
  .get(
    '/users',
    async (ctx) => {
      const guard = requireAdmin(ctx);
      if (!guard.ok) return guard.body;
      const users = await userRepository.listAll();
      return { users: users.map(publicUser) };
    },
    { detail: { tags: ['admin'] } },
  )

  .post(
    '/users',
    async (ctx) => {
      const guard = requireAdmin(ctx);
      if (!guard.ok) return guard.body;

      const { body, principal } = ctx;
      const passwordHash = body.password ? await hashPassword(body.password) : null;

      const user = await userRepository.create({
        username: body.username,
        email: body.email ?? null,
        passwordHash,
        isAdmin: body.isAdmin ?? false,
        isActive: body.isActive ?? true,
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

      const updates: Record<string, unknown> = {};
      if (body.email !== undefined) updates.email = body.email;
      if (body.isAdmin !== undefined) updates.isAdmin = body.isAdmin;
      if (body.isActive !== undefined) updates.isActive = body.isActive;
      if (body.password) updates.passwordHash = await hashPassword(body.password);

      const updated = await userRepository.update(params.id, updates as Partial<import('@/db/schema/users').NewUser>);
      if (!updated) {
        set.status = 404;
        return { error: 'User not found' };
      }

      await auditRepository.log({
        userId: principal.userId,
        action: 'user_updated',
        resourceType: 'user',
        resourceId: updated.id,
        details: {
          changes: Object.keys(updates),
          targetUser: updated.username,
          byAdmin: principal.userId,
        },
      });

      return publicUser(updated);
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        email: t.Optional(t.String()),
        password: t.Optional(t.String({ minLength: 8 })),
        isAdmin: t.Optional(t.Boolean()),
        isActive: t.Optional(t.Boolean()),
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
      const users = await userRepository.listAll();

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
      const { params, body, session, request, set } = ctx as any;

      if (!session?.token) {
        set.status = 400;
        return { error: 'Impersonation requires a real session token (no MASTER_KEY fallback)' };
      }

      const { getImpersonationManager } = await import('@/security/impersonation');
      const ipAddress =
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
        request.headers.get('x-real-ip') ||
        undefined;

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
