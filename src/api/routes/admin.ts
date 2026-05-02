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
