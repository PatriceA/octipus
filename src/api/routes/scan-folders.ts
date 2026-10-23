import { apiContext } from '@/api/context';
import { Elysia, t } from '@/api/http';
import { checkFolderPath, ScanFolderPathError } from '@/core/scan-folders/paths';
import { scanFolderOnce } from '@/core/scan-folders/sweep';
import { contentRepos } from '@/db/repositories/content';
import type { ScanFolder } from '@/db/schema/scan-folders';
import { isAuthenticated } from '@/security/principal';
import { SpaceError } from '@/security/space-access';
import { apiLogger } from '@/utils/logger';

const NOT_AUTHENTICATED = { error: 'Not authenticated' };
const ID = t.Object({ id: t.String({ maxLength: 64 }) });

function view(f: ScanFolder) {
  return {
    id: f.id,
    workspaceId: f.workspaceId,
    label: f.label,
    path: f.path,
    enabled: f.enabled,
    lastScanAt: f.lastScanAt?.toISOString() ?? null,
    lastError: f.lastError,
    filed: f.filed,
    createdAt: f.createdAt.toISOString(),
  };
}

function refused(err: unknown, set: { status?: number | string }): { error: string } {
  if (err instanceof SpaceError) throw err;
  if (err instanceof ScanFolderPathError) {
    set.status = 400;
    return { error: err.message };
  }
  if ((err as { code?: string }).code === '23505') {
    set.status = 409;
    return { error: 'This directory is already a scan folder' };
  }
  apiLogger.error({ err }, 'scan-folders: request failed');
  set.status = 500;
  return { error: 'The scan folder could not be changed' };
}

/**
 * Scan folders (docs/SCAN-FOLDERS.md): server directories filed into the
 * documents of the scope they were set up in. Admins only, reads included
 * (a folder names a path on the server); in a space the admin must also be
 * able to write there.
 */
export const scanFolderRoutes = new Elysia({ prefix: '/scan-folders' })
  .use(apiContext)

  .get('/', async ({ principal, set }) => {
    if (!isAuthenticated(principal)) { set.status = 401; return NOT_AUTHENTICATED; }
    const repo = contentRepos(principal).scanFolders;
    repo.assertManage();
    return (await repo.list()).map(view);
  }, { detail: { tags: ['scan-folders'] } })

  .post('/', async ({ principal, body, set }) => {
    if (!isAuthenticated(principal)) { set.status = 401; return NOT_AUTHENTICATED; }
    try {
      const repo = contentRepos(principal).scanFolders;
      repo.assertManage();
      const path = await checkFolderPath(body.path);
      const folder = await repo.create({
        label: body.label?.trim().slice(0, 100) || path,
        path,
        enabled: body.enabled ?? true,
      });
      set.status = 201;
      return view(folder);
    } catch (err) {
      return refused(err, set);
    }
  }, {
    body: t.Object({
      path: t.String({ minLength: 1, maxLength: 1000 }),
      label: t.Optional(t.String({ maxLength: 100 })),
      enabled: t.Optional(t.Boolean()),
    }),
    detail: { tags: ['scan-folders'] },
  })

  .patch('/:id', async ({ principal, params, body, set }) => {
    if (!isAuthenticated(principal)) { set.status = 401; return NOT_AUTHENTICATED; }
    try {
      const repo = contentRepos(principal).scanFolders;
      repo.assertManage();
      const folder = await repo.update(params.id, {
        ...(body.path !== undefined ? { path: await checkFolderPath(body.path) } : {}),
        ...(body.label !== undefined ? { label: body.label.trim().slice(0, 100) || 'Scan folder' } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      });
      if (!folder) { set.status = 404; return { error: 'Scan folder not found' }; }
      return view(folder);
    } catch (err) {
      return refused(err, set);
    }
  }, {
    params: ID,
    body: t.Object({
      path: t.Optional(t.String({ minLength: 1, maxLength: 1000 })),
      label: t.Optional(t.String({ maxLength: 100 })),
      enabled: t.Optional(t.Boolean()),
    }),
    detail: { tags: ['scan-folders'] },
  })

  .delete('/:id', async ({ principal, params, set }) => {
    if (!isAuthenticated(principal)) { set.status = 401; return NOT_AUTHENTICATED; }
    if (!(await contentRepos(principal).scanFolders.delete(params.id))) { set.status = 404; return { error: 'Scan folder not found' }; }
    return { deleted: true };
  }, { params: ID, detail: { tags: ['scan-folders'] } })

  // File what has settled now instead of at the next tick.
  .post('/:id/scan', async ({ principal, params, set }) => {
    if (!isAuthenticated(principal)) { set.status = 401; return NOT_AUTHENTICATED; }
    const repo = contentRepos(principal).scanFolders;
    repo.assertManage();
    const folder = await repo.findById(params.id);
    if (!folder) { set.status = 404; return { error: 'Scan folder not found' }; }
    if (!folder.enabled) { set.status = 409; return { error: 'The scan folder is disabled' }; }
    const result = await scanFolderOnce(folder);
    if (!result) { set.status = 409; return { error: 'A scan of this folder is already running' }; }
    return result;
  }, { params: ID, detail: { tags: ['scan-folders'] } });
