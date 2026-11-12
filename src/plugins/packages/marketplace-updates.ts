/**
 * The update check (docs/PLUGIN-PACKAGES.md#updates): installed packages
 * that have a newer version installable here, from the SAME source they
 * were installed from (their provenance, `origin`): the marketplace, or the
 * same named registry. A package installed from a directory, a URL or the
 * bundled plugins has no source to check.
 *
 * Each update carries a permissions diff: the installed version's
 * permissions recomputed from its installed manifest, against the new
 * listing's. Admins are notified once per new version (across instances,
 * `plugin_update_notices`), daily from the cron tick. Upgrades are never
 * automatic: an upgrade clears the approvals by design.
 */
import { getDb } from '@/db/postgres';
import { pluginPackages, pluginUpdateNotices } from '@/db/schema/plugin-packages';
import type { PluginGuidanceWarning } from '@/shared/plugin-declarations';
import { permissionsGuidance } from '@/shared/plugin-declarations';
import type { PluginUpdateView } from '@/shared/plugin-package';
import { diffPermissions } from '@/shared/plugin-permissions';
import { coreLogger } from '@/utils/logger';
import { getAppVersion } from '@/utils/version';
import { MARKETPLACE_REGISTRY } from './marketplace-config';
import { newestInstallable, revokedVersions, sourceByName } from './marketplace';
import { packagePermissions } from './permissions';
import { readIndex } from './remote';
import { notifyAdmins } from './revocation-effects';
import { compareVersions, packageDir } from './service';

/** How often the check runs from the cron tick. */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60_000;

/** Every installed package with a newer version from its own source. */
export async function listUpdates(): Promise<PluginUpdateView[]> {
  const rows = await getDb().select().from(pluginPackages);
  const revoked = await revokedVersions();
  const appVersion = getAppVersion();
  const indexes = new Map<string, Awaited<ReturnType<typeof readIndex>> | null>();
  const out: PluginUpdateView[] = [];
  for (const row of rows) {
    const source = row.origin?.source;
    const registry = source === 'marketplace' ? MARKETPLACE_REGISTRY : source?.startsWith('registry:') ? source.slice('registry:'.length) : null;
    if (registry === null) continue;
    if (!indexes.has(registry)) {
      const found = await sourceByName(registry);
      indexes.set(registry, 'error' in found ? null : await readIndex(found.source, found.hooks));
    }
    const listed = indexes.get(registry)?.fetched?.index.entries.filter((e) => e.name === row.name) ?? [];
    // The marketplace's revocations hold back its own versions only.
    const latest = newestInstallable(listed, registry === MARKETPLACE_REGISTRY ? revoked : new Map(), appVersion);
    if (!latest || compareVersions(latest.version, row.version) <= 0) continue;
    const diff = latest.permissions ? diffPermissions(await packagePermissions(row.manifest, packageDir(row.name)), latest.permissions) : null;
    const warnings: PluginGuidanceWarning[] = [
      ...(diff?.widened ? [{ code: 'widens', message: `This version asks for more: ${diff.changes.filter((c) => c.widens).map((c) => c.text).join('; ')}` }] : []),
      ...(diff === null ? [{ code: 'no_permissions_listed', message: 'The registry does not list what this version asks for; read its manifest after upgrading, before enabling it.' }] : []),
      ...(latest.permissions ? permissionsGuidance(latest.permissions) : []),
      { code: 'consent', message: 'Upgrading asks you to agree to what is new or changed; what is unchanged and you agreed to before carries over. It lands disabled unless you enable it after the upgrade.' },
    ];
    out.push({ name: row.name, installed: row.version, latest: latest.version, registry, diff, warnings });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Notify the admins of each update not notified before (once per name and version). Returns how many were new. */
export async function notifyUpdates(updates?: PluginUpdateView[]): Promise<number> {
  let sent = 0;
  for (const u of updates ?? await listUpdates()) {
    const fresh = await getDb().insert(pluginUpdateNotices).values({ name: u.name, version: u.latest }).onConflictDoNothing().returning();
    if (fresh.length === 0) continue;
    sent++;
    const changes = u.diff === null ? 'its permissions are not listed' : u.diff.changes.length === 0 ? 'it asks for nothing new' : u.diff.changes.map((c) => `${c.change} ${c.text}`).join('; ');
    await notifyAdmins('plugin_update', `Plugin update: ${u.name} ${u.latest}`,
      `${u.name} ${u.latest} is available from ${u.registry === MARKETPLACE_REGISTRY ? 'the Octipus marketplace' : u.registry} (installed: ${u.installed}). Permissions: ${changes}. Upgrades are never automatic.`,
      { name: u.name, installed: u.installed, latest: u.latest, registry: u.registry, widened: u.diff?.widened ?? null });
  }
  return sent;
}

let lastRun = 0;
let running = false;

/** The cron tick's check: at most once a day per process; never throws. */
export async function maybeRunUpdateCheck(now = Date.now()): Promise<void> {
  if (running || now - lastRun < UPDATE_CHECK_INTERVAL_MS) return;
  running = true;
  lastRun = now;
  try {
    const sent = await notifyUpdates();
    if (sent > 0) coreLogger.info({ sent }, 'plugin updates: admins notified');
  } catch (err) {
    coreLogger.error({ err }, 'plugin updates: the daily check failed');
  } finally {
    running = false;
  }
}

let tickRunning = false;
let lastFreshness = 0;
/** How often the freshness check (a stale index or keys.json) runs from the cron tick. */
const FRESHNESS_CHECK_INTERVAL_MS = 60 * 60_000;

/**
 * The cron tick's revocation catch-up (every tick, every instance): the
 * revocations in force whose effects have not run in this process yet are
 * applied here (another instance stored them), and, hourly, the admins are
 * told when the marketplace's last accepted index or keys.json is more than
 * 7 days old. Never throws.
 */
export async function maybeRunRevocationTick(now = Date.now()): Promise<void> {
  if (tickRunning) return;
  tickRunning = true;
  try {
    const { catchUpRevocations } = await import('./revocation-effects');
    await catchUpRevocations();
    if (now - lastFreshness >= FRESHNESS_CHECK_INTERVAL_MS) {
      lastFreshness = now;
      const { currentMarketplace } = await import('./marketplace-config');
      const settings = currentMarketplace();
      if (settings.state === 'ready') {
        const { marketplaceFreshness, notifyStale } = await import('./marketplace');
        await notifyStale(await marketplaceFreshness(settings, now));
      }
    }
  } catch (err) {
    coreLogger.error({ err }, 'plugin marketplace: the revocation catch-up failed');
  } finally {
    tickRunning = false;
  }
}

/** Test-only. */
export function _resetUpdateCheck(): void {
  tickRunning = false;
  lastFreshness = 0;
  lastRun = 0;
  running = false;
}
