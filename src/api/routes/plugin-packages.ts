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
import { installBundled, listBundled } from '@/plugins/packages/bundled';
import { installFromUrl, listRegistry } from '@/plugins/packages/remote';
import { isAdmin, isAuthenticated } from '@/security/principal';
import { MAX_PLUGIN_SECRET_LENGTH, type PluginUsageView } from '@/shared/plugin-package';
import { apiLogger } from '@/utils/logger';

const NAME_PARAM = t.Object({ name: t.String({ maxLength: 50, pattern: '^[a-z][a-z0-9-]{1,49}$' }) });
const USAGE_QUERY = t.Object({ days: t.Optional(t.String({ pattern: '^[0-9]{1,3}$' })) });

/** One plugin's usage over `days` (1-365, default 30): every user's (admins), or one user's own. */
async function usageOf(name: string, daysParam: string | undefined, userId: string | null): Promise<PluginUsageView> {
  const days = Math.min(365, Math.max(1, Number(daysParam ?? 30) || 30));
  const since = new Date(Date.now() - days * 24 * 60 * 60_000);
  const { pluginUsageRepository } = await import('@/db/repositories/plugin-usage-repository');
  const totals = await pluginUsageRepository.usage(name, since, userId ?? undefined);
  const { byUser, ...rest } = totals;
  return { name, days, since: since.toISOString(), scope: userId === null ? 'all' : 'me', ...rest, ...(userId === null ? { byUser } : {}) };
}

const STATUS: Record<PluginPackageError['code'], number> = { not_found: 404, exists: 409, invalid: 400, incomplete: 409, conflict: 409 };

/** A refused change: its status and every problem; anything else is logged and a 500. */
function refused(err: unknown, set: { status?: number | string }): { error: string; problems?: string[]; actualHash?: string; contributionsHash?: string; sourceChange?: { from: string; to: string } } {
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
 * offer, and `GET /bundled` the first-party plugins shipped with Octipus
 * (installed with `{ bundled: <name> }`). A package starts disabled. An `in-process` plugin also needs
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

  // The sandbox plugin servers get here (plugins.sandbox and the working runner, or why none):
  // the admin page's "plugin sandbox: active runner X / unavailable" line.
  .get(
    '/sandbox',
    async ({ user, principal, set }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;
      const { pluginSandboxView } = await import('@/plugins/packages/sandbox-policy');
      return pluginSandboxView();
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

  // The marketplace and the configured registries, one card per plugin (src/plugins/packages/marketplace.ts).
  // README and CHANGELOG are raw Markdown: the client renders them sanitized, without raw HTML or remote images.
  .get(
    '/marketplace',
    async ({ user, principal, set, query }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;
      const { marketplaceListing } = await import('@/plugins/packages/marketplace');
      return marketplaceListing({ q: query.q, category: query.category });
    },
    {
      query: t.Object({ q: t.Optional(t.String({ maxLength: 200 })), category: t.Optional(t.String({ maxLength: 40 })) }),
      detail: { tags: ['plugin-packages'] },
    },
  )

  // A listing image, fetched by the host from the registry that lists it
  // (src/plugins/packages/marketplace-assets.ts): PNG, JPEG, WebP or GIF by
  // their bytes, never SVG, served under a CSP that runs nothing.
  .get(
    '/marketplace/asset',
    async ({ user, principal, set, query }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;
      const { AssetError, fetchListingAsset } = await import('@/plugins/packages/marketplace-assets');
      try {
        const asset = await fetchListingAsset(query.url);
        set.headers['Content-Type'] = asset.type;
        set.headers['X-Content-Type-Options'] = 'nosniff';
        set.headers['Content-Security-Policy'] = "default-src 'none'";
        set.headers['Content-Disposition'] = 'inline';
        set.headers['Cache-Control'] = 'private, max-age=3600';
        return new Response(new Uint8Array(asset.bytes));
      } catch (err) {
        if (err instanceof AssetError) {
          set.status = err.status;
          return { error: err.message };
        }
        apiLogger.error({ err }, 'plugin-packages: listing image failed');
        set.status = 500;
        return { error: 'The image could not be served' };
      }
    },
    { query: t.Object({ url: t.String({ minLength: 9, maxLength: 2000, pattern: '^https://' }) }), detail: { tags: ['plugin-packages'] } },
  )

  // Installed packages with a newer version from the same source, each with a permissions diff.
  .get(
    '/updates',
    async ({ user, principal, set }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;
      const { listUpdates } = await import('@/plugins/packages/marketplace-updates');
      return listUpdates();
    },
    { detail: { tags: ['plugin-packages'] } },
  )

  // Revocations the marketplace published (in force and cleared), and clearing one (audited).
  // `enforced` is false for a cleared one, and for a package revocation whose
  // signing key is revoked since (`signerRevoked`), until a trusted key re-asserts it.
  .get(
    '/revocations',
    async ({ user, principal, set }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;
      const { listRevocations } = await import('@/plugins/packages/revocations');
      return (await listRevocations()).map(({ row: r, enforced, signerRevoked }) => ({
        id: r.id, kind: r.kind, name: r.name, version: r.version, keyId: r.keyId, reason: r.reason, registryUrl: r.registryUrl,
        signedByKey: r.signedByKey, indexGeneratedAt: r.indexGeneratedAt.toISOString(), firstSeenAt: r.firstSeenAt.toISOString(),
        clearedAt: r.clearedAt?.toISOString() ?? null, clearedBy: r.clearedBy, clearReason: r.clearReason,
        scope: 'marketplace' as const, enforced, signerRevoked,
      }));
    },
    { detail: { tags: ['plugin-packages'] } },
  )
  .delete(
    '/revocations/:id',
    async ({ user, principal, set, params, body }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;
      const { clearRevocation, RevocationClearError } = await import('@/plugins/packages/revocations');
      let row: Awaited<ReturnType<typeof clearRevocation>>;
      try {
        row = await clearRevocation(params.id, principal.userId, body.reason);
      } catch (err) {
        if (!(err instanceof RevocationClearError)) throw err;
        set.status = 409;
        return { error: err.message };
      }
      if (!row) {
        set.status = 404;
        return { error: 'No such revocation in force' };
      }
      return { cleared: true, id: row.id, note: 'If the marketplace still lists it, its next index revokes it again.' };
    },
    {
      params: t.Object({ id: t.String({ pattern: '^[0-9a-fA-F-]{36}$' }) }),
      body: t.Object({ reason: t.String({ minLength: 3, maxLength: 500 }) }),
      detail: { tags: ['plugin-packages'] },
    },
  )

  // Reset one listing pin (src/plugins/packages/listing-pins.ts): the next
  // index read pins that version afresh. For a version refused as "replaced"
  // after a legitimate re-publish. Audited with the admin's reason.
  .delete(
    '/pins',
    async ({ user, principal, set, body }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;
      const { currentMarketplace, MARKETPLACE_REGISTRY } = await import('@/plugins/packages/marketplace-config');
      const { configuredRegistries, clearRegistryCache } = await import('@/plugins/packages/remote');
      const settings = currentMarketplace();
      const url = body.registry === MARKETPLACE_REGISTRY
        ? (settings.state === 'off' ? null : settings.url)
        : configuredRegistries().find((r) => r.name === body.registry)?.url ?? null;
      if (url === null) {
        set.status = 404;
        return { error: `No registry named "${body.registry}"` };
      }
      const { resetPin } = await import('@/plugins/packages/listing-pins');
      const removed = await resetPin(url, body.name, body.version, principal.userId, body.reason);
      if (!removed) {
        set.status = 404;
        return { error: `No pin for ${body.name} ${body.version} in ${body.registry}` };
      }
      clearRegistryCache();
      return { reset: true, registry: body.registry, name: body.name, version: body.version, contentHash: removed.contentHash, note: 'The next index read pins this version afresh, to the content it lists then.' };
    },
    {
      body: t.Object({
        registry: t.String({ minLength: 1, maxLength: 100 }),
        name: t.String({ minLength: 1, maxLength: 50 }),
        version: t.String({ minLength: 1, maxLength: 100 }),
        reason: t.String({ minLength: 3, maxLength: 500 }),
      }),
      detail: { tags: ['plugin-packages'] },
    },
  )

  // The first-party plugins shipped with Octipus (plugins/ in the install), with the version installed here.
  .get(
    '/bundled',
    async ({ user, principal, set }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;
      return listBundled();
    },
    { detail: { tags: ['plugin-packages'] } },
  )

  .post(
    '/',
    async ({ user, principal, body, set }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;
      const sources = [body.path, body.url, body.bundled, body.registry].filter((v) => v !== undefined).length;
      if (sources !== 1) {
        set.status = 400;
        return { error: 'Give one of path (a directory on the server), url (an https .tar.gz), bundled (a plugin shipped with Octipus) or registry (with name: "marketplace" or a configured registry)' };
      }
      if (body.registry !== undefined) {
        if (body.name === undefined) {
          set.status = 400;
          return { error: 'A registry install names the package (name), and optionally its version' };
        }
        try {
          const { installFromRegistry } = await import('@/plugins/packages/registry-install');
          const row = await installFromRegistry(principal.userId, {
            registry: body.registry, name: body.name, version: body.version, upgrade: body.upgrade === true,
            allowSignerChange: body.allowSignerChange === true, allowDowngrade: body.allowDowngrade === true,
            allowSourceChange: body.allowSourceChange === true, allowIncompatible: body.allowIncompatible === true,
          });
          return {
            name: row.name, version: row.version, enabled: row.enabled, contentHash: row.contentHash, signedBy: row.signedBy,
            warnings: row.warnings, guidance: row.guidance, origin: row.origin, manifest: row.manifest,
          };
        } catch (err) {
          return refused(err, set);
        }
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
          : body.bundled !== undefined
            ? await installBundled(body.bundled, principal.userId, { upgrade })
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
        /** Or the name of a plugin shipped with Octipus (`GET /bundled`); installed like a directory, disabled. */
        bundled: t.Optional(t.String({ minLength: 2, maxLength: 50, pattern: '^[a-z][a-z0-9-]+$' })),
        /** Or a registry to install `name` (and `version`) from: "marketplace", or a name in plugins.registries. */
        registry: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
        /** An upgrade from another source than the installed version's (another registry, the marketplace): the admin's consent, audited. */
        allowSourceChange: t.Optional(t.Boolean()),
        /** A registry install of a version that asks for a newer Octipus (minOctipus): the admin's consent. */
        allowIncompatible: t.Optional(t.Boolean()),
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

  // The install consent (docs/PLUGIN-PACKAGES.md#installing-and-managing): download, verify and stage a
  // package without installing it, and answer with what it declares, item by item.
  .post(
    '/preview',
    async ({ user, principal, body, set }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;
      const sources = [body.path, body.url, body.bundled, body.registry].filter((v) => v !== undefined).length;
      if (sources !== 1) {
        set.status = 400;
        return { error: 'Give one of path, url (with sha256), bundled or registry (with name)' };
      }
      if (body.registry !== undefined && body.name === undefined) {
        set.status = 400;
        return { error: 'A registry preview names the package (name), and optionally its version' };
      }
      try {
        const { previewInstall } = await import('@/plugins/packages/consent');
        const source = body.registry !== undefined ? { registry: body.registry, name: body.name as string, version: body.version }
          : body.url !== undefined ? { url: body.url, sha256: body.sha256, name: body.name, version: body.version }
            : body.bundled !== undefined ? { bundled: body.bundled } : { path: body.path as string };
        return await previewInstall(source, principal.userId);
      } catch (err) {
        return refused(err, set);
      }
    },
    {
      body: t.Object({
        path: t.Optional(t.String({ minLength: 1, maxLength: 1000, pattern: '^(/|[A-Za-z]:\\\\)' })),
        bundled: t.Optional(t.String({ minLength: 2, maxLength: 50, pattern: '^[a-z][a-z0-9-]+$' })),
        registry: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
        url: t.Optional(t.String({ minLength: 9, maxLength: 2000, pattern: '^https://' })),
        sha256: t.Optional(t.String({ maxLength: 71, pattern: '^(sha256:)?[0-9a-fA-F]{64}$' })),
        name: t.Optional(t.String({ minLength: 1, maxLength: 50 })),
        version: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
      }),
      detail: { tags: ['plugin-packages'] },
    },
  )

  // Install a preview: only with every item not carried agreed to, for the content hash shown.
  .post(
    '/install',
    async ({ user, principal, body, set }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;
      try {
        const { installPreview } = await import('@/plugins/packages/consent');
        return await installPreview(body.previewId, { contentHash: body.contentHash, accepted: body.accepted, enable: body.enable === true }, principal.userId);
      } catch (err) {
        return refused(err, set);
      }
    },
    {
      body: t.Object({
        previewId: t.String({ minLength: 36, maxLength: 36 }),
        contentHash: t.String({ maxLength: 71, pattern: '^sha256:[0-9a-f]{64}$' }),
        accepted: t.Array(t.String({ maxLength: 400 }), { maxItems: 1000 }),
        enable: t.Optional(t.Boolean()),
      }),
      detail: { tags: ['plugin-packages'] },
    },
  )

  // The signed-in user's own use of each plugin (any user): the usage of every enabled package, and their running runs.
  .get(
    '/my-usage',
    async ({ principal, set, query }) => {
      if (!isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Authentication required' };
      }
      const { getDb } = await import('@/db/postgres');
      const { pluginPackages } = await import('@/db/schema/plugin-packages');
      const { eq } = await import('drizzle-orm');
      const { listRunningRuns } = await import('@/plugins/packages/host-agent');
      const rows = await getDb().select({ name: pluginPackages.name, manifest: pluginPackages.manifest }).from(pluginPackages).where(eq(pluginPackages.enabled, true));
      const out = [];
      for (const row of rows.sort((a, b) => a.name.localeCompare(b.name))) {
        const usage = await usageOf(row.name, query.days, principal.userId);
        const runs = await listRunningRuns(row.name, principal.userId);
        if (usage.modelCalls === 0 && usage.runs === 0 && runs.length === 0) continue;
        out.push({ name: row.name, title: row.manifest.title, usage, runs });
      }
      return out;
    },
    { query: USAGE_QUERY, detail: { tags: ['plugin-packages'] } },
  )

  // One plugin's tokens, spend, model calls and runs: every user's (admins).
  .get(
    '/:name/usage',
    async ({ user, principal, set, params, query }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;
      return usageOf(params.name, query.days, null);
    },
    { params: NAME_PARAM, query: USAGE_QUERY, detail: { tags: ['plugin-packages'] } },
  )

  // The same, for the signed-in user's own use only (any user).
  .get(
    '/:name/usage/me',
    async ({ principal, set, params, query }) => {
      if (!isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Authentication required' };
      }
      return usageOf(params.name, query.days, principal.userId);
    },
    { params: NAME_PARAM, query: USAGE_QUERY, detail: { tags: ['plugin-packages'] } },
  )

  // A plugin's running background runs: every user's (admins). Ids, role and title only.
  .get(
    '/:name/runs',
    async ({ user, principal, set, params, query }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;
      if (query.status !== undefined && query.status !== 'running') {
        set.status = 400;
        return { error: 'Only status=running is listed' };
      }
      const { listRunningRuns } = await import('@/plugins/packages/host-agent');
      return listRunningRuns(params.name);
    },
    { params: NAME_PARAM, query: t.Object({ status: t.Optional(t.String({ maxLength: 20 })) }), detail: { tags: ['plugin-packages'] } },
  )

  // The declarations of an installed package's content, to agree to before enabling it (an agent's install, say).
  .get(
    '/:name/consent',
    async ({ user, principal, set, params }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;
      try {
        const { consentView } = await import('@/plugins/packages/consent');
        return await consentView(params.name);
      } catch (err) {
        return refused(err, set);
      }
    },
    { params: NAME_PARAM, detail: { tags: ['plugin-packages'] } },
  )
  .post(
    '/:name/consent',
    async ({ user, principal, set, params, body }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;
      try {
        const { consentToInstalled } = await import('@/plugins/packages/consent');
        return await consentToInstalled(params.name, { contentHash: body.contentHash, accepted: body.accepted, enable: body.enable === true }, principal.userId);
      } catch (err) {
        return refused(err, set);
      }
    },
    {
      params: NAME_PARAM,
      body: t.Object({
        contentHash: t.String({ maxLength: 71, pattern: '^sha256:[0-9a-f]{64}$' }),
        accepted: t.Array(t.String({ maxLength: 400 }), { maxItems: 1000 }),
        enable: t.Optional(t.Boolean()),
      }),
      detail: { tags: ['plugin-packages'] },
    },
  )

  // Stop a plugin's background run from the app: the user who started it, or an admin (audited).
  .delete(
    '/:name/runs/:id',
    async ({ principal, set, params }) => {
      if (!isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Authentication required' };
      }
      const { cancelRunFromApp } = await import('@/plugins/packages/host-agent');
      const outcome = await cancelRunFromApp(params.name, params.id, { userId: principal.userId, isAdmin: isAdmin(principal) });
      if (!outcome.ok) {
        set.status = outcome.status;
        return { error: outcome.error, code: outcome.code };
      }
      const { auditRepository } = await import('@/db/repositories/audit-repository');
      await auditRepository.log({
        userId: principal.userId, action: 'settings_changed', resourceType: 'plugin_package', resourceId: params.name,
        details: { op: 'run_cancelled', runId: params.id, runUser: outcome.value.userId, byAdmin: outcome.value.userId !== principal.userId },
      });
      return { id: outcome.value.id, status: outcome.value.status };
    },
    { params: t.Object({ name: NAME_PARAM.properties.name, id: t.String({ maxLength: 64 }) }), detail: { tags: ['plugin-packages'] } },
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
        /**
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
