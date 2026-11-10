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
import { installFromUrl, listRegistry } from '@/plugins/packages/remote';
import { MAX_PLUGIN_SECRET_LENGTH } from '@/shared/plugin-package';
import { apiLogger } from '@/utils/logger';

const STATUS: Record<PluginPackageError['code'], number> = { not_found: 404, exists: 409, invalid: 400, incomplete: 409, conflict: 409 };

/** A refused change: its status and every problem; anything else is logged and a 500. */
function refused(err: unknown, set: { status?: number | string }): { error: string; problems?: string[]; actualHash?: string; contributionsHash?: string } {
  if (err instanceof PluginPackageError) {
    set.status = STATUS[err.code];
    return { error: err.message, problems: err.problems, ...err.details };
  }
  apiLogger.error({ err }, 'plugin-packages: change failed');
  set.status = 500;
  return { error: 'The plugin package could not be changed' };
}

/**
 * Plugin packages (docs/PLUGIN-PACKAGES.md): install-wide, admins only.
 * Installing takes a directory on the server, signed or not (signature checked
 * against plugins.trustedPublishers), or an https tarball, which must carry a
 * valid trusted signature; `GET /registry` lists what plugins.registries
 * offer. A package starts disabled. An `in-process` plugin also needs
 * `approveInProcess` before it can be enabled.
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

  // What plugins.registries list (each index cached briefly), with the version installed here.
  .get(
    '/registry',
    async ({ user, principal, set }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;
      return listRegistry();
    },
    { detail: { tags: ['plugin-packages'] } },
  )

  .post(
    '/',
    async ({ user, principal, body, set }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;
      if ((body.path === undefined) === (body.url === undefined)) {
        set.status = 400;
        return { error: 'Give either path (a directory on the server) or url (an https .tar.gz)' };
      }
      if (body.sha256 !== undefined && body.url === undefined) {
        set.status = 400;
        return { error: 'sha256 checks a download; it goes with url' };
      }
      try {
        const upgrade = body.upgrade === true;
        const common = {
          upgrade,
          ...(body.allowSignerChange === true ? { allowSignerChange: true } : {}),
          ...(body.allowDowngrade === true ? { allowDowngrade: true } : {}),
        };
        const row = body.url !== undefined
          ? await installFromUrl(body.url, principal.userId, { ...common, sha256: body.sha256, name: body.name, version: body.version })
          : await installFromDirectory(body.path as string, principal.userId, { ...common, expect: { name: body.name, version: body.version } });
        return { name: row.name, version: row.version, enabled: row.enabled, contentHash: row.contentHash, signedBy: row.signedBy, warnings: row.warnings, manifest: row.manifest };
      } catch (err) {
        return refused(err, set);
      }
    },
    {
      body: t.Object({
        /** An absolute path on the server to the package directory. */
        path: t.Optional(t.String({ minLength: 1, maxLength: 1000, pattern: '^(/|[A-Za-z]:\\\\)' })),
        /** Or an https URL of a .tar.gz; it must carry a valid signature by a trusted publisher. */
        url: t.Optional(t.String({ minLength: 9, maxLength: 2000, pattern: '^https://' })),
        /** With url: the sha256 the tarball must hash to (`sha256:<hex>` or bare hex), checked before it is unpacked. */
        sha256: t.Optional(t.String({ maxLength: 71, pattern: '^(sha256:)?[0-9a-fA-F]{64}$' })),
        /** The name and version the package must have (what a registry entry promised); refused (400) on a mismatch. */
        name: t.Optional(t.String({ minLength: 1, maxLength: 50 })),
        version: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
        upgrade: t.Optional(t.Boolean()),
        /** An upgrade signed by another key than the installed version (refused, 409, without it; audited). */
        allowSignerChange: t.Optional(t.Boolean()),
        /** An upgrade to an older version (refused, 409, without it; audited). */
        allowDowngrade: t.Optional(t.Boolean()),
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
        await configure(params.name, {
          settings: body.settings, enabled: body.enabled, approveContent: body.approveContent, approveInProcess: body.approveInProcess,
          approveContributions: body.approveContributions,
          ...(body.approveHostScopes !== undefined ? { approveHostScopes: body.approveHostScopes } : {}),
        }, principal.userId);
        return await packageView(params.name);
      } catch (err) {
        return refused(err, set);
      }
    },
    {
      params: t.Object({ name: t.String({ maxLength: 50 }) }),
      body: t.Object({
        enabled: t.Optional(t.Boolean()),
        /**
         * Accept the package's files after a hash mismatch: the hash the admin
         * reviewed (`sha256:<hex>`, the view's `actualHash`). Refused (409)
         * unless the files hash to it now. A boolean is refused (400) with a
         * message asking for the hash; it is accepted here only to say so.
         */
        approveContent: t.Optional(t.Union([t.String({ maxLength: 100 }), t.Boolean()])),
        /**
         * An `in-process` plugin only: approve running it in the server
         * process, for the content hash the admin reviewed (the approved
         * `contentHash`). Refused (409) unless it is the approved content and
         * the files hash to it now; approving other content clears it.
         * Enabling such a plugin without it is refused (409). A boolean is
         * refused (400) with a message asking for the hash.
         */
        approveInProcess: t.Optional(t.Union([t.String({ maxLength: 100 }), t.Boolean()])),
        /**
         * Approve what the package adds besides tools (commands, schedules,
         * events, prompt text in every user's agents, turn context), for the
         * contributions hash the admin reviewed (the view's
         * `contributions.hash`). Refused (409, with `contributionsHash`) unless
         * it is what the package adds now. Enabling a package that adds any
         * without it is refused (409, with `contributionsHash`); install and
         * upgrade clear it. A boolean is refused (400).
         */
        approveContributions: t.Optional(t.Union([t.String({ maxLength: 100 }), t.Boolean()])),
         * The host API scopes the admin approves (docs/PLUGIN-PACKAGES.md#host-api):
         * scopes the manifest declares. Enabling a package that declares any
         * needs all of them approved; an upgrade clears the approval.
         */
        approveHostScopes: t.Optional(t.Array(t.String({ maxLength: 40 }), { maxItems: 20 })),
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
      body: t.Object({ value: t.Union([t.String({ maxLength: MAX_PLUGIN_SECRET_LENGTH }), t.Null()]) }),
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
