import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {  } from 'vitest';
import { Vault } from '@/security/vault';
import { parseRss, resolveVaultHeaders } from './refresh';

describe('parseRss', () => {
  test('extracts items from RSS 2.0', () => {
    const xml = `<?xml version="1.0"?><rss><channel>
      <item><title>One</title><link>https://a/1</link><pubDate>Mon, 01 Jan 2024</pubDate><description>desc1</description></item>
      <item><title><![CDATA[Two & me]]></title><link>https://a/2</link><description><![CDATA[<p>html</p>]]></description></item>
    </channel></rss>`;
    const items = parseRss(xml);
    expect(items.length).toBe(2);
    expect(items[0].title).toBe('One');
    expect(items[0].link).toBe('https://a/1');
    expect(items[0].pubDate).toBe('Mon, 01 Jan 2024');
    expect(items[1].title).toBe('Two & me');
    expect(items[1].summary).toBe('<p>html</p>');
  });

  test('extracts items from Atom feed', () => {
    const xml = `<feed>
      <entry><title>A</title><link href="https://x/a"/><updated>2024-01-01</updated><summary>s</summary></entry>
    </feed>`;
    const items = parseRss(xml);
    expect(items.length).toBe(1);
    expect(items[0].title).toBe('A');
    expect(items[0].link).toBe('https://x/a');
    expect(items[0].pubDate).toBe('2024-01-01');
  });

  test('returns [] on garbage', () => {
    expect(parseRss('<not-a-feed/>')).toEqual([]);
  });
});

describe('resolveVaultHeaders', () => {
  const getByNameSpy = vi.spyOn(Vault.prototype, 'getByName');

  beforeEach(() => {
    getByNameSpy.mockReset();
  });

  afterEach(() => {
    getByNameSpy.mockReset();
  });

  test('passes through headers with no placeholders', async () => {
    const out = await resolveVaultHeaders({ accept: 'application/json' }, {
      principalId: 'user-1',
      workspaceId: 'ws-1',
    });
    expect(out).toEqual({ accept: 'application/json' });
    expect(getByNameSpy).not.toHaveBeenCalled();
  });

  test('resolves a single placeholder via the vault', async () => {
    getByNameSpy.mockResolvedValueOnce('gho_realtoken');
    const out = await resolveVaultHeaders(
      { authorization: 'Bearer ${vault.github_token}' },
      { principalId: 'user-1', workspaceId: 'ws-1' },
    );
    expect(out.authorization).toBe('Bearer gho_realtoken');
    expect(getByNameSpy).toHaveBeenCalledWith('user-1', 'github_token', { workspaceId: 'ws-1' });
  });

  test('deduplicates lookups when the same key is referenced twice', async () => {
    getByNameSpy.mockResolvedValueOnce('tok');
    const out = await resolveVaultHeaders(
      { authorization: 'Bearer ${vault.k}', 'x-other': 'pre-${vault.k}-post' },
      { principalId: 'p', workspaceId: null },
    );
    expect(out).toEqual({ authorization: 'Bearer tok', 'x-other': 'pre-tok-post' });
    expect(getByNameSpy).toHaveBeenCalledTimes(1);
  });

  test('throws when the secret is missing', async () => {
    getByNameSpy.mockResolvedValueOnce(null);
    await expect(
      resolveVaultHeaders(
        { authorization: 'Bearer ${vault.missing}' },
        { principalId: 'user-1', workspaceId: null },
      ),
    ).rejects.toThrow(/vault: secret "missing" not found/);
  });

  test('refuses to run without a principalId', async () => {
    await expect(
      resolveVaultHeaders({ authorization: 'Bearer ${vault.x}' }, { principalId: '' }),
    ).rejects.toThrow(/missing principalId/);
    expect(getByNameSpy).not.toHaveBeenCalled();
  });

  test('handles multiple distinct keys in one call', async () => {
    getByNameSpy.mockImplementation(async (_uid, name) => (name === 'a' ? 'AA' : 'BB'));
    const out = await resolveVaultHeaders(
      { h1: 'x ${vault.a}', h2: 'y ${vault.b}' },
      { principalId: 'p', workspaceId: 'w' },
    );
    expect(out).toEqual({ h1: 'x AA', h2: 'y BB' });
    expect(getByNameSpy).toHaveBeenCalledTimes(2);
  });
});
