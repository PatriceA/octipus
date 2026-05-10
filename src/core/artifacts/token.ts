/**
 * Artifact-scoped tokens. HMAC-SHA256 signed, base64url-encoded JWT-shape
 * (header.payload.signature). Separate signing key from session JWT — a
 * leaked artifact token cannot impersonate a session.
 *
 * Key source (in order):
 *   1. ARTIFACT_TOKEN_SECRET env (preferred — rotate independently).
 *   2. Derived from JWT_SECRET via HKDF (`octipus-artifact-token-v1`).
 *      Falls back gracefully so single-user installs work out of the box.
 */

import { createHmac, hkdfSync, timingSafeEqual } from 'crypto';
import { coreLogger } from '@/utils/logger';
import { resolveArtifactSettings } from './settings';

export interface ArtifactTokenPayload {
  /** Artifact id this token authorizes. */
  aid: string;
  /** Audience marker — always `artifact:<aid>`. */
  aud: string;
  /** Workspace id (cross-checked at gateway subscribe). */
  wid: string;
  /** Visibility-derived scope. */
  scope: 'view' | 'view+refresh';
  /** Issued-at, seconds. */
  iat: number;
  /** Expires-at, seconds. */
  exp: number;
  /** Optional share-link id (set when minted from a signed share link). */
  slid?: string;
}

const HEADER_B64 = b64url(JSON.stringify({ alg: 'HS256', typ: 'AT' }));

function b64url(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

let cachedKey: Buffer | null = null;
let cachedKeyFingerprint = '';

function getSigningKey(): Buffer {
  // Settings-first: artifacts.tokenSecret is auto-generated on first boot
  // and editable in the UI. Env override (ARTIFACT_TOKEN_SECRET) is honored
  // by the registry's envVar fallback inside the settings service.
  let secret = '';
  try {
    secret = resolveArtifactSettings().tokenSecret;
  } catch {
    // Settings service not yet initialized — fall through to JWT_SECRET HKDF.
  }

  if (secret && secret.length >= 16) {
    if (cachedKey && cachedKeyFingerprint === secret) return cachedKey;
    cachedKey = Buffer.from(secret, 'utf8');
    cachedKeyFingerprint = secret;
    return cachedKey;
  }

  const base = process.env.JWT_SECRET;
  if (!base) {
    coreLogger.error('artifact.token.no_secret — settings.artifacts.tokenSecret is empty and JWT_SECRET is not set');
    throw new Error('artifacts.tokenSecret or JWT_SECRET must be configured');
  }
  if (cachedKey && cachedKeyFingerprint === `__hkdf__:${base}`) return cachedKey;
  cachedKey = Buffer.from(
    hkdfSync('sha256', Buffer.from(base, 'utf8'), Buffer.from('octipus-artifact-token-v1'), 'artifact', 32),
  );
  cachedKeyFingerprint = `__hkdf__:${base}`;
  return cachedKey;
}

/** Test-only: clear the cached signing key so env/settings changes are picked up. */
export function _resetArtifactTokenKey(): void {
  cachedKey = null;
  cachedKeyFingerprint = '';
}

export function signArtifactToken(payload: Omit<ArtifactTokenPayload, 'aud'>): string {
  const aud = `artifact:${payload.aid}`;
  const full: ArtifactTokenPayload = { ...payload, aud };
  const body = b64url(JSON.stringify(full));
  const signed = `${HEADER_B64}.${body}`;
  const sig = createHmac('sha256', getSigningKey()).update(signed).digest();
  return `${signed}.${b64url(sig)}`;
}

export function verifyArtifactToken(
  token: string,
  expected: { aid: string },
): ArtifactTokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const expectedSig = createHmac('sha256', getSigningKey()).update(`${h}.${p}`).digest();
  const provided = b64urlDecode(s);
  if (provided.length !== expectedSig.length) return null;
  if (!timingSafeEqual(provided, expectedSig)) return null;

  let payload: ArtifactTokenPayload;
  try {
    payload = JSON.parse(b64urlDecode(p).toString('utf8')) as ArtifactTokenPayload;
  } catch {
    return null;
  }

  if (payload.aud !== `artifact:${expected.aid}`) return null;
  if (payload.aid !== expected.aid) return null;
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) return null;
  return payload;
}
