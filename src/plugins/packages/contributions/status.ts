/**
 * The last run of each schedule, event and context contribution of a
 * package, for its row on the admin page. Kept in memory and written through
 * to the shared key-value store, so the instance that serves the page sees a
 * run another instance made. A store that cannot be reached costs only that.
 */
import type { PluginContributionRun } from '@/shared/plugin-package';
import { coreLogger } from '@/utils/logger';

const STATUS_PREFIX = 'plugin-contrib-runs:';
const STATUS_TTL_SECONDS = 30 * 24 * 3600;
/** Error text kept per run. */
const MAX_ERROR_CHARS = 500;

type Runs = Record<string, PluginContributionRun>;
const local = new Map<string, Runs>();

async function storage() {
  try {
    const { getStorageProvider } = await import('@/db/storage');
    return getStorageProvider();
  } catch {
    return null;
  }
}

/** Record a run of `key` (`schedule:<id>`, `event:<on>:<tool>`, `context`). Never throws. */
export async function recordRun(pkg: string, key: string, ok: boolean, error: string | null = null): Promise<void> {
  const run: PluginContributionRun = { at: new Date().toISOString(), ok, error: error === null ? null : error.slice(0, MAX_ERROR_CHARS) };
  const runs = local.get(pkg) ?? {};
  runs[key] = run;
  local.set(pkg, runs);
  const store = await storage();
  if (!store) return;
  try {
    const shared = await readShared(pkg);
    await store.setRaw(`${STATUS_PREFIX}${pkg}`, JSON.stringify({ ...shared, [key]: run }), STATUS_TTL_SECONDS);
  } catch (err) {
    coreLogger.debug({ err, pkg }, 'Plugin contribution status not shared');
  }
}

async function readShared(pkg: string): Promise<Runs> {
  const store = await storage();
  if (!store) return {};
  try {
    const raw = await store.getRaw(`${STATUS_PREFIX}${pkg}`);
    return raw ? (JSON.parse(raw) as Runs) : {};
  } catch {
    return {};
  }
}

/** The last run of `key`, here or on another instance, whichever is newer. */
export async function lastRuns(pkg: string): Promise<Runs> {
  const shared = await readShared(pkg);
  const merged: Runs = { ...shared };
  for (const [key, run] of Object.entries(local.get(pkg) ?? {})) {
    if (!merged[key] || merged[key].at < run.at) merged[key] = run;
  }
  return merged;
}

/** The last run recorded in this process (no store read): for a caller deciding whether to record a recovery. */
export function lastLocalRun(pkg: string, key: string): PluginContributionRun | null {
  return local.get(pkg)?.[key] ?? null;
}

/** Forget a package's runs (uninstalled). */
export async function forgetRuns(pkg: string): Promise<void> {
  local.delete(pkg);
  const store = await storage();
  await store?.delRaw(`${STATUS_PREFIX}${pkg}`).catch(() => {});
}
