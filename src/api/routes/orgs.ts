import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { getConfig } from '@/config';
import { getOrgWorkspaceManager, OrgWorkspaceError } from '@/security/orgs';
import { isAdmin, isAuthenticated, type Principal } from '@/security/principal';

/**
 * Organizations + workspaces — Phase 3g multi-user.
 *
 * Two surfaces, both gated on `multiuser.orgWorkspaces`:
 *
 *   /api/me/workspaces  — caller manages their own workspaces.
 *                         Authenticated users only.
 *   /api/admin/orgs     — system admin creates orgs and manages
 *                         membership. Admins only.
 *
 * When the flag is off, every endpoint returns 404 — callers cannot
 * tell whether the table is empty or whether the feature has been
 * shut off, which keeps fingerprinting at bay.
 *
 * Cross-tenant safety: `findOwnedById`/`findOwnedBySlug` return null
 * for both "doesn't exist" and "exists but belongs to someone else".
 * Routes surface that as 404 — same enumeration-collapse pattern as
 * Phase 1a/2a/3d.
 */

type RouteCtx = {
  set: { status?: number | string };
  user: { isAdmin?: boolean } | null;
  principal: Principal;
};

function requireFlag(ctx: RouteCtx): { ok: true } | { ok: false; body: { error: string } } {
  const cfg = getConfig();
  if (!cfg.multiuser?.orgWorkspaces) {
    ctx.set.status = 404;
    return { ok: false, body: { error: 'Not found' } };
  }
  return { ok: true };
}

function requireAuth(ctx: RouteCtx): { ok: true } | { ok: false; body: { error: string } } {
  if (!ctx.user || !isAuthenticated(ctx.principal)) {
    ctx.set.status = 401;
    return { ok: false, body: { error: 'Authentication required' } };
  }
  return { ok: true };
}

function requireAdminGuard(ctx: RouteCtx): { ok: true } | { ok: false; body: { error: string } } {
  const auth = requireAuth(ctx);
  if (!auth.ok) return auth;
  if (!isAdmin(ctx.principal)) {
    ctx.set.status = 403;
    return { ok: false, body: { error: 'Admin access required' } };
  }
  return { ok: true };
}

/**
 * Map an `OrgWorkspaceError` to an HTTP status. Validation errors
 * become 400; conflict errors become 409; not-found becomes 404.
 */
function errorStatus(err: OrgWorkspaceError): number {
  switch (err.code) {
    case 'invalid_slug':
    case 'invalid_name':
    case 'cannot_delete_default':
      return 400;
    case 'slug_conflict':
      return 409;
    case 'not_admin':
      return 403;
    case 'org_not_found':
    case 'user_not_found':
    case 'workspace_not_found':
      return 404;
    default:
      return 500;
  }
}

/** /api/me/workspaces — caller's own workspace CRUD. */
export const workspaceMeRoutes = new Elysia({ prefix: '/me/workspaces' })
  .use(apiContext)

  .get(
    '/',
    async (ctx) => {
      const flag = requireFlag(ctx);
      if (!flag.ok) return flag.body;
      const auth = requireAuth(ctx);
      if (!auth.ok) return auth.body;
      const mgr = getOrgWorkspaceManager();
      // Lazy create the default workspace on first access so the list
      // endpoint always returns at least one row even on a fresh user.
      await mgr.ensureDefaultWorkspace(ctx.principal.userId);
      const items = await mgr.listOwn(ctx.principal.userId);
      return { workspaces: items };
    },
    { detail: { tags: ['workspaces'] } },
  )

  .post(
    '/',
    async (ctx) => {
      const flag = requireFlag(ctx);
      if (!flag.ok) return flag.body;
      const auth = requireAuth(ctx);
      if (!auth.ok) return auth.body;
      try {
        const ws = await getOrgWorkspaceManager().createWorkspace(ctx.principal.userId, {
          slug: ctx.body.slug,
          name: ctx.body.name,
          isDefault: ctx.body.isDefault,
        });
        ctx.set.status = 201;
        return ws;
      } catch (err) {
        if (err instanceof OrgWorkspaceError) {
          ctx.set.status = errorStatus(err);
          return { error: err.message, code: err.code };
        }
        throw err;
      }
    },
    {
      body: t.Object({
        slug: t.String({ minLength: 1, maxLength: 32 }),
        name: t.String({ minLength: 1, maxLength: 120 }),
        isDefault: t.Optional(t.Boolean()),
      }),
      detail: { tags: ['workspaces'] },
    },
  )

  .patch(
    '/:id',
    async (ctx) => {
      const flag = requireFlag(ctx);
      if (!flag.ok) return flag.body;
      const auth = requireAuth(ctx);
      if (!auth.ok) return auth.body;
      try {
        const updated = await getOrgWorkspaceManager().rename(
          ctx.principal.userId,
          ctx.params.id,
          ctx.body.name,
        );
        if (!updated) {
          ctx.set.status = 404;
          return { error: 'Workspace not found' };
        }
        return updated;
      } catch (err) {
        if (err instanceof OrgWorkspaceError) {
          ctx.set.status = errorStatus(err);
          return { error: err.message, code: err.code };
        }
        throw err;
      }
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({ name: t.String({ minLength: 1, maxLength: 120 }) }),
      detail: { tags: ['workspaces'] },
    },
  )

  .post(
    '/:id/default',
    async (ctx) => {
      const flag = requireFlag(ctx);
      if (!flag.ok) return flag.body;
      const auth = requireAuth(ctx);
      if (!auth.ok) return auth.body;
      const updated = await getOrgWorkspaceManager().setDefault(ctx.principal.userId, ctx.params.id);
      if (!updated) {
        ctx.set.status = 404;
        return { error: 'Workspace not found' };
      }
      return updated;
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { tags: ['workspaces'] },
    },
  )

  .delete(
    '/:id',
    async (ctx) => {
      const flag = requireFlag(ctx);
      if (!flag.ok) return flag.body;
      const auth = requireAuth(ctx);
      if (!auth.ok) return auth.body;
      try {
        const ok = await getOrgWorkspaceManager().delete(ctx.principal.userId, ctx.params.id);
        if (!ok) {
          ctx.set.status = 404;
          return { error: 'Workspace not found' };
        }
        return { deleted: true };
      } catch (err) {
        if (err instanceof OrgWorkspaceError) {
          ctx.set.status = errorStatus(err);
          return { error: err.message, code: err.code };
        }
        throw err;
      }
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { tags: ['workspaces'] },
    },
  );

/** /api/admin/orgs — system-admin org management. */
export const orgAdminRoutes = new Elysia({ prefix: '/admin/orgs' })
  .use(apiContext)

  .get(
    '/',
    async (ctx) => {
      const flag = requireFlag(ctx);
      if (!flag.ok) return flag.body;
      const guard = requireAdminGuard(ctx);
      if (!guard.ok) return guard.body;
      const orgs = await getOrgWorkspaceManager().listAllAdmin({
        id: ctx.principal.userId,
        username: ctx.principal.username,
        isAdmin: ctx.principal.isAdmin,
      });
      return { orgs };
    },
    { detail: { tags: ['admin'] } },
  )

  .post(
    '/',
    async (ctx) => {
      const flag = requireFlag(ctx);
      if (!flag.ok) return flag.body;
      const guard = requireAdminGuard(ctx);
      if (!guard.ok) return guard.body;
      try {
        const org = await getOrgWorkspaceManager().createOrg(
          {
            id: ctx.principal.userId,
            username: ctx.principal.username,
            isAdmin: ctx.principal.isAdmin,
          },
          { slug: ctx.body.slug, name: ctx.body.name },
        );
        ctx.set.status = 201;
        return org;
      } catch (err) {
        if (err instanceof OrgWorkspaceError) {
          ctx.set.status = errorStatus(err);
          return { error: err.message, code: err.code };
        }
        throw err;
      }
    },
    {
      body: t.Object({
        slug: t.String({ minLength: 1, maxLength: 32 }),
        name: t.String({ minLength: 1, maxLength: 120 }),
      }),
      detail: { tags: ['admin'] },
    },
  )

  .get(
    '/:id/members',
    async (ctx) => {
      const flag = requireFlag(ctx);
      if (!flag.ok) return flag.body;
      const guard = requireAdminGuard(ctx);
      if (!guard.ok) return guard.body;
      const members = await getOrgWorkspaceManager().listMembers(
        {
          id: ctx.principal.userId,
          username: ctx.principal.username,
          isAdmin: ctx.principal.isAdmin,
        },
        ctx.params.id,
      );
      return { members };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { tags: ['admin'] },
    },
  )

  .post(
    '/:id/members',
    async (ctx) => {
      const flag = requireFlag(ctx);
      if (!flag.ok) return flag.body;
      const guard = requireAdminGuard(ctx);
      if (!guard.ok) return guard.body;
      try {
        const member = await getOrgWorkspaceManager().addMember(
          {
            id: ctx.principal.userId,
            username: ctx.principal.username,
            isAdmin: ctx.principal.isAdmin,
          },
          ctx.params.id,
          ctx.body.userId,
          ctx.body.role ?? 'member',
        );
        ctx.set.status = 201;
        return member;
      } catch (err) {
        if (err instanceof OrgWorkspaceError) {
          ctx.set.status = errorStatus(err);
          return { error: err.message, code: err.code };
        }
        throw err;
      }
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        userId: t.String(),
        role: t.Optional(t.Union([t.Literal('member'), t.Literal('org_admin')])),
      }),
      detail: { tags: ['admin'] },
    },
  )

  .delete(
    '/:id/members/:userId',
    async (ctx) => {
      const flag = requireFlag(ctx);
      if (!flag.ok) return flag.body;
      const guard = requireAdminGuard(ctx);
      if (!guard.ok) return guard.body;
      const ok = await getOrgWorkspaceManager().removeMember(
        {
          id: ctx.principal.userId,
          username: ctx.principal.username,
          isAdmin: ctx.principal.isAdmin,
        },
        ctx.params.id,
        ctx.params.userId,
      );
      if (!ok) {
        ctx.set.status = 404;
        return { error: 'Membership not found' };
      }
      return { removed: true };
    },
    {
      params: t.Object({ id: t.String(), userId: t.String() }),
      detail: { tags: ['admin'] },
    },
  );
