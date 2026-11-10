/**
 * Plugin package pages (docs/PLUGIN-PACKAGES.md#pages): the pages the enabled
 * packages add (`GET /api/plugin-ui`), and the bridge a page's sandboxed
 * frame talks to.
 *
 * The bridge is a MessagePort, never a broadcast:
 *
 * 1. The app loads the frame at `<entry>#octipus=<nonce>&parent=<app origin>`.
 *    The fragment never goes over the network, and a document the frame
 *    navigates to does not see it.
 * 2. The page opens a `MessageChannel` and hands one port to its parent, to
 *    that exact origin: `parent.postMessage({ octipus: 'ready', nonce }, parentOrigin, [port2])`.
 * 3. The app takes the first `ready` from its own frame (window, opaque origin
 *    "null", the nonce it chose, exactly one port) and ignores every later one.
 *    From then on it talks only over that port: `{ octipus: 'call', id, tool, args }`
 *    in, `{ octipus: 'result', id, ok, result | error, code }` out.
 *
 * The port is the capability: it lives in the page's document, so a
 * navigation destroys it, and the app also detaches on any later load.
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

/** Whether `data` is the page's `ready` with exactly this nonce (and nothing else). */
export function isBridgeReady(data: unknown, nonce: string): boolean {
  if (!isPlainObject(data) || data.octipus !== 'ready') return false;
  if (Object.keys(data).some((k) => k !== 'octipus' && k !== 'nonce')) return false;
  return typeof data.nonce === 'string' && data.nonce.length === nonce.length && data.nonce === nonce;
}

const PLUGIN_NAME_RE = /^[a-z][a-z0-9-]{1,49}$/;
const SEGMENT_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/;

/**
 * The frame URL of a page, rebuilt from the server's listing only: the
 * package name and the entry's path segments are checked (as the manifest
 * check does) and each is encoded again. Null for anything else (another
 * prefix, another package, a query, a fragment, `..`), so no route or DOM
 * text ever reaches the frame's `src`.
 */
export function pageFrameSrc(page: Pick<PluginPageLink, 'plugin' | 'src'>): string | null {
  if (!PLUGIN_NAME_RE.test(page.plugin)) return null;
  const prefix = `/api/plugin-ui/${page.plugin}/`;
  if (typeof page.src !== 'string' || !page.src.startsWith(prefix)) return null;
  const segments: string[] = [];
  for (const raw of page.src.slice(prefix.length).split('/')) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (!SEGMENT_RE.test(segment)) return null;
    segments.push(encodeURIComponent(segment));
  }
  return segments.length > 0 ? `${prefix}${segments.join('/')}` : null;
}

/** A fresh nonce for one frame. */
export function bridgeNonce(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('');
}
