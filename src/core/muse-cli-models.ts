import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CliModelOption } from '@/shared/cli-capabilities';

/**
 * Muse Code's model catalog. `muse serve`'s `model/list` answers only from the
 * binary's bundled catalog, which ships empty (verified on 1.4.20, with and
 * without a session), so the live provider catalog that `muse exec` / the TUI
 * cache on disk is the only source. Octipus overrides XDG_CONFIG_HOME for runs,
 * never XDG_DATA_HOME, so every run refreshes this same cache.
 * ponytail: reads muse's private cache (schema_version 3); switch to `model/list` once serve returns the provider catalog.
 */
export function museCatalogDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'muse', 'model-catalog');
}

interface MuseCatalogRow { model_id?: unknown; display_label?: unknown; visibility?: unknown; is_default?: unknown }

export function parseMuseCatalog(text: string): CliModelOption[] {
  const rows = (JSON.parse(text) as { rows?: MuseCatalogRow[] }).rows;
  if (!Array.isArray(rows)) throw new Error('Muse model catalog has no rows');
  return rows
    .filter(r => r.visibility === 'visible' && typeof r.model_id === 'string' && r.model_id)
    .map(r => ({
      id: r.model_id as string,
      label: typeof r.display_label === 'string' && r.display_label ? r.display_label : r.model_id as string,
      ...(r.is_default === true ? { tier: 'default' } : {}),
    }));
}

/**
 * The newest usable catalog (one file per provider profile). A file muse is
 * rewriting, or one with no visible rows, falls through to the next newest.
 */
export async function discoverMuseModels(env: NodeJS.ProcessEnv = process.env): Promise<CliModelOption[]> {
  const dir = museCatalogDir(env);
  let names: string[] = [];
  try { names = readdirSync(dir).filter(f => f.endsWith('.json')); } catch { /* no cache yet */ }
  const files = names.flatMap(f => {
    const path = join(dir, f);
    try { return [{ path, mtime: statSync(path).mtimeMs }]; } catch { return []; }
  }).sort((a, b) => b.mtime - a.mtime);
  for (const { path } of files) {
    try {
      const models = parseMuseCatalog(readFileSync(path, 'utf8'));
      if (models.length) return models;
    } catch { /* partial write or foreign format: try the next */ }
  }
  throw new Error('Muse Code model catalog not cached yet. Run `muse exec` or the muse TUI once as the Octipus OS account, then retry.');
}
