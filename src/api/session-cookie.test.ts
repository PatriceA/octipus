import { describe, expect, test } from 'bun:test';
import { clearSessionCookie, requestIsHttps, sessionCookie } from './session-cookie';

/**
 * Regression: cookies were always stamped `Secure`, so a self-hosted install
 * on http://localhost "logged in" (200 + user) but the browser dropped the
 * Secure cookie over HTTP — every authenticated request then 401-looped.
 * Secure must track the actual connection scheme, with X-Forwarded-Proto
 * (TLS-terminating proxy) taking precedence over the request URL.
 */

const req = (url: string, headers: Record<string, string> = {}) =>
  new Request(url, { headers });

describe('requestIsHttps', () => {
  test('plain HTTP request is not https', () => {
    expect(requestIsHttps(req('http://localhost:3005/api/auth/login'))).toBe(false);
  });
  test('direct HTTPS request is https', () => {
    expect(requestIsHttps(req('https://octi.example.com/api/auth/login'))).toBe(true);
  });
  test('X-Forwarded-Proto=https wins over an http backend URL (TLS proxy)', () => {
    expect(requestIsHttps(req('http://127.0.0.1:3005/api/auth/login', { 'x-forwarded-proto': 'https' }))).toBe(true);
  });
  test('X-Forwarded-Proto=http forces http even on an https URL', () => {
    expect(requestIsHttps(req('https://127.0.0.1/api/auth/login', { 'x-forwarded-proto': 'http' }))).toBe(false);
  });
  test('only the first proto in a comma list is considered', () => {
    expect(requestIsHttps(req('http://x/y', { 'x-forwarded-proto': 'https, http' }))).toBe(true);
  });
});

describe('sessionCookie', () => {
  test('omits Secure on HTTP so the browser keeps the cookie', () => {
    const c = sessionCookie('tok', req('http://localhost:3005/'));
    expect(c).toContain('session_token=tok');
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Strict');
    expect(c).toContain('Path=/');
    expect(c).not.toContain('Secure');
  });
  test('adds Secure on HTTPS', () => {
    expect(sessionCookie('tok', req('https://octi.example.com/'))).toContain('Secure');
  });
  test('clearSessionCookie sets Max-Age=0 and empty token', () => {
    const c = clearSessionCookie(req('http://localhost:3005/'));
    expect(c).toContain('session_token=;');
    expect(c).toContain('Max-Age=0');
    expect(c).not.toContain('Secure');
  });
});
