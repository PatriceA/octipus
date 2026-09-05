/**
 * Password login for local CLI clients, against the same credentials the web
 * UI uses. Goes to `/auth/login-mobile` rather than `/auth/login` because that
 * route returns the bearer token in the body — a terminal can't read the
 * HttpOnly cookie the browser route sets.
 */
import { type CliSession, writeCliSession } from './cli-session';

export type LoginResult =
  | { ok: true; session: CliSession }
  | { ok: false; error: string; requiresTOTP?: boolean };

/**
 * The REST base for a gateway WebSocket URL: `ws://host:3005/gateway` →
 * `http://host:3005/api`. Both are served by the same origin, so deriving it
 * avoids a second URL to configure (and to get wrong).
 */
export function apiBaseFromGatewayUrl(gatewayUrl: string): string {
  const url = new URL(gatewayUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  // Strip the `/gateway` suffix AND any trailing slash: a URL with no path at
  // all (`ws://host:3005`) has pathname '/', which would build `//api`.
  url.pathname = url.pathname.replace(/\/gateway\/?$/, '').replace(/\/+$/, '') + '/api';
  url.search = '';
  return url.toString().replace(/\/$/, '');
}

export async function loginWithPassword(
  gatewayUrl: string,
  credentials: { username: string; password: string; totpCode?: string },
): Promise<LoginResult> {
  let response: Response;
  try {
    response = await fetch(`${apiBaseFromGatewayUrl(gatewayUrl)}/auth/login-mobile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: credentials.username,
        password: credentials.password,
        ...(credentials.totpCode ? { totpCode: credentials.totpCode } : {}),
        deviceName: 'Octipus TUI',
      }),
    });
  } catch (err) {
    return { ok: false, error: `Cannot reach the backend: ${(err as Error).message}` };
  }

  const body = (await response.json().catch(() => ({}))) as {
    token?: string;
    user?: { id: string; username: string; isAdmin: boolean };
    expiresAt?: string;
    error?: string;
    requiresTOTP?: boolean;
  };

  if (!response.ok || !body.token || !body.user) {
    return {
      ok: false,
      error: body.error || `Login failed (HTTP ${response.status})`,
      requiresTOTP: body.requiresTOTP,
    };
  }

  const session: CliSession = {
    token: body.token,
    userId: body.user.id,
    username: body.user.username,
    isAdmin: body.user.isAdmin === true,
    expiresAt: body.expiresAt,
  };
  writeCliSession(session);
  return { ok: true, session };
}
