import { Elysia } from '@/api/http';
import { apiContext } from '@/api/context';
import { isAuthenticated } from '@/security/principal';

/**
 * Dollar spend budgets — the caller's own view.
 *
 * GET /api/spend-budgets/me — every budget set on the caller (user, role and
 * workspace scopes), with this period's spend, state (ok | warned | paused)
 * and when it resets. Read-only: it never stamps a warning or a pause, and it
 * is scoped by the authenticated principal, never by a parameter, so a user
 * sees only their own budgets. Setting budgets is admin-only
 * (/api/admin/spend-budgets). Enforcement: src/security/spend-budgets.ts.
 */
export const spendBudgetRoutes = new Elysia({ prefix: '/spend-budgets' })
  .use(apiContext)

  .get(
    '/me',
    async ({ principal, set }) => {
      if (!isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }
      const { budgetStatusesFor } = await import('@/security/spend-budgets');
      return { budgets: await budgetStatusesFor(principal.userId) };
    },
    { detail: { tags: ['spend-budgets'] } },
  );
