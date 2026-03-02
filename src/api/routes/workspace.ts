import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { getConfig } from '@/config';
import { resolve } from 'path';
import { existsSync, statSync } from 'fs';

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

    // Validate all paths exist and are directories
    for (const p of body.additionalPaths) {
      const resolved = resolve(p);
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
