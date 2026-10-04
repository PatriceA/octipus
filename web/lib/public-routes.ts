/**
 * Pages that render without a signed-in user. The app shell shows them bare
 * (no sidebar, no sign-in redirect), and a 401 on one of them is "not signed
 * in yet", not an expired session to bounce to the sign-in page from.
 *
 * `/join/:token` previews an invite before sign-in and offers sign-in itself.
 */
const PUBLIC_ROUTES = ['/login', '/register', '/forgot-password', '/setup', '/join/'];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_ROUTES.some((route) => pathname.startsWith(route));
}
