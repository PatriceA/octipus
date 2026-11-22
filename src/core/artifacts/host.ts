/**
 * Host-mode resolver — subdomain when `artifacts.host` setting is configured,
 * else path-prefix fallback. Reads from the settings service so the user can
 * flip modes from the UI without a restart.
 */

import { publicLinkBase } from '@/core/public-url';
import { coreLogger } from '@/utils/logger';
import { resolveArtifactSettings } from './settings';

export type ArtifactsHostMode =
  | { mode: 'subdomain'; host: string; proto: 'http' | 'https' }
  | { mode: 'path-prefix'; pathPrefix: string };

export function getArtifactsHostMode(): ArtifactsHostMode {
  const s = resolveArtifactSettings();
  if (s.host) return { mode: 'subdomain', host: s.host, proto: s.proto };
  return { mode: 'path-prefix', pathPrefix: '/__artifacts__' };
}

/** A `Host` value: a DNS name or a bracketed IPv6 literal, with an optional port. */
const HOST_HEADER_RE =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*|\[[0-9a-f:.]+\])(?::(\d{1,5}))?$/;

/**
 * A `Host` header (or a configured host) in the one spelling two hosts are
 * compared in: lower case, the default ports (80, 443) dropped. Null for a
 * value that is not a host at all — such a request is never the artifact host.
 */
export function normalizeHost(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim().toLowerCase();
  const match = HOST_HEADER_RE.exec(value);
  if (!match) return null;
  const port = match[1];
  if (port === '80' || port === '443') return value.slice(0, -(port.length + 1));
  return value;
}

/**
 * Did this request arrive for the configured artifact host? Only in
 * subdomain mode, and only on an exact match of the `Host` header against
 * `artifacts.host` — never a suffix or a pattern, and never a forwarded
 * header a client could set. The answer only ever narrows what a request may
 * reach (`isArtifactHostPath`), so a client that lies about its host can only
 * lock itself out of the app.
 */
export function isArtifactHostRequest(request: Request): boolean {
  const mode = hostModeForRouting();
  if (mode?.mode !== 'subdomain') return false;
  const sent = request.headers.get('host') ?? new URL(request.url).host;
  const host = normalizeHost(sent);
  return host !== null && host === normalizeHost(mode.host);
}

let lastRoutingError = '';

/**
 * The host mode for routing every request, or null while the artifact
 * settings are invalid (`resolveArtifactSettings` throws on them). The rest of
 * the app keeps working then; the artifact pages, which read the same
 * settings, fail on their own. Logged once per distinct error, not per request.
 */
function hostModeForRouting(): ArtifactsHostMode | null {
  try {
    const mode = getArtifactsHostMode();
    lastRoutingError = '';
    return mode;
  } catch (err) {
    const message = (err as Error).message;
    if (message !== lastRoutingError) {
      lastRoutingError = message;
      coreLogger.error({ err }, 'artifact.host.settings_invalid — artifact host routing is off until the artifact settings are fixed');
    }
    return null;
  }
}

/** In subdomain mode (with valid settings): the root `/a/...` pages belong to the artifact host. */
export function isSubdomainMode(): boolean {
  return hostModeForRouting()?.mode === 'subdomain';
}

/** The hosted-page routes, relative to the artifact host's root (or the `/__artifacts__` prefix). */
const ARTIFACT_PAGE_PATH_RE = /^\/a\/[^/]+(?:\/(?:embed|bundle\.js|export\/[^/]+|data\/[^/]+))?\/?$/;
const ARTIFACT_SDK_PATH = '/octipus-artifact-client.js';

/**
 * What the artifact host serves: the hosted pages and the SDK, read-only.
 * Everything else — `/api`, `/v1`, the fallback mount — is the app's, and on
 * the artifact origin it would be a second front door to it (a sign-in there
 * would set a session cookie scoped to the artifact host).
 */
export function isArtifactHostPath(method: string, pathname: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  return pathname === ARTIFACT_SDK_PATH || ARTIFACT_PAGE_PATH_RE.test(pathname);
}

/**
 * Is `pathname` one of the hosted-page routes of the root mount (`/a/...`)?
 * In subdomain mode they are served on the artifact host only: on the app's
 * host the same URL would put an artifact on the app's origin.
 */
export function isRootArtifactPagePath(pathname: string): boolean {
  return ARTIFACT_PAGE_PATH_RE.test(pathname);
}

/** Test-only — kept for symmetry with prior API; settings cache is the source of truth. */
export function _resetArtifactsHostMode(): void {
  // delegated to resolveArtifactSettings cache via resetArtifactSettingsCache()
}

/**
 * Absolute base for links handed to a human (`publicLinkBase`). Empty when
 * no public URL is configured — callers then emit a root-relative path,
 * which only works inside the web app.
 */
const publicBase = publicLinkBase;

/**
 * Build the public URL for a hosted artifact slug. In path-prefix mode this
 * MUST be absolute — the link is pasted into Telegram/Slack, where a bare
 * `/__artifacts__/a/<slug>` is not a link at all.
 */
export function buildArtifactEmbedUrl(slug: string, opts?: { mainHost?: string }): string {
  const mode = getArtifactsHostMode();
  if (mode.mode === 'subdomain') {
    return `${mode.proto}://${mode.host}/a/${encodeURIComponent(slug)}/embed`;
  }
  const base = opts?.mainHost ?? publicBase();
  return `${base}${mode.pathPrefix}/a/${encodeURIComponent(slug)}/embed`;
}

/** Outer (chrome) URL — same paths, just without /embed. */
export function buildArtifactOuterUrl(slug: string, opts?: { mainHost?: string }): string {
  const mode = getArtifactsHostMode();
  if (mode.mode === 'subdomain') {
    return `${mode.proto}://${mode.host}/a/${encodeURIComponent(slug)}`;
  }
  return `${opts?.mainHost ?? publicBase()}${mode.pathPrefix}/a/${encodeURIComponent(slug)}`;
}

/**
 * In-app dashboard URL for an artifact (`/artifacts/view?id=<id>` in the web UI).
 * Always behind authentication, so this is the link to surface for
 * `workspace` / `private` artifacts — the public outerUrl returns 404 to
 * anyone not signed in for those visibilities.
 *
 * Uses the `oauth.publicUrl` setting (env: `PUBLIC_URL`) as the absolute
 * base. When that's empty, returns a relative path (`/artifacts/view?id=<id>`),
 * which still works from anywhere inside the web app.
 */
export function buildArtifactAppUrl(id: string): string {
  return `${publicBase()}/artifacts/view?id=${encodeURIComponent(id)}`;
}

export type ArtifactVisibility = 'public' | 'workspace' | 'private' | 'signed';

/**
 * Pick the URL that should actually be handed to the user as the "go look
 * at it" link. Only public artifacts have an anonymous URL. All others use the app
 * route; a signed artifact needs an explicitly minted share token for outsiders.
 */
export function pickShareableUrl(args: {
  visibility: ArtifactVisibility;
  slug: string;
  id: string;
}): string {
  switch (args.visibility) {
    case 'public':
      return buildArtifactOuterUrl(args.slug);
    case 'signed':
    case 'workspace':
    case 'private':
      return buildArtifactAppUrl(args.id);
  }
}

