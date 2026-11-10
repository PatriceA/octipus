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
import { getDb } from '@/db/postgres';
import { type PluginPackageRow, pluginPackages } from '@/db/schema/plugin-packages';
import { type BundledPluginView, PLUGIN_MANIFEST_FILE } from '@/shared/plugin-package';
import { octipusRoot } from '@/utils/install-root';
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

/** Every bundled plugin, with the version installed here. */
export async function listBundled(): Promise<BundledPluginView[]> {
  const root = bundledRoot();
  if (!existsSync(root)) return [];
  const installed = new Map((await getDb().select({ name: pluginPackages.name, version: pluginPackages.version }).from(pluginPackages))
    .map((r) => [r.name, r.version]));
  const out: BundledPluginView[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !bundledDir(entry.name)) continue;
    try {
      const m = await readManifest(join(root, entry.name));
      out.push({
        name: m.name, version: m.version, title: m.title, description: m.description,
        host: [...(m.host ?? [])], network: [...(m.network ?? [])], installed: installed.get(m.name) ?? null,
      });
    } catch (err) {
      out.push({
        name: entry.name, version: '', title: entry.name, description: '', host: [], network: [], installed: installed.get(entry.name) ?? null,
        problem: (err as Error).message,
      });
    }
  }
  return out;
}

/**
 * Install (or with `upgrade`, upgrade to) the bundled plugin `name`, as an
 * install from its directory: pinned, signature checked, disabled.
 */
export async function installBundled(name: string, actorUserId: string, opts: { upgrade?: boolean } = {}): Promise<PluginPackageRow & { warnings: string[] }> {
  const dir = bundledDir(name);
  if (!dir) throw new PluginPackageError('not_found', `No bundled plugin named ${JSON.stringify(name)}`);
  return installFromDirectory(dir, actorUserId, { upgrade: opts.upgrade === true, expect: { name }, source: `bundled:${name}` });
}
