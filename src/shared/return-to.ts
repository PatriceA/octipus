/**
 * Where to send a user after sign-in or registration.
 *
 * `returnTo` arrives in a URL anyone can craft (`/login?returnTo=…`), so it is
 * honoured only as a same-origin path: it starts with exactly one `/`. That
 * rules out a scheme (`https://evil`, `javascript:`), a protocol-relative URL
 * (`//evil`) and the backslash forms browsers read as one (`/\evil`). Control
 * characters and whitespace are refused too: browsers strip tabs and newlines
 * from a URL, so `/\t/evil` would become `//evil` after the check passed.
 *
 * Shared by the server (`/auth/login`, `/auth/register`) and the web login page.
 */

/** Longer than any real in-app path; a bound on what the server echoes back. */
export const RETURN_TO_MAX_LENGTH = 2048;

export function isSafeReturnTo(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > RETURN_TO_MAX_LENGTH) return false;
  if (value[0] !== '/' || value[1] === '/') return false;
  if (value.includes('\\')) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    // C0 controls and space, DEL and C1 controls.
    if (code <= 0x20 || (code >= 0x7f && code <= 0x9f)) return false;
  }
  return true;
}

/**
 * The sign-in page URL that brings the user back to `current` (a path with its
 * query) afterwards. Plain `/login` when there is nowhere better to return to.
 */
export function loginPathReturningTo(current: string): string {
  if (current === '/' || !isSafeReturnTo(current) || current === '/login' || current.startsWith('/login?')) {
    return '/login';
  }
  return `/login?returnTo=${encodeURIComponent(current)}`;
}
