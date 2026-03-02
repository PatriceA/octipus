import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { getConfig } from '@/config';
import { resolve } from 'path';
import { existsSync, statSync } from 'fs';

export const workspaceRoutes = new Elysia({ prefix: '/workspace' })
  .use(apiContext)
  .get('/', async ({ user }) => {
    if (!user) return { error: 'Authentication required' };
    const config = getConfig();
    return {
      rootPath: resolve(config.workspace.rootPath),
      additionalPaths: config.workspace.additionalPaths.map(p => resolve(p)),
    };
  }, { detail: { tags: ['workspace'] } })

  .post('/validate', async ({ user, body }) => {
    if (!user) return { error: 'Authentication required' };
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
