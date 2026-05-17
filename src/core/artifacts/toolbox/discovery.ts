/**
 * Auto-discover toolbox tools from family folders. Each `.ts` file under
 * `collectors/`, `transforms/`, `widgets/`, `exports/` should export a
 * `ToolboxTool` value via either a named or default export. Folder = family.
 * No manual registration needed — drop a file in the right folder.
 */

import { readdirSync, statSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { coreLogger } from '@/utils/logger';
import { getToolboxRegistry } from './registry';
import type { ToolboxFamily, ToolboxTool } from './types';

const HERE = dirname(fileURLToPath(import.meta.url));

const FAMILY_FOLDERS: Record<string, ToolboxFamily> = {
  collectors: 'collect',
  transforms: 'transform',
  widgets: 'widget',
  exports: 'export',
};

/** Idempotent — repeat calls are no-ops after the first. */
export async function discoverToolbox(): Promise<void> {
  const registry = getToolboxRegistry();
  if (registry.isLoaded()) return;

  for (const [folder, family] of Object.entries(FAMILY_FOLDERS)) {
    const dir = resolve(HERE, folder);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      // Folder may not exist yet (phase 2/3 land); silent skip is fine.
      continue;
    }

    for (const file of entries) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
      const path = join(dir, file);
      let st;
      try { st = statSync(path); } catch { continue; }
      if (!st.isFile()) continue;

      let mod: Record<string, unknown>;
      try {
        mod = await import(path) as Record<string, unknown>;
      } catch (err) {
        coreLogger.error(
          { folder, file, err: (err as Error).message },
          'toolbox.discovery.import_failed',
        );
        continue;
      }

      const tool = pickTool(mod, family);
      if (!tool) {
        coreLogger.debug({ folder, file }, 'toolbox.discovery.no_export');
        continue;
      }

      try {
        registry.register(tool);
      } catch (err) {
        coreLogger.error(
          { id: tool.id, err: (err as Error).message },
          'toolbox.discovery.register_failed',
        );
      }
    }
  }

  registry.markLoaded();
  coreLogger.info(
    { count: registry.list().length },
    'toolbox.discovery.complete',
  );
}

function pickTool(mod: Record<string, unknown>, family: ToolboxFamily): ToolboxTool | null {
  // Prefer default export, fall back to first matching named export.
  const candidates: unknown[] = [];
  if ('default' in mod) candidates.push(mod.default);
  for (const [k, v] of Object.entries(mod)) {
    if (k === 'default') continue;
    candidates.push(v);
  }
  for (const c of candidates) {
    if (isToolboxTool(c) && c.family === family) return c;
  }
  return null;
}

function isToolboxTool(value: unknown): value is ToolboxTool {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.family === 'string' &&
    typeof v.description === 'string' &&
    typeof v.execute === 'function'
  );
}
