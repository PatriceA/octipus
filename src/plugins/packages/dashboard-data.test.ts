import { describe, expect, test } from 'vitest';
import { _resetLinkCache, linkAllowed, linkHostPublic, MAX_WIDGET_JSON, widgetData as check } from './dashboard-data';

/** Every name resolves to a public address, unless named otherwise. */
const resolve = async (host: string) => (host.startsWith('priv') ? ['10.0.0.5'] : host.startsWith('mixed') ? ['93.184.216.34', '127.0.0.1'] : host.startsWith('none') ? [] : ['93.184.216.34']);
const widgetData = (r: unknown, t: Parameters<typeof check>[1], n: readonly string[]) => check(r, t, n, resolve);

const asText = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });

describe('widget data (docs/PLUGIN-PACKAGES.md#dashboards)', () => {
  test('a link is https, to a declared host only, without credentials', () => {
    expect(linkAllowed('https://api.example.com/x', ['api.example.com'])).toBe(true);
    expect(linkAllowed('https://a.example.com/x', ['*.example.com'])).toBe(true);
    expect(linkAllowed('http://api.example.com/x', ['api.example.com'])).toBe(false);
    expect(linkAllowed('https://user:pw@api.example.com/x', ['api.example.com'])).toBe(false);
    expect(linkAllowed('https://api.example.com:8443/x', ['api.example.com'])).toBe(false);
    expect(linkAllowed('https://evil.example.net/', ['api.example.com'])).toBe(false);
    expect(linkAllowed('javascript:alert(1)', ['api.example.com'])).toBe(false);
    expect(linkAllowed('https://api.example.com/x', [])).toBe(false);
  });

  test('each type takes exactly its shape; the declared type wins', async () => {
    expect(await widgetData(asText({ value: 3 }), 'stat', [])).toEqual({ ok: true, data: { type: 'stat', value: 3 } });
    expect(await widgetData(asText({ type: 'stat', value: 3 }), 'stat', [])).toMatchObject({ ok: true });
    expect(await widgetData(asText({ type: 'text', text: 'x' }), 'stat', [])).toMatchObject({ ok: false, error: expect.stringContaining('text data for a stat widget') });
    expect(await widgetData(asText({ value: 3, html: '<b>' }), 'stat', [])).toMatchObject({ ok: false });
    expect(await widgetData(asText({ value: { nested: true } }), 'stat', [])).toMatchObject({ ok: false });
    expect(await widgetData(asText({ text: 'x'.repeat(20_001) }), 'text', [])).toMatchObject({ ok: false });
    expect(await widgetData(asText([1, 2]), 'text', [])).toMatchObject({ ok: false });
  });

  test('lists, rows and charts are bounded; chart keys distinct', async () => {
    const rows = Array.from({ length: 501 }, () => ({ values: { a: 1 } }));
    expect(await widgetData(asText({ columns: [{ key: 'a', label: 'A' }], rows }), 'table', [])).toMatchObject({ ok: false });
    expect(await widgetData(asText({ columns: [{ key: 'a', label: 'A' }], rows: rows.slice(1) }), 'table', [])).toMatchObject({ ok: true });
    expect(await widgetData(asText({ kind: 'line', x: 'm', series: [{ key: 'm', label: 'M' }], points: [] }), 'chart', [])).toMatchObject({ ok: false, error: expect.stringContaining('distinct') });
    expect(await widgetData(asText({ kind: 'line', x: 'm', series: Array.from({ length: 9 }, (_, i) => ({ key: `s${i}`, label: 'S' })), points: [] }), 'chart', [])).toMatchObject({ ok: false });
    expect(await widgetData({ content: [{ type: 'text', text: 'x'.repeat(MAX_WIDGET_JSON + 1) }] }, 'text', [])).toMatchObject({ ok: false });
  });

  test('links in lists and tables are checked; a failing or empty tool is refused', async () => {
    const list = (url: string) => asText({ items: [{ title: 't', link: { url } }] });
    expect(await widgetData(list('https://api.example.com/1'), 'list', ['api.example.com'])).toMatchObject({ ok: true });
    expect(await widgetData(list('https://other.example.com/1'), 'list', ['api.example.com'])).toMatchObject({ ok: false });
    expect(await widgetData({ isError: true, content: [{ type: 'text', text: 'down' }] }, 'text', [])).toMatchObject({ ok: false, error: 'The tool failed: down' });
    expect(await widgetData(null, 'text', [])).toMatchObject({ ok: false });
    expect(await widgetData({ content: [] }, 'text', [])).toMatchObject({ ok: false });
    expect(await widgetData({ structuredContent: { text: 'hi' }, content: [] }, 'text', [])).toEqual({ ok: true, data: { type: 'text', text: 'hi' } });
  });

  test('a link\'s host is public: no IP literal, local name, or private resolution', async () => {
    _resetLinkCache();
    expect(await linkHostPublic('api.example.com', resolve)).toBe(true);
    for (const host of ['10.0.0.1', '[::1]', 'localhost', 'intranet', 'ci.corp', 'nas.local', 'svc.internal', 'priv.example.com', 'mixed.example.com', 'none.example.com']) {
      expect(await linkHostPublic(host, resolve), host).toBe(false);
    }
    expect(await linkHostPublic('x.example.com', async () => { throw new Error('NXDOMAIN'); })).toBe(false);
    const list = (url: string) => asText({ items: [{ title: 't', link: { url } }] });
    expect(await widgetData(list('https://priv.example.com/1'), 'list', ['*.example.com'])).toMatchObject({ ok: false, error: expect.stringContaining('private') });
    expect(await widgetData(list('https://ok.example.com/1'), 'list', ['*.example.com'])).toMatchObject({ ok: true });
  });
});
