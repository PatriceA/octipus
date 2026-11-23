/**
 * Resolved artifact settings, sourced from the settings service (DB-backed,
 * editable in-app) with env-var/file fallback. All consumers (host resolver,
 * CSP builder, token signer, bundler, embed renderer) read through here so
 * a single source of truth governs runtime behavior.
 *
 * Auto-bootstrap: on first boot a 64-char hex token secret is generated and
 * persisted via the settings service; users never have to mint one by hand.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { coreLogger } from '@/utils/logger';
import { getSettingsService } from '@/config/settings-service';

export interface ArtifactSettings {
  host: string;
  proto: 'http' | 'https';
  gatewayWss: string;
  tokenSecret: string;
  sdkSha256: string;
  bundlesDir: string;
}

let cached: ArtifactSettings | null = null;

/**
 * The built browser SDK the embed page loads. Kept next to the sha reader so
 * the file we serve and the hash we pin in CSP can never drift apart.
 *
 * It lives under `web/public/`, but the embed page is served by the BACKEND,
 * so the backend has to serve this too — a root-relative `/octipus-artifact-
 * client.js` resolves against the API origin, not the web app's.
 */
export function artifactSdkFilePath(): string {
  return join(process.cwd(), 'web/public/octipus-artifact-client.js');
}

function readSdkShaFromDisk(): string {
  const path = join(process.cwd(), 'web/public/octipus-artifact-client.sha256.txt');
  if (!existsSync(path)) return '';
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
}

function pickStr(svc: ReturnType<typeof getSettingsService>, key: string): string {
  const v = svc.getSync(key);
  return typeof v === 'string' ? v : '';
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

/** The configured `artifacts.host` value as a host (`artifacts.example.com[:port]`), '' when unset. */
function parseArtifactHost(value: string): { host: string; url: URL | null } {
  const trimmed = value.trim();
  if (!trimmed) return { host: '', url: null };
  const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
  return { host: url.host, url };
}

/**
 * Why `value` cannot be saved as `artifacts.host`, or null when it can. The
 * artifact host serves nothing of the app (no API, no sign-in), so naming the
 * host the app is being used on would lock everyone out of it, the Settings
 * page that could undo it included. Refused: the host of the request saving
 * it, and the app's public host (`oauth.publicUrl` / `PUBLIC_URL`).
 */
export function artifactHostSettingRefusal(value: unknown, requestHost: string | null): string | null {
  if (value === '' || value === null || value === undefined) return null;
  if (typeof value !== 'string') return 'artifacts.host must be a host name';
  let host: string;
  try {
    host = parseArtifactHost(value).host;
  } catch {
    return `artifacts.host: "${value}" is not a host name`;
  }
  const candidate = normalizeHost(host);
  if (!candidate) return `artifacts.host: "${value}" is not a host name`;
  const svc = getSettingsService();
  const appHosts = [normalizeHost(requestHost), normalizeHost(appPublicHost(svc))].filter(Boolean);
  if (appHosts.includes(candidate)) {
    return `artifacts.host must be a host of its own: "${host}" is the address this app is used at, and the artifact host serves no app pages or API`;
  }
  return null;
}

/** The host of the app's public URL (`oauth.publicUrl`, env `PUBLIC_URL`), or '' when none or unparsable. */
function appPublicHost(svc: ReturnType<typeof getSettingsService>): string {
  const raw = pickStr(svc, 'oauth.publicUrl').trim() || process.env.PUBLIC_URL?.trim() || '';
  if (!raw) return '';
  try {
    return new URL(raw).host;
  } catch (err) {
    coreLogger.warn({ err, publicUrl: raw }, 'artifact.settings.public_url_unparsable');
    return '';
  }
}

/**
 * Resolve all artifact settings. Call once at boot after settings service
 * is initialized; the result is cached. Returns synchronously after warm.
 */
export function resolveArtifactSettings(): ArtifactSettings {
  if (cached) return cached;
  const svc = getSettingsService();

  const hostSetting = pickStr(svc, 'artifacts.host').trim();
  // Accept the origin users paste into Settings as well as a bare host.
  const hostUrl = hostSetting ? new URL(hostSetting.includes('://') ? hostSetting : `https://${hostSetting}`) : null;
  if (hostUrl && !['http:', 'https:'].includes(hostUrl.protocol)) throw new Error('Artifact host must use HTTP or HTTPS');
  let host = hostUrl?.host ?? '';
  // The artifact host must be an origin of its own, and the app's own host
  // must be known to tell them apart. Every request for the artifact host is
  // refused everything but artifact pages, so an artifact host that is (or
  // might be) the address the app is used at would lock everyone out of the
  // app, Settings included. Hence subdomain mode needs the app's public URL
  // (`oauth.publicUrl` / `PUBLIC_URL`) on a different host; otherwise the
  // setting is ignored, loudly, and the sandboxed path-prefix fallback serves.
  const appHost = normalizeHost(appPublicHost(svc));
  if (host && (!appHost || normalizeHost(host) === appHost)) {
    coreLogger.error(
      { host, appHost: appHost || null },
      appHost
        ? 'artifacts.host is the app\'s own host (oauth.publicUrl / PUBLIC_URL) — ignored; artifacts are served at /__artifacts__/* until it names a separate host'
        : 'artifacts.host is set but the app\'s public URL (oauth.publicUrl / PUBLIC_URL) is not — ignored, so it cannot shadow the app; artifacts are served at /__artifacts__/*',
    );
    host = '';
  }
  const protoRaw = pickStr(svc, 'artifacts.proto') || 'https';
  const proto: 'http' | 'https' = (hostSetting.includes('://') ? hostUrl?.protocol === 'http:' : protoRaw === 'http') ? 'http' : 'https';
  const gatewaySetting = pickStr(svc, 'artifacts.gatewayWss').trim();
  const gatewayUrl = gatewaySetting ? new URL(gatewaySetting) : null;
  if (gatewayUrl?.protocol === 'https:') gatewayUrl.protocol = 'wss:';
  if (gatewayUrl?.protocol === 'http:') gatewayUrl.protocol = 'ws:';
  if (gatewayUrl && !['ws:', 'wss:'].includes(gatewayUrl.protocol)) throw new Error('Artifact gateway must use WS or WSS');
  const gatewayWss = gatewayUrl?.href ?? '';
  const tokenSecret = pickStr(svc, 'artifacts.tokenSecret');
  // The SDK this backend serves is the file on disk, so its hash is what the
  // CSP must pin. A stored hash is only the fallback for a missing sidecar:
  // preferring it kept pinning the previous release's SDK after an upgrade,
  // and the browser refused the new one (no live refresh, no error).
  const sdkSha256 = readSdkShaFromDisk() || pickStr(svc, 'artifacts.sdkSha256');
  const bundlesDir = pickStr(svc, 'artifacts.bundlesDir') || join(process.cwd(), 'data', 'artifacts');

  cached = { host, proto, gatewayWss, tokenSecret, sdkSha256, bundlesDir };
  return cached;
}

/** Test-only / settings-change reset. */
export function resetArtifactSettingsCache(): void {
  cached = null;
}

/**
 * Generate + persist a token secret if one isn't configured. Idempotent:
 * if the user has set one in the UI or env, this no-ops.
 */
export async function ensureArtifactTokenSecret(): Promise<void> {
  const svc = getSettingsService();
  const existing = pickStr(svc, 'artifacts.tokenSecret');
  if (existing && existing.length >= 32) return;
  // Honor env override one last time (env-driven installs).
  if (process.env.ARTIFACT_TOKEN_SECRET && process.env.ARTIFACT_TOKEN_SECRET.length >= 32) {
    return;
  }
  const generated = randomBytes(32).toString('hex');
  await svc.set('artifacts.tokenSecret', generated, 'system:bootstrap');
  resetArtifactSettingsCache();
  coreLogger.info('artifact.settings.token_secret.generated — persisted to settings (artifacts.tokenSecret)');
}

/** Keep the stored SDK sha256 equal to the built file's (it changes with every SDK release). */
export async function ensureSdkSha256(): Promise<void> {
  const svc = getSettingsService();
  const existing = pickStr(svc, 'artifacts.sdkSha256');
  const fromDisk = readSdkShaFromDisk();
  if (!fromDisk || existing === fromDisk) return;
  await svc.set('artifacts.sdkSha256', fromDisk, 'system:bootstrap');
  resetArtifactSettingsCache();
  coreLogger.info({ sdkSha256: fromDisk }, 'artifact.settings.sdk_sha256.populated_from_disk');
}

/** One-shot bootstrap; safe to call multiple times. */
export async function bootstrapArtifactSettings(): Promise<void> {
  await ensureArtifactTokenSecret();
  await ensureSdkSha256();
  const s = resolveArtifactSettings();
  if (!s.host) {
    coreLogger.warn(
      'artifacts.host not configured — serving at /__artifacts__/* with weaker isolation. ' +
        'Set it in Settings → Artifacts after pointing your DNS at this server.',
    );
  } else {
    coreLogger.info(
      { url: `${s.proto}://${s.host}/a/<slug>` },
      'artifact.settings.host_active',
    );
  }
}

export interface ArtifactRetention {
  /** Days without activity before an artifact is moved to the trash; 0 = never. */
  retentionDays: number;
  /** Days an artifact stays in the trash before it is removed for good. */
  trashDays: number;
}

export const DEFAULT_TRASH_DAYS = 30;

/**
 * The retention policy, read fresh on every cleanup pass (not cached: it is
 * consulted hourly and must follow a settings change). A value that is not a
 * whole number in range is reported and replaced by the setting's safe
 * value — no expiry, and the default trash window — never by a shorter one.
 */
export function resolveArtifactRetention(): ArtifactRetention {
  const svc = getSettingsService();
  const read = (key: string, min: number, fallback: number): number => {
    const raw = svc.getSync(key);
    const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= 36_500) return value;
    coreLogger.error({ key, value: raw }, `artifact.settings.invalid_retention — ${key} must be a whole number of days >= ${min}; using ${fallback}`);
    return fallback;
  };
  return {
    retentionDays: read('artifacts.retentionDays', 0, 0),
    trashDays: read('artifacts.trashDays', 1, DEFAULT_TRASH_DAYS),
  };
}
