/**
 * Host-mode resolver — subdomain when `artifacts.host` setting is configured,
 * else path-prefix fallback. Reads from the settings service so the user can
 * flip modes from the UI without a restart.
 */

import { getSettingsService } from '@/config/settings-service';
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

/** Test-only — kept for symmetry with prior API; settings cache is the source of truth. */
export function _resetArtifactsHostMode(): void {
  // delegated to resolveArtifactSettings cache via resetArtifactSettingsCache()
}

/** Build the public URL for a hosted artifact slug. */
export function buildArtifactEmbedUrl(slug: string, opts?: { mainHost?: string }): string {
  const mode = getArtifactsHostMode();
  if (mode.mode === 'subdomain') {
    return `${mode.proto}://${mode.host}/a/${encodeURIComponent(slug)}/embed`;
  }
  const base = opts?.mainHost ?? '';
  return `${base}${mode.pathPrefix}/a/${encodeURIComponent(slug)}/embed`;
}

/** Outer (chrome) URL — same paths, just without /embed. */
export function buildArtifactOuterUrl(slug: string, opts?: { mainHost?: string }): string {
  const mode = getArtifactsHostMode();
  if (mode.mode === 'subdomain') {
    return `${mode.proto}://${mode.host}/a/${encodeURIComponent(slug)}`;
  }
  return `${opts?.mainHost ?? ''}${mode.pathPrefix}/a/${encodeURIComponent(slug)}`;
}

/**
 * In-app dashboard URL for an artifact (`/artifacts/<id>` in the web UI).
 * Always behind authentication, so this is the link to surface for
 * `workspace` / `private` artifacts — the public outerUrl returns 404 to
 * anyone not signed in for those visibilities.
 *
 * Uses the `oauth.publicUrl` setting (env: `PUBLIC_URL`) as the absolute
 * base. When that's empty, returns a relative path (`/artifacts/<id>`),
 * which still works from anywhere inside the web app.
 */
export function buildArtifactAppUrl(id: string): string {
  const path = `/artifacts/${encodeURIComponent(id)}`;
  try {
    const raw = getSettingsService().getSync('oauth.publicUrl');
    if (typeof raw === 'string' && raw) {
      const base = raw.endsWith('/') ? raw.slice(0, -1) : raw;
      return `${base}${path}`;
    }
  } catch {
    // settings service not initialised (e.g. test boot order) — fall through.
  }
  const envBase = process.env.PUBLIC_URL?.replace(/\/$/, '') ?? '';
  return envBase ? `${envBase}${path}` : path;
}

export type ArtifactVisibility = 'public' | 'workspace' | 'private' | 'signed';

/**
 * Pick the URL that should actually be handed to the user as the "go look
 * at it" link. For `public` (and `signed`, where the recipient has a
 * token) the anon outerUrl works; for `workspace` / `private` only the
 * authenticated in-app URL will load.
 */
export function pickShareableUrl(args: {
  visibility: ArtifactVisibility;
  slug: string;
  id: string;
}): string {
  switch (args.visibility) {
    case 'public':
    case 'signed':
      return buildArtifactOuterUrl(args.slug);
    case 'workspace':
    case 'private':
      return buildArtifactAppUrl(args.id);
  }
}

void coreLogger; // referenced from prior versions; kept import-stable
