import { apiContext } from '@/api/context';
import { Elysia, t } from '@/api/http';
import { blockInstance, FederationAdminError, listInstances, unblockInstance } from '@/core/federation/host-ops';
import { isAdmin, isAuthenticated, type Principal } from '@/security/principal';

/**
 * Admin → Federation (docs/plans/federation-spec.md §7.6, §10): the other
 * installs whose members joined spaces here, and the switch that blocks one.
 *
 *   GET  /api/admin/federation/instances              — each install, its link state and live memberships
 *   POST /api/admin/federation/instances/:id/block    — refuse it at once: its link closes (4403), the data
 *                                                       door refuses its rows, every membership it holds is
 *                                                       removed through the normal path, audited
 *   POST /api/admin/federation/instances/:id/unblock  — the status only; removed memberships stay removed
 *
 * Admins only (403 otherwise, 401 anonymous).
 */

type AdminCtx = {
  set: { status?: number | string };
  user: { id: string } | null;
  principal: Principal;
};

function requireAdmin(ctx: AdminCtx): { error: string } | null {
  if (!ctx.user || !isAuthenticated(ctx.principal)) {
    ctx.set.status = 401;
    return { error: 'Authentication required' };
  }
  if (!isAdmin(ctx.principal)) {
    ctx.set.status = 403;
    return { error: 'Admin access required' };
  }
  return null;
}

/** The admin acting: the real one behind an impersonation. */
function adminId(ctx: AdminCtx): string {
  return ctx.principal.actorUserId ?? ctx.principal.userId;
}

async function handle<T>(ctx: AdminCtx, run: () => Promise<T>): Promise<T | { error: string }> {
  const refused = requireAdmin(ctx);
  if (refused) return refused;
  try {
    return await run();
  } catch (err) {
    if (err instanceof FederationAdminError) {
      ctx.set.status = 404;
      return { error: err.message };
    }
    throw err;
  }
}

const instanceParams = t.Object({ id: t.String({ minLength: 26, maxLength: 26, pattern: '^[a-z2-7]{26}$' }) });

export const federationAdminRoutes = new Elysia({ prefix: '/admin/federation' })
  .use(apiContext)

  .get('/instances', (ctx) => handle(ctx, async () => ({ instances: await listInstances() })), {
    detail: { tags: ['admin'] },
  })

  .post('/instances/:id/block', (ctx) => handle(ctx, async () => {
    const result = await blockInstance(adminId(ctx), ctx.params.id);
    return { success: true, membershipsRemoved: result.removed, ...(result.warnings.length > 0 ? { warning: result.warnings.join('; ') } : {}) };
  }), {
    params: instanceParams,
    detail: { tags: ['admin'] },
  })

  .post('/instances/:id/unblock', (ctx) => handle(ctx, async () => {
    await unblockInstance(adminId(ctx), ctx.params.id);
    return { success: true };
  }), {
    params: instanceParams,
    detail: { tags: ['admin'] },
  });
