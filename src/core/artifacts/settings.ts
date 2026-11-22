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
  // The artifact host must be an origin of its own. Set to the app's own host,
  // every request to the app would be treated as one for an artifact page
  // (isArtifactHostRequest) and artifacts would share the app's origin. Refuse
  // it and serve the sandboxed path-prefix fallback instead.
  const appHost = appPublicHost(svc);
  if (host && appHost && host === appHost) {
    coreLogger.error(
      { host },
      'artifacts.host is the app\'s own host (oauth.publicUrl / PUBLIC_URL) — ignored; artifacts are served at /__artifacts__/* until it names a separate host',
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
