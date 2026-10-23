import { isModuleOn, moduleOfPath } from '@/core/modules/registry';

/**
 * The path as the router matches it: percent-decoded like `decodeURI` (the
 * router's own rule), so `/api/c%61ses` is the cases route here too. A
 * malformed escape is decoded where it can be and kept where it cannot.
 */
export function routedPath(pathname: string): string {
  if (!pathname.includes('%')) return pathname;
  try {
    return decodeURI(pathname);
  } catch {
    return pathname.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => { try { return decodeURI(run); } catch { return run; } });
  }
}

/**
 * A request under a route of a module that is off (docs/MODULES.md): 404,
 * the same answer as for a route that does not exist, before any route,
 * authentication rule or rate limit applies (the request's derives, such as
 * reading the session, have run). Null: the request goes on.
 */
export function moduleOffResponse(pathname: string): { error: string; code: 'module_off'; module: string } | null {
  for (const path of new Set([pathname, routedPath(pathname)])) {
    const owner = moduleOfPath(path);
    if (owner !== undefined && !isModuleOn(owner)) return { error: 'Not found', code: 'module_off', module: owner };
  }
  return null;
}
