/**
 * Plugin package pages (docs/PLUGIN-PACKAGES.md#pages): the pages the enabled
 * packages add (`GET /api/plugin-ui`), and the shape of the postMessage bridge
 * a page's sandboxed frame talks to.
 *
 * A page asks its parent (this app) to call one of its own package's tools:
 *
 *   parent.postMessage({ octipus: 'call', id: 1, tool: 'list_items', args: {} }, '*')
 *
 * and gets back, from the parent:
 *
 *   { octipus: 'result', id: 1, ok: true, result }            // the MCP tool result
 *   { octipus: 'result', id: 1, ok: false, error, code }      // refused or failed
 *
 * The parent checks that a message comes from the page's own frame (its
 * window, and the opaque origin "null" a sandboxed frame has), that it has
 * exactly this shape, and calls `POST /api/plugins/<name>/call/<tool>` as the
 * signed-in user — never another package's tool.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { PluginPageLink } from '../../src/shared/plugin-package';

export type { PluginPageLink } from '../../src/shared/plugin-package';

export const PLUGIN_PAGES_KEY = ['plugin-pages'] as const;

/** The pages of the enabled packages; refreshed every minute and on focus. */
export function usePluginPages(enabled = true) {
  return useQuery({
    queryKey: PLUGIN_PAGES_KEY,
    enabled,
    queryFn: async () => (await api.get<{ pages: PluginPageLink[] }>('/plugin-ui')).pages ?? [],
    refetchInterval: 60_000,
    retry: false,
  });
}

/** The app route of a page. */
export function pluginPageHref(page: Pick<PluginPageLink, 'plugin' | 'path'>): string {
  return `/plugins/${encodeURIComponent(page.plugin)}/${page.path}`;
}

/** A call the page asks for, once checked. */
export interface BridgeCall {
  id: string | number;
  tool: string;
  args: Record<string, unknown>;
}

const TOOL_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** The most a call's arguments may weigh, as JSON (what the server accepts too). */
export const MAX_BRIDGE_ARGS_CHARS = 100_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * `data` as a bridge call, or null for anything else: an object with
 * `octipus: 'call'`, an `id` (a string of at most 100 characters or a finite
 * number), a tool name, and `args` a plain object (or absent), small enough.
 * Extra keys are refused, so nothing rides along.
 */
export function parseBridgeCall(data: unknown): BridgeCall | null {
  if (!isPlainObject(data) || data.octipus !== 'call') return null;
  if (Object.keys(data).some((k) => !['octipus', 'id', 'tool', 'args'].includes(k))) return null;
  const { id, tool, args } = data;
  if (!((typeof id === 'string' && id.length <= 100) || (typeof id === 'number' && Number.isFinite(id)))) return null;
  if (typeof tool !== 'string' || !TOOL_RE.test(tool)) return null;
  if (args !== undefined && !isPlainObject(args)) return null;
  try {
    if (JSON.stringify(args ?? {}).length > MAX_BRIDGE_ARGS_CHARS) return null;
  } catch {
    return null;
  }
  return { id, tool, args: (args ?? {}) as Record<string, unknown> };
}
