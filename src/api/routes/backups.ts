import { join } from 'node:path';
import { adminDenied } from '@/api/admin-guard';
import { apiContext } from '@/api/context';
import { Elysia, t } from '@/api/http';
import { getConfig } from '@/config';
import { backupRoot, backupRunning, lastRun, listBackups, runBackup, verifyBackup } from '@/core/backup/service';

/**
 * Backups (docs/BACKUP.md): install-wide, admins only. Running and checking
 * a backup here; restoring is done with the server stopped
 * (`npm run backup -- restore`).
 */
export const backupRoutes = new Elysia({ prefix: '/backups' })
  .use(apiContext)

  .get('/', async ({ user, principal, set }) => {
    const denied = adminDenied({ set, user, principal });
    if (denied) return denied;
    const config = getConfig().backup;
    return {
      config: { enabled: config.enabled, path: backupRoot(), hour: config.hour, keep: config.keep, includeFiles: config.includeFiles },
      running: backupRunning(),
      lastRun: await lastRun(),
      backups: await listBackups(),
    };
  }, { detail: { tags: ['backups'] } })

  // Start a backup now. It runs on; its outcome shows in GET (lastRun).
  .post('/run', async ({ user, principal, set }) => {
    const denied = adminDenied({ set, user, principal });
    if (denied) return denied;
    if (backupRunning()) { set.status = 409; return { error: 'A backup is already running' }; }
    void runBackup('manual');
    set.status = 202;
    return { started: true };
  }, { detail: { tags: ['backups'] } })

  // Check an existing backup again (load it back).
  .post('/:id/verify', async ({ user, principal, params, set }) => {
    const denied = adminDenied({ set, user, principal });
    if (denied) return denied;
    const backup = (await listBackups()).find((b) => b.id === params.id);
    if (!backup) { set.status = 404; return { error: 'Backup not found' }; }
    return verifyBackup(join(backupRoot(), backup.id));
  }, { params: t.Object({ id: t.String({ pattern: '^[0-9]{8}T[0-9]{6}Z$' }) }), detail: { tags: ['backups'] } });
