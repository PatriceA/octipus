import { moduleOfPath, isModuleOn } from '@/core/modules/registry';

/**
 * A request under a route of a module that is off (docs/MODULES.md): 404,
 * the same answer as for a route that does not exist, before any route,
 * authentication check or rate limit runs. Null: the request goes on.
 */
export function moduleOffResponse(pathname: string): { error: string; code: 'module_off'; module: string } | null {
  const owner = moduleOfPath(pathname);
  if (owner === undefined || isModuleOn(owner)) return null;
  return { error: 'Not found', code: 'module_off', module: owner };
}
