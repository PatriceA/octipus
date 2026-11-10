/**
 * The web-read fetch (what the plugin host API's web:read runs): the body is read
 * as a stream and cut at the cap whatever the response declares, and a
 * refusal by the SSRF guard is told apart from any other failure.
 */
import { describe, expect, test, vi } from 'vitest';

const h = vi.hoisted(() => ({ respond: null as null | ((url: string) => Response | Promise<Response>), pulled: 0 }));
vi.mock('@/utils/sanitize', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/utils/sanitize')>();
  return { ...real, fetchGuarded: async (url: string, init?: RequestInit) => (h.respond ? h.respond(url) : real.fetchGuarded(url, init)) };
});

const { fetchArticle, MAX_HTML_BYTES, readCapped, WebReadError } = await import('./fetch');

/** An endless chunked HTML body (no Content-Length), counting what is pulled. */
function endless(): Response {
  const chunk = new TextEncoder().encode(`<p>${'x'.repeat(64 * 1024 - 7)}</p>`);
  h.pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      h.pulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/html' } });
}

describe('web-read fetch', () => {
  test('a body without a Content-Length is cut at the cap, and reading stops there', async () => {
    const text = await readCapped(endless(), 200_000);
    expect(Buffer.byteLength(text)).toBe(200_000);
    expect(h.pulled).toBeLessThan(200_000 + 3 * 64 * 1024);

    h.respond = () => endless();
    const doc = await fetchArticle('https://news.example.com/huge');
    expect(doc.textContent.length).toBeLessThanOrEqual(MAX_HTML_BYTES);
    expect(h.pulled).toBeLessThan(MAX_HTML_BYTES + 3 * 64 * 1024);
    h.respond = null;
  });

  test('a declared size over the cap is refused before reading', async () => {
    h.respond = () => new Response('<p>x</p>', { headers: { 'content-type': 'text/html', 'content-length': String(MAX_HTML_BYTES + 1) } });
    await expect(fetchArticle('https://news.example.com/big')).rejects.toMatchObject({ name: 'WebReadError', blocked: false });
    h.respond = null;
  });

  test('the SSRF guard\'s refusal is marked blocked; other failures are not', async () => {
    const blocked = await fetchArticle('http://10.0.0.1/admin').catch((e) => e);
    expect(blocked).toBeInstanceOf(WebReadError);
    expect(blocked.blocked).toBe(true);
    h.respond = () => new Response('nope', { status: 500, headers: { 'content-type': 'text/html' } });
    const failed = await fetchArticle('https://news.example.com/down').catch((e) => e);
    expect(failed).toMatchObject({ name: 'WebReadError', blocked: false });
    h.respond = () => new Response('{}', { headers: { 'content-type': 'application/json' } });
    expect(await fetchArticle('https://news.example.com/json').catch((e) => e)).toMatchObject({ blocked: false });
    h.respond = null;
  });
});
