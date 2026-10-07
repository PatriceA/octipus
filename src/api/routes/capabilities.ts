import { Elysia, t } from '@/api/http';
import { adminDenied } from '@/api/admin-guard';
import { apiContext } from '@/api/context';
import { getCapabilityService } from '@/capabilities/service';
import { apiLogger } from '@/utils/logger';

/**
 * Capability routes — surface what optional tools are installed and
 * dispatch installs from the wizard / `octi capabilities` CLI.
 *
 * - GET  /capabilities                   admin-only. The install's tool
 *                                        inventory (paths, versions) is
 *                                        install state, not member data.
 * - POST /capabilities/:id/install       admin-only. Runs the tool's installer
 *                                        and re-probes.
 * - POST /capabilities/install-all-missing  admin-only. Installs every
 *                                        currently-missing capability that
 *                                        has a registered installer.
 * - POST /capabilities/probe             admin-only. Force re-probe.
 *
 * The capabilities table is the root agent's source of truth — gating
 * tool dispatch happens via the same data this endpoint exposes.
 */
export const capabilitiesRoutes = new Elysia({ prefix: '/capabilities' })
  .use(apiContext)

  .get('/', async ({ user, principal, set }) => {
    const denied = adminDenied({ set, user, principal });
    if (denied) return denied;
    const rows = await getCapabilityService().list();
    return rows.map((r) => ({
      toolId: r.toolId,
      available: r.available,
      degraded: r.degraded,
      reason: r.reason,
      version: r.version,
      path: r.path,
      installerKind: r.installerKind,
      checkedAt: r.checkedAt,
    }));
  })

  .post(
    '/probe',
    async ({ user, principal, set }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;
      const rows = await getCapabilityService().probeAll();
      return { count: rows.length, available: rows.filter((r) => r.available).length };
    },
    { detail: { tags: ['capabilities'] } },
  )

  .post(
    '/install-all-missing',
    async ({ user, principal, set }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;
      try {
        return await getCapabilityService().installAllMissing();
      } catch (err) {
        apiLogger.error({ err }, 'capabilities install-all-missing failed');
        set.status = 500;
        return { error: (err as Error).message };
      }
    },
    { detail: { tags: ['capabilities'] } },
  )

  .post(
    '/:id/install',
    async ({ params, user, principal, set }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;
      try {
        const result = await getCapabilityService().install(params.id);
        if (!result.ok) set.status = 409;
        return result;
      } catch (err) {
        apiLogger.error({ err, id: params.id }, 'capability install failed');
        set.status = 500;
        return { ok: false, detail: (err as Error).message };
      }
    },
    { params: t.Object({ id: t.String() }), detail: { tags: ['capabilities'] } },
  );
