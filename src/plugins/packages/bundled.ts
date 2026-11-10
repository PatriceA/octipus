/**
 * First-party plugins shipped with Octipus (docs/PLUGIN-PACKAGES.md#bundled-plugins):
 * package directories under `plugins/` at the root of the checkout or the
 * install. They are offered to admins (`GET /api/plugin-packages/bundled`,
 * Admin → Plugin packages → Bundled, `octi plugin bundled`) and installed
 * exactly like a package from a directory on the server: copied, hashed and
 * pinned, signature checked, installed **disabled**. Enabling one still needs
 * an admin to approve its host API scopes, as for any other package; shipping
 * with Octipus gives it no other trust.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { and, desc, eq, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { auditLog } from '@/db/schema/audit';
import { type PluginPackageRow, pluginPackages } from '@/db/schema/plugin-packages';
import { type BundledPluginView, PLUGIN_MANIFEST_FILE } from '@/shared/plugin-package';
import { octipusRoot } from '@/utils/install-root';
import { hashPackageContent } from './integrity';
import { installFromDirectory, PluginPackageError, readManifest } from './service';

const NAME_RE = /^[a-z][a-z0-9-]{1,49}$/;

let rootOverride: string | null = null;

/** Test-only: where the bundled plugins are. */
export function setBundledRoot(dir: string | null): void {
  rootOverride = dir;
}

/** The directory holding the bundled plugins: `<install>/plugins`. */
export function bundledRoot(): string {
  return rootOverride ?? join(octipusRoot(), 'plugins');
}

/** The directory of bundled plugin `name`, or null when there is none. */
export function bundledDir(name: string): string | null {
  if (!NAME_RE.test(name)) return null;
  const dir = join(bundledRoot(), name);
  return existsSync(join(dir, PLUGIN_MANIFEST_FILE)) ? dir : null;
}

/** Whether `name` is the name of a plugin shipped with Octipus: no other package (an agent's, an upload) may take it. */
export function isBundledName(name: string): boolean {
  return bundledDir(name) !== null;
}

/**
 * Whether the installed package `row` came from the bundle of the same name:
 * its last install or upgrade was recorded with source `bundled:<name>`, or its
 * files are the bundle's (same content hash). Anything else holding the name
 * is another package that took it.
 */
async function installedFromBundle(row: Pick<PluginPackageRow, 'name' | 'version' | 'contentHash'>, dir: string): Promise<boolean> {
  const [last] = await getDb().select({ details: auditLog.details }).from(auditLog)
    .where(and(eq(auditLog.resourceType, 'plugin_package'), eq(auditLog.resourceId, row.name),
      sql`${auditLog.details}->>'op' IN ('installed', 'upgraded')`))
    .orderBy(desc(auditLog.createdAt)).limit(1);
  if ((last?.details as { source?: unknown } | undefined)?.source === `bundled:${row.name}`) return true;
  if (!row.contentHash) return false;
  try {
    return (await hashPackageContent(dir, { name: row.name, version: row.version })) === row.contentHash;
  } catch {
    return false;
  }
}

/** Every bundled plugin, with the version installed here (or that another package holds its name). */
export async function listBundled(): Promise<BundledPluginView[]> {
  const root = bundledRoot();
  if (!existsSync(root)) return [];
  const rows = new Map((await getDb().select({ name: pluginPackages.name, version: pluginPackages.version, contentHash: pluginPackages.contentHash })
    .from(pluginPackages)).map((r) => [r.name, r]));
  const out: BundledPluginView[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = bundledDir(entry.name);
    if (!entry.isDirectory() || !dir) continue;
    const row = rows.get(entry.name);
    const ours = row ? await installedFromBundle(row, dir) : false;
    const state = { installed: row && ours ? row.version : null, ...(row && !ours ? { taken: true } : {}) };
    try {
      const m = await readManifest(dir);
      out.push({ name: m.name, version: m.version, title: m.title, description: m.description, host: [...(m.host ?? [])], network: [...(m.network ?? [])], ...state });
    } catch (err) {
      out.push({ name: entry.name, version: '', title: entry.name, description: '', host: [], network: [], ...state, problem: (err as Error).message });
    }
  }
  return out;
}

/**
 * Install (or with `upgrade`, upgrade to) the bundled plugin `name`, as an
 * install from its directory: pinned, signature checked, disabled. Refused
 * while another package holds the name: it is not upgraded into the bundle.
 */
export async function installBundled(name: string, actorUserId: string, opts: { upgrade?: boolean } = {}): Promise<PluginPackageRow & { warnings: string[] }> {
  const dir = bundledDir(name);
  if (!dir) throw new PluginPackageError('not_found', `No bundled plugin named ${JSON.stringify(name)}`);
  const [row] = await getDb().select().from(pluginPackages).where(eq(pluginPackages.name, name)).limit(1);
  if (row && !await installedFromBundle(row, dir)) {
    throw new PluginPackageError('conflict', `The name ${name} is taken by another package, not the bundled one; uninstall it first`);
  }
  return installFromDirectory(dir, actorUserId, { upgrade: opts.upgrade === true, expect: { name }, source: `bundled:${name}` });
}
