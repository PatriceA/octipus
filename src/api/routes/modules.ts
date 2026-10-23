import { adminDenied } from '@/api/admin-guard';
import { apiContext } from '@/api/context';
import { Elysia, t } from '@/api/http';
import { enabledModules, ModuleChangeError, moduleById, moduleViews, setModuleOn } from '@/core/modules/registry';
import type { ModulesResponse } from '@/shared/modules';
import { isAuthenticated } from '@/security/principal';

function modulesResponse(): ModulesResponse {
  return { modules: moduleViews(), enabled: [...enabledModules()] };
}

/**
 * Modules (docs/MODULES.md): what is on, for every signed-in user (the web
 * builds its sidebar from it); switching one on or off, for admins. Core:
 * this route is never switched off.
 */
export const moduleRoutes = new Elysia({ prefix: '/modules' })
  .use(apiContext)

  .get('/', ({ principal, set }) => {
    if (!isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
    return modulesResponse();
  }, { detail: { tags: ['modules'] } })

  // Turning one on turns on what it depends on; turning one off is refused
  // while a module that depends on it is on. Off deletes nothing.
  .put('/:id', async ({ user, principal, params, body, set }) => {
    const denied = adminDenied({ set, user, principal });
    if (denied) return denied;
    if (!moduleById(params.id)) { set.status = 404; return { error: `Unknown module: ${params.id}` }; }
    try {
      await setModuleOn(params.id, body.on, user?.id);
    } catch (err) {
      if (err instanceof ModuleChangeError) { set.status = 409; return { error: err.message }; }
      throw err;
    }
    return modulesResponse();
  }, {
    params: t.Object({ id: t.String({ maxLength: 64 }) }),
    body: t.Object({ on: t.Boolean() }),
    detail: { tags: ['modules'] },
  });
