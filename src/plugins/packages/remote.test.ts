/**
 * Remote install pieces that need no database (./remote.ts): a registry
 * index is read entry by entry, sha256 values are normalised, and a download
 * goes through the SSRF-guarded fetch, https only on every hop, capped.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; init: RequestInit; maxRedirects: number | undefined }>,
  respond: null as unknown as (url: string) => Response | Promise<Response>,
}));

vi.mock('@/utils/sanitize', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/utils/sanitize')>(),
  fetchGuarded: async (url: string, init: RequestInit, maxRedirects?: number) => {
    fixture.calls.push({ url, init, maxRedirects });
    return fixture.respond(url);
  },
}));

const { downloadHttps, normalizeSha256, parseRegistryIndex, RemoteFetchError } = await import('./remote');

const SHA = 'ab'.repeat(32);
const entry = (over: Record<string, unknown> = {}) => ({
  name: 'finapi', version: '1.2.0', description: 'Bank accounts', url: 'https://plugins.example.com/finapi-1.2.0.tar.gz', sha256: SHA, ...over,
});

describe('parseRegistryIndex', () => {
  test('takes valid entries and normalises their sha256', () => {
    const { entries, problems } = parseRegistryIndex({ packages: [entry(), entry({ name: 'datev', sha256: `sha256:${SHA.toUpperCase()}`, description: undefined })] }, 'Acme');
    expect(problems).toEqual([]);
    expect(entries).toEqual([
      { registry: 'Acme', name: 'finapi', version: '1.2.0', description: 'Bank accounts', url: 'https://plugins.example.com/finapi-1.2.0.tar.gz', sha256: `sha256:${SHA}` },
      expect.objectContaining({ name: 'datev', description: null, sha256: `sha256:${SHA}` }),
    ]);
  });

  test('skips each entry that does not fit, saying why, and keeps the rest', () => {
    const { entries, problems } = parseRegistryIndex({
      packages: [
        entry({ url: 'http://plugins.example.com/x.tar.gz' }),
        entry({ name: 'Bad Name' }),
        entry({ name: 'system' }),
        entry({ version: 'latest' }),
        entry({ sha256: 'deadbeef' }),
        entry({ description: 42 }),
        entry({ url: 'https://user:pw@plugins.example.com/x.tar.gz' }),
        'nope',
        entry({ name: 'ok-one' }),
      ],
    }, 'Acme');
    expect(entries.map((e) => e.name)).toEqual(['ok-one']);
    expect(problems).toHaveLength(8);
    expect(problems[0]).toMatch(/packages\[0\] \(finapi\): url \(https\)/);
    expect(problems[4]).toMatch(/sha256/);
    expect(problems[7]).toMatch(/not an object/);
  });

  test('an index that is not { packages: [...] } is one problem', () => {
    expect(parseRegistryIndex([entry()], 'Acme')).toEqual({ entries: [], problems: [expect.stringContaining('"packages"')] });
    expect(parseRegistryIndex(null, 'Acme').entries).toEqual([]);
  });
});

describe('normalizeSha256', () => {
  test('with or without the prefix, any case; anything else is null', () => {
    expect(normalizeSha256(SHA)).toBe(`sha256:${SHA}`);
    expect(normalizeSha256(`SHA256:${SHA.toUpperCase()}`)).toBe(`sha256:${SHA}`);
    expect(normalizeSha256('sha256:abc')).toBeNull();
    expect(normalizeSha256(42)).toBeNull();
  });
});

describe('downloadHttps', () => {
  beforeEach(() => {
    fixture.calls = [];
  });

  test('fetches through the SSRF guard without letting it follow redirects, and reads the body', async () => {
    fixture.respond = () => new Response('hello');
    const body = await downloadHttps('https://plugins.example.com/a.tgz', { maxBytes: 100, timeoutMs: 1000 });
    expect(body.toString()).toBe('hello');
    expect(fixture.calls).toEqual([{ url: 'https://plugins.example.com/a.tgz', init: expect.objectContaining({ redirect: 'manual' }), maxRedirects: 0 }]);
  });

  test('follows an https redirect through the guard again; refuses one to http', async () => {
    fixture.respond = (url) => url.endsWith('/a.tgz')
      ? new Response(null, { status: 302, headers: { location: '/b.tgz' } })
      : new Response('moved');
    expect((await downloadHttps('https://plugins.example.com/a.tgz', { maxBytes: 100, timeoutMs: 1000 })).toString()).toBe('moved');
    expect(fixture.calls.map((c) => c.url)).toEqual(['https://plugins.example.com/a.tgz', 'https://plugins.example.com/b.tgz']);

    fixture.calls = [];
    fixture.respond = () => new Response(null, { status: 301, headers: { location: 'http://169.254.169.254/latest' } });
    await expect(downloadHttps('https://plugins.example.com/a.tgz', { maxBytes: 100, timeoutMs: 1000 })).rejects.toThrow(/Only https/);
    expect(fixture.calls).toHaveLength(1);
  });

  test('stops after three redirects', async () => {
    fixture.respond = (url) => new Response(null, { status: 302, headers: { location: `${url}x` } });
    await expect(downloadHttps('https://plugins.example.com/a', { maxBytes: 100, timeoutMs: 1000 })).rejects.toThrow(/more than 3 times/);
    expect(fixture.calls).toHaveLength(4);
  });

  test('refuses http, a URL with credentials, an error status, and a body over the cap', async () => {
    fixture.respond = () => new Response('x'.repeat(500));
    await expect(downloadHttps('http://plugins.example.com/a', { maxBytes: 100, timeoutMs: 1000 })).rejects.toThrow(RemoteFetchError);
    await expect(downloadHttps('https://u:p@plugins.example.com/a', { maxBytes: 100, timeoutMs: 1000 })).rejects.toThrow(/credentials/);
    expect(fixture.calls).toHaveLength(0);
    await expect(downloadHttps('https://plugins.example.com/a', { maxBytes: 100, timeoutMs: 1000 })).rejects.toThrow(/larger than 100 bytes/);
    fixture.respond = () => new Response('x', { headers: { 'content-length': '1000000' } });
    await expect(downloadHttps('https://plugins.example.com/a', { maxBytes: 100, timeoutMs: 1000 })).rejects.toThrow(/larger than/);
    fixture.respond = () => new Response('nope', { status: 404 });
    await expect(downloadHttps('https://plugins.example.com/a', { maxBytes: 100, timeoutMs: 1000 })).rejects.toThrow(/HTTP 404/);
  });

  test('a blocked address (the guard throws) is a fetch error', async () => {
    fixture.respond = () => { throw new Error('URL blocked (SSRF guard): IP 10.0.0.1 is in a private/reserved range'); };
    await expect(downloadHttps('https://internal.example.com/a', { maxBytes: 100, timeoutMs: 1000 })).rejects.toThrow(/SSRF guard/);
  });
});
