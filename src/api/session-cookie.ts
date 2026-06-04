/**
 * Session-cookie helpers.
 *
 * `Secure` is attached ONLY when the connection is actually HTTPS. A Secure
 * cookie is silently dropped by browsers over plain HTTP, so a self-hosted
 * install served on http://localhost would "log in" (200 + user body) but the
 * cookie never sticks — every subsequent authenticated/polling request then
 * 401s in a loop. We honor X-Forwarded-Proto first so a TLS-terminating proxy
 * (Cloudflare tunnel, nginx) still yields Secure even though the backend is
 * reached over HTTP.
 *
 * SameSite=Strict does not require Secure, so omitting it on HTTP is valid.
 */

export function requestIsHttps(request: Request): boolean {
  const xfp = request.headers.get('x-forwarded-proto');
  if (xfp) return xfp.split(',')[0]!.trim().toLowerCase() === 'https';
  try {
    return new URL(request.url).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Build the `Set-Cookie` value for the session token. */
export function sessionCookie(token: string, request: Request, opts: { maxAge?: number } = {}): string {
  const parts = [`session_token=${token}`, 'HttpOnly', 'SameSite=Strict', 'Path=/'];
  if (requestIsHttps(request)) parts.push('Secure');
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  return parts.join('; ');
}

/** Build the `Set-Cookie` value that clears the session (Max-Age=0). */
export function clearSessionCookie(request: Request): string {
  return sessionCookie('', request, { maxAge: 0 });
}
