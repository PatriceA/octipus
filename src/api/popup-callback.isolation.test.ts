/**
 * The OAuth popup callback pages, through the real application: what the
 * request carries never leaves the script's string, and the page's own nonce
 * policy survives the global security headers (which used to replace it, so
 * the script never ran).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import { popupCallbackPage } from './popup-callback';

type App = { handle: (request: Request) => Promise<Response> };
let app: App;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-popup-callback-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { initializeStorage } = await import('@/db/storage');
  initializeStorage({ mode: 'embedded' });
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { createServer } = await import('./server');
  app = createServer() as unknown as App;
}, 120_000);

const BREAKOUT = '</script><script>alert(1)</script>';

function scriptOf(html: string): { nonce: string; body: string } {
  const m = /<script nonce="([^"]+)">([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('no script');
  return { nonce: m[1], body: m[2] };
}

function expectContained(res: Response, html: string): void {
  const csp = res.headers.get('content-security-policy') ?? '';
  const { nonce, body } = scriptOf(html);
  expect(csp).toContain(`script-src 'nonce-${nonce}'`);
  expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
  // One script element, and the payload stayed inside its string.
  expect(html.match(/<script/g)).toHaveLength(1);
  expect(body).not.toContain('</script');
  expect(html).toContain('&lt;/script&gt;');
}

describe('OAuth popup callback pages', () => {
  test('a connector callback with a script in ?error= keeps it in the string, under its own nonce policy', async () => {
    const res = await app.handle(new Request(`http://localhost/api/connectors/github/callback?error=${encodeURIComponent(BREAKOUT)}`));
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expectContained(res, html);
    expect(html).toContain('connector:error');
  });

  test('a sign-in provider callback with a script in error_description does the same', async () => {
    const res = await app.handle(new Request(`http://localhost/api/auth/oauth/google/callback?error=denied&error_description=${encodeURIComponent(BREAKOUT)}`));
    const html = await res.text();
    expectContained(res, html);
    expect(html).toContain('oauth_callback');
  });

  test('other routes still get the global policy', async () => {
    const res = await app.handle(new Request('http://localhost/api/health'));
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
  });

  test('each page has a fresh nonce; line separators are escaped', () => {
    const a = popupCallbackPage({ ok: true, heading: 'x', detail: 'y', message: { s: `a${String.fromCharCode(0x2028)}b` } });
    const b = popupCallbackPage({ ok: true, heading: 'x', detail: 'y', message: {} });
    expect(scriptOf(a.html).nonce).not.toBe(scriptOf(b.html).nonce);
    expect(a.html).not.toContain(String.fromCharCode(0x2028));
    expect(a.csp).toContain("frame-ancestors 'none'");
  });
});
