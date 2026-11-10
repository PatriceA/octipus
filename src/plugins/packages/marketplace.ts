/**
 * The built-in Octipus marketplace on the host (docs/PLUGIN-PACKAGES.md#marketplace):
 * reading its signed index, applying its revocations, and the listing the
 * admin's Marketplace page shows.
 *
 * The marketplace is a registry with rules of its own:
 *
 * - **Configured or off.** Without real root keys (./marketplace-keys.ts
 *   holds placeholders until a build ships them, or `plugins.marketplace`
 *   gives some) it is never fetched and nothing installs from it.
 * - **Its own trust anchor.** The root keys sign only keys.json, which
 *   endorses the signing keys (./marketplace-keys-file.ts). The index must be
 *   signed by an endorsed signing key, and only those (not
 *   `plugins.trustedPublishers`); index v2 only; every tarball on its own
 *   origin. The signing keys are trusted for packages installed from it,
 *   never for any other install.
 * - **Online revocation.** The package revocations of an index verified by
 *   an endorsed signing key are stored and applied on this host
 *   (./revocations.ts); key revocations come from keys.json. Revocations
 *   accumulate; the rollback check (./registry-state.ts) refuses an index
 *   older than the last one accepted, and listing pins (./listing-pins.ts)
 *   refuse a published version whose content changed.
 *
 * Every byte of the index, its signature and the stats file is treated as
 * hostile until checked (./index-v2.ts).
 */
import { eq } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { pluginMarketplaceKeys, pluginPackages, pluginUpdateNotices } from '@/db/schema/plugin-packages';
import { declarationItems, type PluginGuidanceWarning, permissionsGuidance } from '@/shared/plugin-declarations';
import type {
  MarketplaceListing, MarketplacePluginView, MarketplaceStaleFile, MarketplaceVersionView, PluginCompatibility, PluginOrigin,
} from '@/shared/plugin-package';
import { foldForSearch, permissionsAskSummary } from '@/shared/plugin-permissions';
import { coreLogger } from '@/utils/logger';
import { getAppVersion } from '@/utils/version';
import type { IndexEntry } from './index-v2';
import { IndexFormatError } from './index-v2';
import { apiVersionProblem } from './manifest';
import {
  currentMarketplace, MARKETPLACE_OFF_MESSAGE, MARKETPLACE_REGISTRY, MARKETPLACE_UNCONFIGURED_MESSAGE, type MarketplaceSettings,
} from './marketplace-config';
import { MARKETPLACE_PUBLISHER } from './marketplace-keys';
import { marketplaceSigningKeys } from './marketplace-keys-file';
import { applyNewRevocations, catchUpRevocations, notifyAdmins } from './revocation-effects';
import { activeRevocations, recordRevocations } from './revocations';
import { lastIndexTime } from './registry-state';
import { configuredRegistries, type FetchedIndex, type IndexHooks, mapBounded, REGISTRY_FETCH_CONCURRENCY, readIndex, type RegistrySource } from './remote';
import { compareVersions } from './service';

/**
 * The marketplace as a registry source: its index must be signed by one of
 * the signing keys its root-signed keys.json endorses now (./marketplace-keys-file.ts).
 * `{ error }` while it is off, unconfigured, or its keys cannot be verified.
 */
export async function marketplaceSource(settings: MarketplaceSettings = currentMarketplace()): Promise<RegistrySource | { error: string }> {
  if (settings.state === 'off') return { error: MARKETPLACE_OFF_MESSAGE };
  if (settings.state === 'unconfigured') return { error: MARKETPLACE_UNCONFIGURED_MESSAGE };
  const keys = await marketplaceSigningKeys(settings);
  if ('error' in keys) return { error: `The Octipus marketplace is unavailable: ${keys.error}` };
  if (keys.publishers.length === 0) return { error: 'The Octipus marketplace is unavailable: its keys.json endorses no signing key that is trusted now' };
  return { name: MARKETPLACE_REGISTRY, url: settings.url, publisher: MARKETPLACE_PUBLISHER, publishers: keys.publishers, strict: true, marketplace: true };
}

/**
 * The marketplace's index rules, as hooks of the generic index reader: the
 * index must be signed (by an endorsed signing key: checked by the reader),
 * and its package revocations are stored and applied. Key revocations live
 * in keys.json; an index's `revoked` key entries are ignored.
 */
export function marketplaceHooks(settings: MarketplaceSettings = currentMarketplace()): IndexHooks {
  return {
    distrust: async (fetched: FetchedIndex) => {
      if (fetched.signedBy === null) throw new IndexFormatError('The marketplace index is not signed');
      if (fetched.index.revoked.keys.length > 0) coreLogger.info({ count: fetched.index.revoked.keys.length }, 'plugin marketplace: key revocations in the index are ignored (they live in keys.json)');
      return [];
    },
    accepted: async (fetched: FetchedIndex) => {
      const { index } = fetched;
      if (index.generatedAt === null || fetched.signedBy === null || settings.state !== 'ready') return;
      const added = await recordRevocations(
        index.revoked.packages.map((p) => ({ kind: 'package' as const, name: p.name, version: p.version, reason: p.reason })),
        { registryUrl: settings.url, signedByKey: fetched.signedBy, indexGeneratedAt: index.generatedAt },
      );
      await applyNewRevocations(added);
      // What another instance stored since this process last looked.
      await catchUpRevocations();
    },
  };
}

/** A registry source by the name an install or listing uses (`marketplace`, or one of `plugins.registries`), with its hooks. */
export async function sourceByName(name: string): Promise<{ source: RegistrySource; hooks: IndexHooks } | { error: string }> {
  if (name === MARKETPLACE_REGISTRY) {
    const settings = currentMarketplace();
    const source = await marketplaceSource(settings);
    if ('error' in source) return source;
    return { source, hooks: marketplaceHooks(settings) };
  }
  const source = configuredRegistries().find((r) => r.name === name);
  return source ? { source, hooks: {} } : { error: `No registry named "${name}" in plugins.registries` };
}

/** The `origin.source` of an install from a registry. */
export function originSource(registry: string): PluginOrigin['source'] {
  return registry === MARKETPLACE_REGISTRY ? 'marketplace' : `registry:${registry}`;
}

/** Whether a listed version can run here: its plugin API, the Octipus version it needs, and (marketplace) its runtime. */
export function compatibility(e: Pick<IndexEntry, 'apiVersion' | 'minOctipus' | 'permissions' | 'registry'>, appVersion = getAppVersion()): PluginCompatibility {
  if (e.apiVersion !== null) {
    const problem = apiVersionProblem(e.apiVersion);
    if (problem) return { ok: false, reason: problem };
  }
  if (e.minOctipus !== null && compareVersions(appVersion, e.minOctipus) < 0) {
    return { ok: false, reason: `Needs Octipus ${e.minOctipus} or newer (this is ${appVersion})` };
  }
  if (e.registry === MARKETPLACE_REGISTRY && e.permissions?.runtime === 'in-process') {
    return { ok: false, reason: 'The marketplace carries sandboxed packages only; an in-process plugin is a local install' };
  }
  return { ok: true, reason: null };
}

/**
 * Revoked versions in force, `name@version` → reason. They are the
 * marketplace's: they apply to its listings and installs only, never to
 * another registry's (callers pass an empty map for those).
 */
export async function revokedVersions(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const r of await activeRevocations()) if (r.kind === 'package' && r.name && r.version) out.set(`${r.name}@${r.version}`, r.reason || 'revoked');
  return out;
}

/** The newest version of `entries` (one plugin, any order) that can be installed here: compatible, not revoked, not deprecated. */
export function newestInstallable(entries: readonly IndexEntry[], revoked: ReadonlyMap<string, string>, appVersion = getAppVersion()): IndexEntry | null {
  const sorted = [...entries].sort((a, b) => compareVersions(b.version, a.version));
  return sorted.find((e) => compatibility(e, appVersion).ok && !revoked.has(`${e.name}@${e.version}`) && e.deprecated === null) ?? null;
}

/** The host URL a listing image is served from (the asset proxy, ./marketplace-assets.ts). */
export function assetProxyUrl(url: string): string {
  return `/api/plugin-packages/marketplace/asset?url=${encodeURIComponent(url)}`;
}

function matches(p: MarketplacePluginView, q: string | undefined, category: string | undefined): boolean {
  if (category && foldForSearch(p.category ?? '') !== foldForSearch(category)) return false;
  if (!q || q.trim() === '') return true;
  const hay = foldForSearch([p.name, p.title, p.summary, p.description, p.category ?? '', ...p.tags, p.author?.name ?? '', p.publisher ?? ''].join('\n'));
  return foldForSearch(q).split(/\s+/).filter(Boolean).every((word) => hay.includes(word));
}

/** One plugin's card from its listed versions (all of one registry and name). */
function pluginView(
  entries: IndexEntry[], installed: { version: string; origin: PluginOrigin | null } | undefined,
  revokedInForce: ReadonlyMap<string, string>, downloads: number | null, appVersion: string,
): MarketplacePluginView {
  const sorted = [...entries].sort((a, b) => compareVersions(b.version, a.version));
  const newest = sorted[0];
  // The marketplace's revocations are about its own packages: another registry's card is never marked by them.
  const revoked: ReadonlyMap<string, string> = newest.registry === MARKETPLACE_REGISTRY ? revokedInForce : new Map();
  const latest = newestInstallable(sorted, revoked, appVersion);
  const shown = latest ?? newest;
  const registry = newest.registry;
  const versions: MarketplaceVersionView[] = sorted.map((e) => ({
    version: e.version, publishedAt: e.publishedAt, sha256: e.sha256, contentHash: e.contentHash, apiVersion: e.apiVersion, minOctipus: e.minOctipus,
    compatibility: compatibility(e, appVersion), revoked: revoked.get(`${e.name}@${e.version}`) ?? null,
  }));
  // Listing text rides the newest entry (index v2 puts README and CHANGELOG there).
  const text = (pick: (e: IndexEntry) => string | null) => sorted.map(pick).find((v) => v !== null) ?? null;
  const sameSource = installed !== undefined && installed.origin?.source === originSource(registry);
  const updateAvailable = sameSource && latest !== null && compareVersions(latest.version, installed.version) > 0 ? latest.version : null;
  const installedRevoked = installed && installed.origin?.source === 'marketplace' ? revoked.get(`${newest.name}@${installed.version}`) ?? null : null;
  const allRevoked = sorted.every((e) => revoked.has(`${e.name}@${e.version}`)) ? revoked.get(`${newest.name}@${newest.version}`) ?? null : null;
  const warnings: PluginGuidanceWarning[] = [
    ...(shown.permissions ? permissionsGuidance(shown.permissions) : [{ code: 'no_permissions_listed', message: 'This registry does not list what the package asks for (index v1); read its manifest after installing, before enabling it.' }]),
    ...(newest.deprecated ? [{ code: 'deprecated', message: `Deprecated: ${newest.deprecated}` }] : []),
    ...(installed && !sameSource ? [{ code: 'source_change', message: `The installed version came from ${installed.origin?.source ?? 'an install made before provenance was recorded'}; installing this one changes its source (you will be asked to confirm).` }] : []),
    ...(installedRevoked ? [{ code: 'installed_revoked', message: `The installed version is revoked: ${installedRevoked}` }] : []),
  ];
  return {
    registry,
    name: newest.name,
    title: shown.title ?? newest.name,
    summary: shown.summary ?? '',
    description: shown.description ?? '',
    category: shown.category,
    tags: shown.tags,
    author: shown.author,
    homepage: shown.homepage,
    license: shown.license,
    publisher: shown.publisher,
    icon: shown.icon ? assetProxyUrl(shown.icon) : null,
    screenshots: shown.screenshots.map(assetProxyUrl),
    readme: text((e) => e.readme),
    changelog: text((e) => e.changelog),
    latest: latest?.version ?? null,
    versions,
    permissions: shown.permissions,
    askSummary: shown.permissions ? permissionsAskSummary(shown.permissions) : [],
    declarations: shown.permissions ? declarationItems(shown.permissions) : [],
    warnings,
    compatibility: latest ? { ok: true, reason: null } : compatibility(newest, appVersion).ok ? { ok: false, reason: 'No version can be installed here (revoked or deprecated)' } : compatibility(newest, appVersion),
    installedVersion: installed?.version ?? null,
    installedOrigin: installed?.origin ?? null,
    updateAvailable,
    revoked: installedRevoked ?? allRevoked,
    deprecated: newest.deprecated,
    downloads,
  };
}

/**
 * The Marketplace page's data (`GET /api/plugin-packages/marketplace`): the
 * marketplace's plugins (when it is configured and its index verifies) and
 * those of `plugins.registries`, one card per registry and name, with
 * compatibility, installed state, updates, revocations and the
 * (display-only) download counts. `q` and `category` filter, matched without
 * case or diacritics.
 */
export async function marketplaceListing(filter: { q?: string; category?: string } = {}): Promise<MarketplaceListing> {
  const settings = currentMarketplace();
  const errors: MarketplaceListing['errors'] = [];
  let state: MarketplaceListing['state'] = settings.state === 'ready' ? 'ready' : settings.state;
  let message: string | null = settings.state === 'off' ? MARKETPLACE_OFF_MESSAGE : settings.state === 'unconfigured' ? MARKETPLACE_UNCONFIGURED_MESSAGE : null;
  let generatedAt: string | null = null;
  const entries: IndexEntry[] = [];
  const source = settings.state === 'ready' ? await marketplaceSource(settings) : null;
  if (source && 'error' in source) {
    state = 'error';
    message = source.error;
    errors.push({ registry: MARKETPLACE_REGISTRY, error: source.error });
  }
  const mp = source && !('error' in source) ? source : null;
  const reads = await mapBounded<{ source: RegistrySource; hooks: IndexHooks }, { source: RegistrySource; result: Awaited<ReturnType<typeof readIndex>> }>(
    [...(mp ? [{ source: mp, hooks: marketplaceHooks(settings) }] : []), ...configuredRegistries().map((r) => ({ source: r, hooks: {} }))],
    REGISTRY_FETCH_CONCURRENCY, async ({ source: s, hooks }) => ({ source: s, result: await readIndex(s, hooks) }),
  );
  for (const { source: registry, result } of reads) {
    const name = registry.marketplace ? MARKETPLACE_REGISTRY : registry.name;
    if (result.fetched) {
      entries.push(...result.fetched.index.entries);
      // Entries refused because they replace a published version: listed as such, the rest of the index kept.
      for (const c of result.fetched.replaced) errors.push({ registry: name, error: `${c.name} ${c.version}: replaced: refused (pinned ${c.pinned}, now listed as ${c.listed})` });
      if (registry.marketplace) generatedAt = result.fetched.index.generatedAt?.toISOString() ?? null;
    } else if (registry.marketplace) {
      state = 'error';
      message = `The Octipus marketplace could not be read: ${result.error ?? 'unknown error'}`;
    }
    if (result.error && !(result.fetched && result.fetched.replaced.length > 0 && result.fetched.index.entries.length === 0)) errors.push({ registry: name, error: result.error });
  }
  const stale = settings.state === 'ready' ? await marketplaceFreshness(settings) : [];
  if (stale.length > 0) await notifyStale(stale).catch((err: unknown) => coreLogger.error({ err }, 'plugin marketplace: could not notify about a stale marketplace'));
  const installed = new Map((await getDb().select({ name: pluginPackages.name, version: pluginPackages.version, origin: pluginPackages.origin }).from(pluginPackages))
    .map((r) => [r.name, { version: r.version, origin: r.origin ?? null }]));
  const revoked = await revokedVersions();
  const { marketplaceDownloads } = await import('./marketplace-assets');
  const downloads = mp ? await marketplaceDownloads(mp.url) : null;
  const groups = new Map<string, IndexEntry[]>();
  for (const e of entries) {
    const key = `${e.registry}\n${e.name}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const appVersion = getAppVersion();
  const plugins = [...groups.values()]
    .map((group) => pluginView(group, installed.get(group[0].name), revoked, group[0].registry === MARKETPLACE_REGISTRY ? downloads?.get(group[0].name) ?? null : null, appVersion))
    .sort((a, b) => (a.registry === b.registry ? a.title.localeCompare(b.title) : a.registry === MARKETPLACE_REGISTRY ? -1 : b.registry === MARKETPLACE_REGISTRY ? 1 : a.registry.localeCompare(b.registry)));
  const categories = [...new Set(plugins.map((p) => p.category).filter((c): c is string => c !== null))].sort();
  return { state, message, generatedAt, plugins: plugins.filter((p) => matches(p, filter.q, filter.category)), categories, errors, stale };
}

/** How old the last accepted index or keys.json may be before the admins are warned (a freeze attack, or a marketplace that stopped publishing). */
export const STALE_AFTER_MS = 7 * 24 * 60 * 60_000;

/**
 * The marketplace's files whose last accepted version is older than
 * `STALE_AFTER_MS`: a host kept on an old index (a mirror or a man in the
 * middle replaying it) would miss revocations. Shown as a banner; the admins
 * are notified once per stale file version.
 */
export async function marketplaceFreshness(settings: Extract<MarketplaceSettings, { state: 'ready' }>, now = Date.now()): Promise<MarketplaceStaleFile[]> {
  const out: MarketplaceStaleFile[] = [];
  const [keys] = await getDb().select({ generatedAt: pluginMarketplaceKeys.generatedAt }).from(pluginMarketplaceKeys).where(eq(pluginMarketplaceKeys.registryUrl, settings.url)).limit(1);
  const index = await lastIndexTime(settings.url);
  for (const [file, at] of [['keys.json', keys?.generatedAt ?? null], ['index', index]] as const) {
    if (at === null || now - at.getTime() <= STALE_AFTER_MS) continue;
    const days = Math.floor((now - at.getTime()) / 86_400_000);
    out.push({
      file, generatedAt: at.toISOString(),
      message: `The last ${file === 'index' ? 'marketplace index' : 'marketplace keys.json'} accepted here was generated ${days} days ago (${at.toISOString()}). Revocations published since may not have reached this host: check that it can reach the marketplace, and that the marketplace still publishes.`,
    });
  }
  return out;
}

/** Notify the admins of each stale file once per version (across instances, through `plugin_update_notices`). */
export async function notifyStale(stale: readonly MarketplaceStaleFile[]): Promise<void> {
  for (const s of stale) {
    const fresh = await getDb().insert(pluginUpdateNotices).values({ name: `marketplace:stale:${s.file}`, version: s.generatedAt }).onConflictDoNothing().returning();
    if (fresh.length === 0) continue;
    await notifyAdmins('plugin_marketplace_stale', `Plugin marketplace: the ${s.file} is out of date`, s.message, { file: s.file, generatedAt: s.generatedAt });
  }
}
