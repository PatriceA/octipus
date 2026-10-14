/**
 * The toolbox tools, by family. Each module under `collectors/`,
 * `transforms/`, `widgets/`, `exports/` exports a `ToolboxTool` value via
 * either a named or default export. Folder = family. Adding a tool is a file
 * plus one line in `MODULES`; `discovery.test.ts` fails if a file is missing
 * from it.
 *
 * This used to `readdirSync` its own directory and import each file by path.
 * Bundled, that directory is `dist/`, which has no family folders, so the
 * built server came up with an empty toolbox — the same failure
 * `src/tools/discovery.ts` and `src/channels/discovery.ts` hit. Imports a
 * bundler can see are the fix.
 */

import { coreLogger } from '@/utils/logger';
import { getToolboxRegistry } from './registry';
import type { ToolboxFamily, ToolboxTool } from './types';

export const MODULES: ReadonlyArray<{ family: ToolboxFamily; file: string; load: () => Promise<Record<string, unknown>> }> = [
  { family: 'collect', file: 'collectors/html-scrape', load: () => import('./collectors/html-scrape') },
  { family: 'collect', file: 'collectors/http-json', load: () => import('./collectors/http-json') },
  { family: 'collect', file: 'collectors/http-text', load: () => import('./collectors/http-text') },
  { family: 'collect', file: 'collectors/mcp', load: () => import('./collectors/mcp') },
  { family: 'collect', file: 'collectors/octipus-tool', load: () => import('./collectors/octipus-tool') },
  { family: 'collect', file: 'collectors/rss', load: () => import('./collectors/rss') },
  { family: 'transform', file: 'transforms/diff', load: () => import('./transforms/diff') },
  { family: 'transform', file: 'transforms/filter', load: () => import('./transforms/filter') },
  { family: 'transform', file: 'transforms/group_count', load: () => import('./transforms/group_count') },
  { family: 'transform', file: 'transforms/jsonpath', load: () => import('./transforms/jsonpath') },
  { family: 'transform', file: 'transforms/sort', load: () => import('./transforms/sort') },
  { family: 'transform', file: 'transforms/top_n', load: () => import('./transforms/top_n') },
  { family: 'widget', file: 'widgets/bar_chart', load: () => import('./widgets/bar_chart') },
  { family: 'widget', file: 'widgets/heatmap', load: () => import('./widgets/heatmap') },
  { family: 'widget', file: 'widgets/json_tree', load: () => import('./widgets/json_tree') },
  { family: 'widget', file: 'widgets/kpi_card', load: () => import('./widgets/kpi_card') },
  { family: 'widget', file: 'widgets/list', load: () => import('./widgets/list') },
  { family: 'widget', file: 'widgets/markdown', load: () => import('./widgets/markdown') },
  { family: 'widget', file: 'widgets/mermaid', load: () => import('./widgets/mermaid') },
  { family: 'widget', file: 'widgets/pie_chart', load: () => import('./widgets/pie_chart') },
  { family: 'widget', file: 'widgets/table', load: () => import('./widgets/table') },
  { family: 'export', file: 'exports/csv', load: () => import('./exports/csv') },
  { family: 'export', file: 'exports/json', load: () => import('./exports/json') },
  { family: 'export', file: 'exports/markdown', load: () => import('./exports/markdown') },
];

/** Idempotent — repeat calls are no-ops after the first. */
export async function discoverToolbox(): Promise<void> {
  const registry = getToolboxRegistry();
  if (registry.isLoaded()) return;

  for (const { family, file, load } of MODULES) {
    let mod: Record<string, unknown>;
    try {
      mod = await load();
    } catch (err) {
      coreLogger.error(
        { file, err: (err as Error).message },
        'toolbox.discovery.import_failed',
      );
      continue;
    }

    const tool = pickTool(mod, family);
    if (!tool) {
      coreLogger.debug({ file }, 'toolbox.discovery.no_export');
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
