import { adminDenied } from '@/api/admin-guard';
import { apiContext } from '@/api/context';
import { Elysia, t } from '@/api/http';
import {
  configure,
  installFromDirectory,
  listPackages,
  packageView,
  PluginPackageError,
  setSecret,
  uninstall,
} from '@/plugins/packages/service';
import { apiLogger } from '@/utils/logger';

const STATUS: Record<PluginPackageError['code'], number> = { not_found: 404, exists: 409, invalid: 400, incomplete: 409 };

/** A refused change: its status and every problem; anything else is logged and a 500. */
function refused(err: unknown, set: { status?: number | string }): { error: string; problems?: string[] } {
  if (err instanceof PluginPackageError) {
    set.status = STATUS[err.code];
    return { error: err.message, problems: err.problems };
  }
  apiLogger.error({ err }, 'plugin-packages: change failed');
  set.status = 500;
  return { error: 'The plugin package could not be changed' };
}

/**
 * Plugin packages (docs/PLUGIN-PACKAGES.md): install-wide, admins only.
 * Installing takes a directory on the server (the marketplace, plan point
 * C15, will fetch signed packages instead); a package starts disabled.
 */
export const pluginPackageRoutes = new Elysia({ prefix: '/plugin-packages' })
  .use(apiContext)

  .get(
    '/',
    async ({ user, principal, set }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;
      return listPackages();
    },
    { detail: { tags: ['plugin-packages'] } },
  )

  .post(
    '/',
    async ({ user, principal, body, set }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;
      try {
        const row = await installFromDirectory(body.path, principal.userId, { upgrade: body.upgrade === true });
        return { name: row.name, version: row.version, enabled: row.enabled, manifest: row.manifest };
      } catch (err) {
        return refused(err, set);
      }
    },
    {
      body: t.Object({
        /** An absolute path on the server to the package directory. */
        path: t.String({ minLength: 1, maxLength: 1000, pattern: '^(/|[A-Za-z]:\\\\)' }),
        upgrade: t.Optional(t.Boolean()),
      }),
      detail: { tags: ['plugin-packages'] },
    },
  )

  .patch(
    '/:name',
    async ({ user, principal, params, body, set }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;
      try {
        await configure(params.name, { settings: body.settings, enabled: body.enabled }, principal.userId);
        return await packageView(params.name);
      } catch (err) {
        return refused(err, set);
      }
    },
    {
      params: t.Object({ name: t.String({ maxLength: 50 }) }),
      body: t.Object({
        enabled: t.Optional(t.Boolean()),
        settings: t.Optional(t.Record(t.String({ maxLength: 50 }), t.Unknown())),
      }),
      detail: { tags: ['plugin-packages'] },
    },
  )

  // Set (or with null remove) one declared secret. The value is never returned.
  .put(
    '/:name/secrets/:key',
    async ({ user, principal, params, body, set }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;
      try {
        await setSecret(params.name, params.key, body.value, principal.userId);
        return { saved: true };
      } catch (err) {
        return refused(err, set);
      }
    },
    {
      params: t.Object({ name: t.String({ maxLength: 50 }), key: t.String({ maxLength: 64 }) }),
      body: t.Object({ value: t.Union([t.String({ maxLength: 10_000 }), t.Null()]) }),
      detail: { tags: ['plugin-packages'] },
    },
  )

  .delete(
    '/:name',
    async ({ user, principal, params, set }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;
      try {
        await uninstall(params.name, principal.userId);
        return { uninstalled: true };
      } catch (err) {
        return refused(err, set);
      }
    },
    { params: t.Object({ name: t.String({ maxLength: 50 }) }), detail: { tags: ['plugin-packages'] } },
  );
