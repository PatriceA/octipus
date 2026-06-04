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

async function call(token: string, base: string, method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
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

export async function gmailApi(userId: string, method: string, path: string, body?: unknown): Promise<unknown> {
  return call(await requireToken(userId, 'google'), GMAIL_BASE, method, path, body);
}

export async function graphApi(userId: string, method: string, path: string, body?: unknown): Promise<unknown> {
  return call(await requireToken(userId, 'microsoft'), GRAPH_BASE, method, path, body);
}
