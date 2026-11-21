/**
 * Provider API access for the email inbox. All calls use the *calling user's*
 * OAuth token from the vault (getValidToken) — there is no cross-tenant path,
 * and the token is never logged. Thin wrappers over the Gmail REST + Graph APIs,
 * mirroring the gmail/m365 tools (which keep their token logic private).
 */
import { getOAuthManager } from '@/security/oauth';
import { coreLogger } from '@/utils/logger';
import type { EmailProvider } from './types';

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

async function requireToken(userId: string, provider: EmailProvider): Promise<string> {
  const token = await getOAuthManager().getValidToken(userId, provider);
  if (!token) {
    const label = provider === 'google' ? 'Google' : 'Microsoft 365';
    throw new Error(`${label} is not connected. Connect your account in Settings > Integrations.`);
  }
  return token;
}

/** Which mail provider the user has connected (google preferred), or null. */
export async function detectProvider(userId: string): Promise<EmailProvider | null> {
  const mgr = getOAuthManager();
  if (await mgr.getValidToken(userId, 'google')) return 'google';
  if (await mgr.getValidToken(userId, 'microsoft')) return 'microsoft';
  return null;
}

async function call(token: string, base: string, method: string, path: string, body?: unknown, signal?: AbortSignal, extra?: Record<string, string>): Promise<unknown> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...extra, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    // Log the upstream detail server-side; return a generic message so provider
    // internals / identifiers aren't echoed to the client.
    const detail = await res.text().catch(() => '');
    coreLogger.warn({ status: res.status, detail: detail.slice(0, 300) }, 'email: mail API error');
    throw new Error(`Mail provider returned an error (HTTP ${res.status}).`);
  }
  if (res.status === 204) return { success: true };
  return res.json();
}

/** `signal` (optional) stops the request early, on top of its own 15 s timeout. */
export async function gmailApi(userId: string, method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  return call(await requireToken(userId, 'google'), GMAIL_BASE, method, path, body, signal);
}

export async function graphApi(userId: string, method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  return call(await requireToken(userId, 'microsoft'), GRAPH_BASE, method, path, body, signal);
}

/**
 * A Graph GET with a `Prefer` header: the mail index (mail-index.ts) asks for
 * bigger delta pages with `odata.maxpagesize`. `path` is relative to /v1.0.
 */
export async function graphGetPrefer(userId: string, path: string, prefer: string, signal?: AbortSignal): Promise<unknown> {
  return call(await requireToken(userId, 'microsoft'), GRAPH_BASE, 'GET', path, undefined, signal, { Prefer: prefer });
}

/** Which of the two providers this user has connected, Google first. */
export async function connectedProviders(userId: string): Promise<EmailProvider[]> {
  const mgr = getOAuthManager();
  const out: EmailProvider[] = [];
  for (const provider of ['google', 'microsoft'] as const) {
    if (await mgr.getValidToken(userId, provider).catch(() => null)) out.push(provider);
  }
  return out;
}

const GMAIL_BATCH_URL = 'https://gmail.googleapis.com/batch/gmail/v1';

/**
 * One multipart request to Gmail's batch endpoint (core/email/gmail-batch.ts
 * builds the body and reads the answer). Returns the raw multipart answer and
 * its Content-Type, which names the boundary.
 */
export async function gmailBatch(userId: string, body: string, boundary: string): Promise<{ contentType: string; text: string }> {
  const token = await requireToken(userId, 'google');
  const res = await fetch(GMAIL_BATCH_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/mixed; boundary=${boundary}` },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`Mail provider returned an error (HTTP ${res.status}).`);
  }
  return { contentType: res.headers.get('content-type') ?? '', text: await res.text() };
}

/**
 * The bytes of a Graph resource (an attachment's `$value`), at most `maxBytes`.
 * Same posture as `call`: the caller's own token, no provider detail returned.
 */
export async function graphBytes(userId: string, path: string, maxBytes: number): Promise<Uint8Array> {
  const token = await requireToken(userId, 'microsoft');
  const res = await fetch(`${GRAPH_BASE}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`Mail provider returned an error (HTTP ${res.status}).`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error('This attachment is too large to download here.');
  return bytes;
}
