import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { getConfig } from '@/config';
import { resolve } from 'path';
import { existsSync, statSync } from 'fs';
import { homedir } from 'os';

// System directories that must never be added as workspace paths
const DENIED_PATHS = [
  '/', '/bin', '/boot', '/dev', '/etc', '/lib', '/lib64',
  '/opt', '/proc', '/root', '/run', '/sbin', '/srv', '/sys', '/usr', '/var',
];

function isPathDenied(resolvedPath: string): boolean {
  // Allow /tmp/assistant-* prefixed paths (used for backend logs, temp files)
  if (resolvedPath.startsWith('/tmp/assistant-')) {
    return false;
  }
  for (const denied of DENIED_PATHS) {
    if (resolvedPath === denied || resolvedPath.startsWith(denied + '/')) {
      return true;
    }
  }
  return false;
}

export const workspaceRoutes = new Elysia({ prefix: '/workspace' })
  .use(apiContext)
  .get('/', async ({ user, set }) => {
    if (!user) {
      set.status = 401;
      return { error: 'Authentication required' };
    }
    const config = getConfig();
    return {
      rootPath: resolve(config.workspace.rootPath),
      additionalPaths: config.workspace.additionalPaths.map(p => resolve(p)),
    };
  }, { detail: { tags: ['workspace'] } })

  .put('/', async ({ user, body, set }) => {
    if (!user) return { error: 'Authentication required' };
    const config = getConfig();
    const userHome = homedir();
    const workspaceRoot = resolve(config.workspace.rootPath);

    // Validate all paths exist, are directories, and are not system paths
    for (const p of body.additionalPaths) {
      const resolved = resolve(p);

      // Check against denylist
      if (isPathDenied(resolved)) {
        set.status = 400;
        return { error: `Denied path: ${p} — system directories cannot be added as workspace paths` };
      }

      // Require paths to be under workspace root or user home
      if (!resolved.startsWith(workspaceRoot) && !resolved.startsWith(userHome)) {
        set.status = 400;
        return { error: `Invalid path: ${p} — must be under workspace root (${workspaceRoot}) or user home (${userHome})` };
      }

      if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
        set.status = 400;
        return { error: `Invalid path: ${p} (does not exist or is not a directory)` };
      }
    }

    // Update config in memory
    config.workspace.additionalPaths = body.additionalPaths;

    return {
      rootPath: resolve(config.workspace.rootPath),
      additionalPaths: config.workspace.additionalPaths.map(p => resolve(p)),
    };
  }, {
    body: t.Object({ additionalPaths: t.Array(t.String()) }),
    detail: { tags: ['workspace'] },
  })

  .post('/validate', async ({ user, body, set }) => {
    if (!user) {
      set.status = 401;
      return { error: 'Authentication required' };
    }
    const resolved = resolve(body.path);
    const exists = existsSync(resolved);
    let isDirectory = false;
    if (exists) {
      try { isDirectory = statSync(resolved).isDirectory(); } catch {}
    }
    return { path: resolved, exists, isDirectory, valid: exists && isDirectory };
  }, {
    body: t.Object({ path: t.String() }),
    detail: { tags: ['workspace'] },
  });
