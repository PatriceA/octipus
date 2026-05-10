/**
 * Host-mode resolver — subdomain when `artifacts.host` setting is configured,
 * else path-prefix fallback. Reads from the settings service so the user can
 * flip modes from the UI without a restart.
 */

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

void coreLogger; // referenced from prior versions; kept import-stable
