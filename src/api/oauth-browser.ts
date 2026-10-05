/**
 * Ties an OAuth flow to the browser that started it.
 *
 * The OAuth state is server-side and single use, so it cannot be forged —
 * but the callback used to trust whichever browser completed the consent. A
 * user could start a connect, send the provider's authorization URL to
 * someone else, and that person's account would be stored as the user's (or,
 * for a space connector, as the space's, used by every member: a login CSRF
 * with shared reach).
 *
 * So `authorize` hands the browser a random nonce in an HttpOnly,
 * `SameSite=Lax` cookie (Lax: the provider's redirect back is a top-level
 * cross-site navigation, which a `Strict` cookie — like the session's — does
 * not survive) and keeps only its hash in the state. The callback refuses a
 * request whose cookie does not hash to it: the consent must be completed
 * in the browser that asked. One nonce per browser, reused by concurrent
 * flows, renewed on every authorize.
 */
import { createHash, randomBytes } from 'node:crypto';
import { requestIsHttps } from './session-cookie';

export const OAUTH_BROWSER_COOKIE = 'octipus_oauth_browser';
/** As long as an OAuth state lives (`OAuthManager`, 10 minutes). */
const MAX_AGE_SECONDS = 600;
const NONCE_RE = /^[A-Za-z0-9_-]{43}$/;

/** The nonce the request's cookie carries, or null. */
export function browserNonceOf(request: Request): string | null {
  const header = request.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name !== OAUTH_BROWSER_COOKIE) continue;
    const value = rest.join('=');
    return NONCE_RE.test(value) ? value : null;
  }
  return null;
}

/** The hash an OAuth state keeps of a nonce. */
export function browserBindingOf(nonce: string): string {
  return createHash('sha256').update(nonce).digest('hex');
}

/**
 * For an authorize request: the binding to put in the state, and the
 * `Set-Cookie` value carrying its nonce to the browser.
 */
export function bindBrowser(request: Request): { binding: string; setCookie: string } {
  const nonce = browserNonceOf(request) ?? randomBytes(32).toString('base64url');
  const parts = [`${OAUTH_BROWSER_COOKIE}=${nonce}`, 'HttpOnly', 'SameSite=Lax', 'Path=/api', `Max-Age=${MAX_AGE_SECONDS}`];
  if (requestIsHttps(request)) parts.push('Secure');
  return { binding: browserBindingOf(nonce), setCookie: parts.join('; ') };
}

/** For a callback request: the binding of the browser it came from, or null without the cookie. */
export function callbackBrowser(request: Request): string | null {
  const nonce = browserNonceOf(request);
  return nonce ? browserBindingOf(nonce) : null;
}
