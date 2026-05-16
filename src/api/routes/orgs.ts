import { and, eq, gte, sql } from 'drizzle-orm';
import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { getConfig } from '@/config';
import { getDb } from '@/db/postgres';
import { costLog, modelConfig } from '@/db/schema/models';
import { orgMembers } from '@/db/schema/organizations';
import { orgSsoConfig } from '@/db/schema/org-sso';
import { skills } from '@/db/schema/skills';
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
    case 'cannot_transfer_to_self':
      return 400;
    case 'slug_conflict':
      return 409;
    case 'not_admin':
      return 403;
    case 'org_not_found':
    case 'user_not_found':
    case 'workspace_not_found':
    case 'recipient_not_found':
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
      // List is available regardless of the `orgWorkspaces` flag — every
      // real user always has a default workspace (artifacts and other
      // workspace-scoped features need one). The flag only gates
      // creating / renaming / deleting additional workspaces below.
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
  )

  /**
   * Transfer workspace ownership to another user. The caller must
   * own the workspace; the recipient must exist and be active.
   * Sessions, documents, hooks, and workspace-scoped vault entries
   * follow the workspace to the new owner. See
   * `OrgWorkspaceManager.transfer` for the full data-movement
   * contract.
   */
  .post(
    '/:id/transfer',
    async (ctx) => {
      const flag = requireFlag(ctx);
      if (!flag.ok) return flag.body;
      const auth = requireAuth(ctx);
      if (!auth.ok) return auth.body;
      try {
        // Accept either an explicit UUID or a username so non-admin
        // users don't need to know recipient IDs. Username lookup
        // returns only id+username — no leak of email/role/etc.
        let recipientId = ctx.body.recipientUserId;
        if (!recipientId && ctx.body.recipientUsername) {
          const { getDb } = await import('@/db/postgres');
          const { eq } = await import('drizzle-orm');
          const { users } = await import('@/db/schema/users');
          const [u] = await getDb()
            .select({ id: users.id })
            .from(users)
            .where(eq(users.username, ctx.body.recipientUsername))
            .limit(1);
          if (!u) {
            ctx.set.status = 404;
            return { error: 'recipient user not found', code: 'recipient_not_found' };
          }
          recipientId = u.id;
        }
        if (!recipientId) {
          ctx.set.status = 400;
          return { error: 'recipientUserId or recipientUsername required' };
        }
        const transferred = await getOrgWorkspaceManager().transfer(
          ctx.principal.userId,
          ctx.params.id,
          recipientId,
        );
        return transferred;
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
        recipientUserId: t.Optional(t.String()),
        recipientUsername: t.Optional(t.String()),
      }),
      detail: { tags: ['workspaces'] },
    },
  );

/** /api/me/orgs — caller's own org memberships. */
export const orgMeRoutes = new Elysia({ prefix: '/me/orgs' })
  .use(apiContext)

  .get(
    '/',
    async (ctx) => {
      const flag = requireFlag(ctx);
      if (!flag.ok) return flag.body;
      const auth = requireAuth(ctx);
      if (!auth.ok) return auth.body;
      const orgs = await getOrgWorkspaceManager().listForUser(ctx.principal.userId);
      return { orgs };
    },
    { detail: { tags: ['orgs'] } },
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

  .post(
    '/:id/models',
    async (ctx) => {
      const flag = requireFlag(ctx);
      if (!flag.ok) return flag.body;
      const guard = requireAdminGuard(ctx);
      if (!guard.ok) return guard.body;
      const updated = await getDb()
        .update(modelConfig)
        .set({ orgId: ctx.params.id })
        .where(eq(modelConfig.id, ctx.body.modelId))
        .returning();
      if (updated.length === 0) {
        ctx.set.status = 404;
        return { error: 'Model not found' };
      }
      return updated[0];
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({ modelId: t.String() }),
      detail: { tags: ['admin'] },
    },
  )

  .delete(
    '/:id/models/:modelId',
    async (ctx) => {
      const flag = requireFlag(ctx);
      if (!flag.ok) return flag.body;
      const guard = requireAdminGuard(ctx);
      if (!guard.ok) return guard.body;
      const updated = await getDb()
        .update(modelConfig)
        .set({ orgId: null })
        .where(eq(modelConfig.id, ctx.params.modelId))
        .returning();
      if (updated.length === 0) {
        ctx.set.status = 404;
        return { error: 'Model not found' };
      }
      return { removed: true };
    },
    {
      params: t.Object({ id: t.String(), modelId: t.String() }),
      detail: { tags: ['admin'] },
    },
  )

  .post(
    '/:id/skills',
    async (ctx) => {
      const flag = requireFlag(ctx);
      if (!flag.ok) return flag.body;
      const guard = requireAdminGuard(ctx);
      if (!guard.ok) return guard.body;
      const updated = await getDb()
        .update(skills)
        .set({ orgId: ctx.params.id })
        .where(eq(skills.id, ctx.body.skillId))
        .returning();
      if (updated.length === 0) {
        ctx.set.status = 404;
        return { error: 'Skill not found' };
      }
      return updated[0];
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({ skillId: t.String() }),
      detail: { tags: ['admin'] },
    },
  )

  .delete(
    '/:id/skills/:skillId',
    async (ctx) => {
      const flag = requireFlag(ctx);
      if (!flag.ok) return flag.body;
      const guard = requireAdminGuard(ctx);
      if (!guard.ok) return guard.body;
      const updated = await getDb()
        .update(skills)
        .set({ orgId: null })
        .where(eq(skills.id, ctx.params.skillId))
        .returning();
      if (updated.length === 0) {
        ctx.set.status = 404;
        return { error: 'Skill not found' };
      }
      return { removed: true };
    },
    {
      params: t.Object({ id: t.String(), skillId: t.String() }),
      detail: { tags: ['admin'] },
    },
  )

  .get(
    '/:id/sso',
    async (ctx) => {
      const flag = requireFlag(ctx);
      if (!flag.ok) return flag.body;
      const guard = requireAdminGuard(ctx);
      if (!guard.ok) return guard.body;
      const [row] = await getDb()
        .select()
        .from(orgSsoConfig)
        .where(eq(orgSsoConfig.orgId, ctx.params.id))
        .limit(1);
      // Strip sensitive fields when returning to the admin UI; the
      // cert + token ref stay because admins manage them, but they
      // are still scope=admin only via the guard above.
      return row ?? {
        orgId: ctx.params.id,
        samlEnabled: false,
        samlEntityId: null,
        samlSsoUrl: null,
        samlX509Cert: null,
        samlAttributeMap: {},
        scimEnabled: false,
        scimTokenVaultRef: null,
      };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { tags: ['admin'] },
    },
  )

  .patch(
    '/:id/sso',
    async (ctx) => {
      const flag = requireFlag(ctx);
      if (!flag.ok) return flag.body;
      const guard = requireAdminGuard(ctx);
      if (!guard.ok) return guard.body;
      const db = getDb();
      const now = new Date();
      const patch = {
        samlEnabled: ctx.body.samlEnabled,
        samlEntityId: ctx.body.samlEntityId ?? null,
        samlSsoUrl: ctx.body.samlSsoUrl ?? null,
        samlX509Cert: ctx.body.samlX509Cert ?? null,
        samlAttributeMap: ctx.body.samlAttributeMap ?? {},
        scimEnabled: ctx.body.scimEnabled,
        scimTokenVaultRef: ctx.body.scimTokenVaultRef ?? null,
        updatedAt: now,
      };
      const [updated] = await db
        .insert(orgSsoConfig)
        .values({ orgId: ctx.params.id, ...patch })
        .onConflictDoUpdate({ target: orgSsoConfig.orgId, set: patch })
        .returning();
      return updated;
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        samlEnabled: t.Boolean(),
        samlEntityId: t.Optional(t.String()),
        samlSsoUrl: t.Optional(t.String()),
        samlX509Cert: t.Optional(t.String()),
        samlAttributeMap: t.Optional(t.Record(t.String(), t.String())),
        scimEnabled: t.Boolean(),
        scimTokenVaultRef: t.Optional(t.String()),
      }),
      detail: { tags: ['admin'] },
    },
  )

  .get(
    '/:id/usage',
    async (ctx) => {
      const flag = requireFlag(ctx);
      if (!flag.ok) return flag.body;
      const guard = requireAdminGuard(ctx);
      if (!guard.ok) return guard.body;

      const since = ctx.query.since ? new Date(ctx.query.since) : undefined;
      const conditions = [eq(orgMembers.orgId, ctx.params.id)];
      if (since) conditions.push(gte(costLog.createdAt, since));

      const rows = await getDb()
        .select({
          totalInputTokens: sql<number>`COALESCE(SUM(${costLog.inputTokens}), 0)::int`,
          totalOutputTokens: sql<number>`COALESCE(SUM(${costLog.outputTokens}), 0)::int`,
          totalCost: sql<number>`COALESCE(SUM(${costLog.totalCost}), 0)::float`,
          requestCount: sql<number>`COUNT(*)::int`,
        })
        .from(costLog)
        .innerJoin(orgMembers, eq(orgMembers.userId, costLog.userId))
        .where(and(...conditions));

      const byModel = await getDb()
        .select({
          modelName: costLog.modelName,
          totalInputTokens: sql<number>`COALESCE(SUM(${costLog.inputTokens}), 0)::int`,
          totalOutputTokens: sql<number>`COALESCE(SUM(${costLog.outputTokens}), 0)::int`,
          totalCost: sql<number>`COALESCE(SUM(${costLog.totalCost}), 0)::float`,
          requestCount: sql<number>`COUNT(*)::int`,
        })
        .from(costLog)
        .innerJoin(orgMembers, eq(orgMembers.userId, costLog.userId))
        .where(and(...conditions))
        .groupBy(costLog.modelName);

      return { stats: rows[0], byModel };
    },
    {
      params: t.Object({ id: t.String() }),
      query: t.Object({ since: t.Optional(t.String()) }),
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
