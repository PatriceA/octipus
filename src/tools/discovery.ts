import { readdirSync, statSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { toolLogger } from '@/utils/logger';
import { BaseTool } from './base-tool';

const HERE = dirname(fileURLToPath(import.meta.url));

export interface DiscoveredTool {
  folder: string;
  tool: BaseTool;
}

/**
 * Auto-discover tool folders under `src/tools/<name>/`.
 *
 * Convention (matches the roles drop-folder pattern):
 *
 *   src/tools/<name>/index.ts   — exports any of:
 *     • a singleton instance of a BaseTool subclass (preferred), or
 *     • a default-exported BaseTool subclass that the loader will `new`
 *
 * The first BaseTool instance found in the module is used. Folders with
 * no matching export are skipped silently — they may be type-only or
 * helper modules (e.g. `shell/operations.ts` lives under `shell/`).
 *
 * Adding a new tool is now: drop a folder with `index.ts` exporting a tool
 * instance — no edit of `tools/index.ts` required.
 */
export async function discoverTools(): Promise<DiscoveredTool[]> {
  const found: DiscoveredTool[] = [];
  const entries = readdirSync(HERE);

  for (const name of entries) {
    const dir = resolve(HERE, name);
    let st;
    try { st = statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;

    const indexPath = resolve(dir, 'index.ts');
    let mod: Record<string, unknown>;
    try {
      mod = await import(indexPath) as Record<string, unknown>;
    } catch (err) {
      toolLogger.warn({ folder: name, err }, 'tool discovery: failed to import — skipping');
      continue;
    }

    const tool = pickTool(mod);
    if (tool) {
      found.push({ folder: name, tool });
    } else {
      toolLogger.debug({ folder: name }, 'tool discovery: no BaseTool export — skipping');
    }
  }

  return found;
}

function pickTool(mod: Record<string, unknown>): BaseTool | null {
  // Prefer the conventional `<name>Tool` singleton instance over class exports.
  for (const value of Object.values(mod)) {
    if (value instanceof BaseTool) return value;
  }
  // Default-exported class that needs constructing (e.g. VoiceCallTool).
  const def = (mod as { default?: unknown }).default;
  if (typeof def === 'function') {
    try {
      const inst = new (def as new () => unknown)();
      if (inst instanceof BaseTool) return inst;
    } catch {
      // not constructible without args — skip
    }
  }
  // Fall back: any class export whose name ends with "Tool" and is constructible.
  for (const [key, value] of Object.entries(mod)) {
    if (typeof value !== 'function' || !key.endsWith('Tool')) continue;
    try {
      const inst = new (value as new () => unknown)();
      if (inst instanceof BaseTool) return inst;
    } catch {
      // skip
    }
  }
  return null;
}
