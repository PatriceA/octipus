import { isAdmin, isAuthenticated, type Principal } from '@/security/principal';

/**
 * The install-admin gate for routes that read or change install state
 * (models config, health, tool and plugin inventory, reloads, …). A
 * non-admin account — someone who joined a space through an invite, say —
 * sees only its own data (docs/SPACES.md → What members see).
 *
 *   const denied = adminDenied(ctx);
 *   if (denied) return denied;
 *
 * Sets 401 without a signed-in user and 403 for a non-admin.
 */
export function adminDenied(ctx: {
  set: { status?: number | string };
  user: { isAdmin?: boolean } | null;
  principal: Principal;
}): { error: string } | null {
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
