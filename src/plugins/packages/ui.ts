/**
 * Plugin package pages (docs/PLUGIN-PACKAGES.md#pages): which pages the
 * enabled packages add, and serving their static files.
 *
 * A page is a static HTML file of the package, shown by the web app in a
 * sandboxed iframe. Its files are served from `/api/plugin-ui/<name>/…`, and
 * only:
 *
 * - while the package is enabled and its files still hash to the approved
 *   content hash (checked at most once a minute per package, and refused at
 *   once while the bridge reports a mismatch);
 * - from the package's UI directory (`ui.dir`, default `ui`): a plain
 *   relative path, no `..`, no hidden segment, no symbolic link anywhere on
 *   the way (the install refuses links; the real path is compared again);
 * - with a known static content type, so nothing is sniffed into HTML;
 * - under a CSP that sandboxes the document (`sandbox allow-scripts`, no
 *   `allow-same-origin`: an opaque origin, no cookies, no storage of the
 *   app), lets it load scripts, styles, images and fonts from this package's
 *   path only, connect nowhere, and be framed only by the app itself.
 *
 * The files are static and the same for every user: they are served without
 * a sign-in (a sandboxed frame's own requests carry no cookies), and hold no
 * data. Everything a page shows comes through the postMessage bridge, which
 * calls the package's own tools as the signed-in user
 * (`POST /api/plugins/:name/call/:tool`).
 */
import { lstat, readFile, realpath } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { pluginPackages } from '@/db/schema/plugin-packages';
import { getMCPBridge, PLUGIN_SERVER_PREFIX } from '@/mcp/bridge';
import type { PluginPageLink } from '@/shared/plugin-package';
import { coreLogger } from '@/utils/logger';
import { CONTENT_MISMATCH_PROBLEM, hashPackageContent } from './integrity';
import { isPlainRelativePath, uiDirOf } from './manifest-ui-host';
import { packageDir } from './service';

/** Where the files are served. */
export const PLUGIN_UI_PREFIX = '/api/plugin-ui';

/** The content types served; any other file is not served. */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/** Largest file served. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** How long a verified content hash is trusted before the files are hashed again. */
const VERIFY_TTL_MS = 60_000;

/** The content type a file is served with, or null when it is not served. */
export function uiContentType(path: string): string | null {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? null;
}

/** The URL of a package's UI file (`rel` relative to its UI directory). */
export function uiFileUrl(name: string, rel: string): string {
  return `${PLUGIN_UI_PREFIX}/${encodeURIComponent(name)}/${rel.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * The CSP of a served file: `base` is the absolute URL of the package's UI
 * directory (`http(s)://<host>/api/plugin-ui/<name>/`), the only source of
 * scripts, styles, images, fonts and media. Inline scripts, `eval`, fetch,
 * forms, frames, workers and plugins are off; the document is sandboxed
 * without `allow-same-origin`; only the app's own origin (and `ancestors`)
 * may frame it.
 */
export function pluginUiCsp(base: string, ancestors: readonly string[] = []): string {
  return [
    "default-src 'none'",
    `script-src ${base}`,
    `style-src ${base}`,
    `img-src ${base} data:`,
    `font-src ${base}`,
    `media-src ${base}`,
    "connect-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors 'self'${ancestors.length > 0 ? ` ${ancestors.join(' ')}` : ''}`,
    'sandbox allow-scripts',
  ].join('; ');
}

/** The headers every served file gets (with its CSP). */
export function pluginUiHeaders(csp: string, contentType: string): Record<string, string> {
  return {
    'content-type': contentType,
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-cache',
    'cross-origin-opener-policy': 'same-origin',
    // The sandboxed document's origin is opaque ("null"): a module script it
    // loads is a CORS request. The files are public and static; no credentials.
    'access-control-allow-origin': '*',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=(), clipboard-write=()',
  };
}

const HOST_RE = /^[A-Za-z0-9.-]+(:\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/;

/**
 * The absolute base URL of a package's UI directory, as the browser reached
 * it: the request's host (or `X-Forwarded-Host` from a reverse proxy) and
 * scheme. Null when the host does not look like one (it goes into a CSP).
 */
export function uiBaseUrl(request: Request, name: string): string | null {
  const url = new URL(request.url);
  const fwdHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  const fwdProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  const host = fwdHost || url.host;
  const proto = fwdProto === 'https' || fwdProto === 'http' ? fwdProto : url.protocol.replace(':', '');
  if (!HOST_RE.test(host)) return null;
  return `${proto}://${host}${PLUGIN_UI_PREFIX}/${encodeURIComponent(name)}/`;
}

/** When each package's files last hashed to its approved hash. */
const verified = new Map<string, { hash: string; at: number }>();

/** Test-only. */
export function _forgetUiVerification(): void {
  verified.clear();
}

/** Whether the package's files still hash to `contentHash` (cached for a minute). */
async function contentStillApproved(name: string, row: { name: string; version: string; contentHash: string | null }): Promise<boolean> {
  if (row.contentHash === null) return false;
  const now = Date.now();
  const hit = verified.get(name);
  if (hit && hit.hash === row.contentHash && now - hit.at < VERIFY_TTL_MS) return true;
  let actual: string;
  try {
    actual = await hashPackageContent(packageDir(name), row);
  } catch (err) {
    coreLogger.warn({ err, pkg: name }, 'Plugin page files could not be hashed; not served');
    return false;
  }
  if (actual !== row.contentHash) {
    verified.delete(name);
    coreLogger.warn({ pkg: name, recorded: row.contentHash, actual }, 'Plugin page files changed since they were approved; not served');
    return false;
  }
  verified.set(name, { hash: actual, at: now });
  return true;
}

async function enabledRow(name: string) {
  const [row] = await getDb().select().from(pluginPackages).where(eq(pluginPackages.name, name)).limit(1);
  return row?.enabled ? row : null;
}

/** The pages of every enabled package, for the sidebar. */
export async function listEnabledPages(): Promise<PluginPageLink[]> {
  const rows = await getDb().select().from(pluginPackages).where(eq(pluginPackages.enabled, true)).orderBy(pluginPackages.name);
  const bridge = getMCPBridge();
  return rows.flatMap((row) => {
    const ui = row.manifest.ui;
    if (!ui || row.contentHash === null) return [];
    // A package whose files changed is not started; its pages are not offered either.
    if (bridge.pluginProblem(`${PLUGIN_SERVER_PREFIX}${row.name}`) === CONTENT_MISMATCH_PROBLEM) return [];
    return ui.pages.map((page) => ({
      plugin: row.name,
      pluginTitle: row.manifest.title,
      path: page.path,
      title: page.title,
      icon: page.icon ?? null,
      src: uiFileUrl(row.name, page.entry),
    }));
  });
}

export type UiFileResult =
  | { status: 200; body: Buffer; contentType: string }
  | { status: 404 };

/**
 * A file of an enabled package's UI directory, or 404 for anything else
 * (not installed, disabled, no `ui`, changed since approved, outside the
 * directory, a link, not a regular file, an unknown type, too large).
 */
export async function readUiFile(name: string, rel: string): Promise<UiFileResult> {
  if (!/^[a-z][a-z0-9-]{1,49}$/.test(name) || !isPlainRelativePath(rel)) return { status: 404 };
  const contentType = uiContentType(rel);
  if (!contentType) return { status: 404 };
  const row = await enabledRow(name);
  if (!row?.manifest.ui) return { status: 404 };
  if (getMCPBridge().pluginProblem(`${PLUGIN_SERVER_PREFIX}${name}`) === CONTENT_MISMATCH_PROBLEM) return { status: 404 };
  if (!(await contentStillApproved(name, row))) return { status: 404 };
  const root = resolve(packageDir(name), uiDirOf(row.manifest.ui));
  const file = resolve(root, ...rel.split('/'));
  if (!file.startsWith(`${root}${sep}`)) return { status: 404 };
  try {
    // No link inside the package: resolved for real, the file sits at the same
    // place under the real UI directory (a link above it, in the workspace
    // path, changes both alike).
    const [realPkg, realRoot, realFile, stat] = await Promise.all([realpath(packageDir(name)), realpath(root), realpath(file), lstat(file)]);
    if (realRoot !== resolve(realPkg, ...uiDirOf(row.manifest.ui).split('/'))) return { status: 404 };
    if (realFile !== resolve(realRoot, ...rel.split('/')) || !realFile.startsWith(`${realRoot}${sep}`)) return { status: 404 };
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return { status: 404 };
    return { status: 200, body: await readFile(join(file)), contentType };
  } catch {
    return { status: 404 };
  }
}
