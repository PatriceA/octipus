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
 *
 * The same port carries the page's store (docs/PLUGIN-PACKAGES.md#store):
 * `{ octipus: 'store', id, op: 'store.get' | 'store.set' | 'store.delete' | 'store.list', … }`
 * in, the same `result` out. The app calls `/api/plugins/<name>/store/…` as the
 * signed-in user: their own entries of this package only.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { PluginDashboardLink, PluginPageLink } from '../../src/shared/plugin-package';

export type { PluginDashboardLink, PluginPageLink } from '../../src/shared/plugin-package';

/** The pages and dashboards of the enabled packages: one query (`GET /api/plugin-ui`). */
export const PLUGIN_PAGES_KEY = ['plugin-pages'] as const;

interface PluginUi { pages: PluginPageLink[]; dashboards: PluginDashboardLink[] }

const fetchPluginUi = async (): Promise<PluginUi> => {
  const answer = await api.get<Partial<PluginUi>>('/plugin-ui');
  return { pages: answer.pages ?? [], dashboards: answer.dashboards ?? [] };
};

/** The pages of the enabled packages; refreshed every minute and on focus. */
export function usePluginPages(enabled = true) {
  return useQuery({
    queryKey: PLUGIN_PAGES_KEY,
    enabled,
    queryFn: fetchPluginUi,
    select: (ui: PluginUi) => ui.pages,
    refetchInterval: 60_000,
    retry: false,
  });
}

/** The dashboards of the enabled packages (docs/PLUGIN-PACKAGES.md#dashboards); the same query as the pages. */
export function usePluginDashboards(enabled = true) {
  return useQuery({
    queryKey: PLUGIN_PAGES_KEY,
    enabled,
    queryFn: fetchPluginUi,
    select: (ui: PluginUi) => ui.dashboards,
    refetchInterval: 60_000,
    retry: false,
  });
}

/** The app route of a dashboard. */
export function pluginDashboardHref(d: Pick<PluginDashboardLink, 'plugin' | 'id'>): string {
  return `/dashboards/${encodeURIComponent(d.plugin)}/${encodeURIComponent(d.id)}`;
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

/** The store operations a page may ask for over the port. */
export const BRIDGE_STORE_OPS = ['store.get', 'store.set', 'store.delete', 'store.list'] as const;
export type BridgeStoreOp = (typeof BRIDGE_STORE_OPS)[number];

/** A store request the page asks for, once checked. */
export type BridgeStore =
  | { id: string | number; op: 'store.get' | 'store.delete'; key: string }
  | { id: string | number; op: 'store.set'; key: string; value: unknown; ifVersion?: number }
  | { id: string | number; op: 'store.list'; prefix?: string; limit?: number };

/** A store key: what the server accepts (letters, digits, `._:/-`, no empty, `.` or `..` segment). */
const STORE_KEY_RE = /^[A-Za-z0-9._:/-]{1,200}$/;
const storeKeyOk = (key: unknown): key is string => typeof key === 'string' && STORE_KEY_RE.test(key) && key.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
/** The most a stored value may weigh, as JSON (the server counts UTF-8 bytes and refuses past 64 KB). */
export const MAX_BRIDGE_STORE_VALUE_CHARS = 64 * 1024;

/**
 * `data` as a store request, or null: `octipus: 'store'`, an `id` as for a
 * call, an `op` of `BRIDGE_STORE_OPS`, and exactly the fields that op takes
 * (`key` for get, set and delete; `value` and an optional `ifVersion` for set;
 * an optional `prefix` and `limit` for list). Anything else is refused.
 */
export function parseBridgeStore(data: unknown): BridgeStore | null {
  if (!isPlainObject(data) || data.octipus !== 'store') return null;
  const { id, op } = data;
  if (!((typeof id === 'string' && id.length <= 100) || (typeof id === 'number' && Number.isFinite(id)))) return null;
  if (typeof op !== 'string' || !(BRIDGE_STORE_OPS as readonly string[]).includes(op)) return null;
  const allowed: Record<BridgeStoreOp, string[]> = {
    'store.get': ['key'], 'store.delete': ['key'], 'store.set': ['key', 'value', 'ifVersion'], 'store.list': ['prefix', 'limit'],
  };
  if (Object.keys(data).some((k) => !['octipus', 'id', 'op', ...allowed[op as BridgeStoreOp]].includes(k))) return null;
  if (op === 'store.list') {
    const { prefix, limit } = data;
    if (prefix !== undefined && !(typeof prefix === 'string' && /^[A-Za-z0-9._:/-]{0,200}$/.test(prefix))) return null;
    if (limit !== undefined && !(typeof limit === 'number' && Number.isInteger(limit) && limit >= 1 && limit <= 1000)) return null;
    return { id, op, ...(prefix ? { prefix } : {}), ...(limit !== undefined ? { limit } : {}) };
  }
  if (!storeKeyOk(data.key)) return null;
  if (op === 'store.set') {
    if (!Object.hasOwn(data, 'value')) return null;
    const { ifVersion } = data;
    if (ifVersion !== undefined && !(typeof ifVersion === 'number' && Number.isInteger(ifVersion) && ifVersion >= 0)) return null;
    try {
      const json = JSON.stringify(data.value);
      if (json === undefined || json.length > MAX_BRIDGE_STORE_VALUE_CHARS) return null;
    } catch {
      return null;
    }
    return { id, op, key: data.key, value: data.value, ...(ifVersion !== undefined ? { ifVersion } : {}) };
  }
  return { id, op: op as 'store.get' | 'store.delete', key: data.key };
}

/** The app route a store request goes to, under `/api` (the key's segments each encoded). */
export function storeRequestPath(plugin: string, req: BridgeStore): string {
  const base = `/plugins/${encodeURIComponent(plugin)}/store`;
  if (req.op === 'store.list') {
    const q = new URLSearchParams();
    if (req.prefix) q.set('prefix', req.prefix);
    if (req.limit !== undefined) q.set('limit', String(req.limit));
    const qs = q.toString();
    return qs ? `${base}?${qs}` : base;
  }
  return `${base}/${req.key.split('/').map(encodeURIComponent).join('/')}`;
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

const HOST_RE = /^[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?$/;
const BASE_PATH_RE = /^(\/[A-Za-z0-9._-]+)*$/;

/**
 * The frame's full URL: the API's origin (a fixed scheme and a checked host,
 * never a stored string as is), the base path in front of `/api`, the page's
 * path from {@link pageFrameSrc}, and the bridge fragment. Null when the API
 * URL is not plain http(s).
 */
export function pageFrameUrl(apiUrl: string, appOrigin: string, path: string, nonce: string): string | null {
  let base: URL;
  try {
    base = new URL(apiUrl, appOrigin);
  } catch {
    return null;
  }
  const scheme = base.protocol === 'https:' ? 'https://' : base.protocol === 'http:' ? 'http://' : null;
  const basePath = base.pathname.replace(/\/api\/?$/, '');
  if (!scheme || !HOST_RE.test(base.host) || !BASE_PATH_RE.test(basePath) || !/^[0-9a-f]{16,128}$/.test(nonce)) return null;
  return `${scheme}${base.host}${basePath}${path}#octipus=${nonce}&parent=${encodeURIComponent(appOrigin)}`;
}

/** A fresh nonce for one frame. */
export function bridgeNonce(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('');
}
