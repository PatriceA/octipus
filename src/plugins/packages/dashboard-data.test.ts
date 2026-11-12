import { describe, expect, test } from 'vitest';
import { linkAllowed, MAX_WIDGET_JSON, widgetData } from './dashboard-data';

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

  test('each type takes exactly its shape; the declared type wins', () => {
    expect(widgetData(asText({ value: 3 }), 'stat', [])).toEqual({ ok: true, data: { type: 'stat', value: 3 } });
    expect(widgetData(asText({ type: 'stat', value: 3 }), 'stat', [])).toMatchObject({ ok: true });
    expect(widgetData(asText({ type: 'text', text: 'x' }), 'stat', [])).toMatchObject({ ok: false, error: expect.stringContaining('text data for a stat widget') });
    expect(widgetData(asText({ value: 3, html: '<b>' }), 'stat', [])).toMatchObject({ ok: false });
    expect(widgetData(asText({ value: { nested: true } }), 'stat', [])).toMatchObject({ ok: false });
    expect(widgetData(asText({ text: 'x'.repeat(20_001) }), 'text', [])).toMatchObject({ ok: false });
    expect(widgetData(asText([1, 2]), 'text', [])).toMatchObject({ ok: false });
  });

  test('lists, rows and charts are bounded; chart keys distinct', () => {
    const rows = Array.from({ length: 501 }, () => ({ values: { a: 1 } }));
    expect(widgetData(asText({ columns: [{ key: 'a', label: 'A' }], rows }), 'table', [])).toMatchObject({ ok: false });
    expect(widgetData(asText({ columns: [{ key: 'a', label: 'A' }], rows: rows.slice(1) }), 'table', [])).toMatchObject({ ok: true });
    expect(widgetData(asText({ kind: 'line', x: 'm', series: [{ key: 'm', label: 'M' }], points: [] }), 'chart', [])).toMatchObject({ ok: false, error: expect.stringContaining('distinct') });
    expect(widgetData(asText({ kind: 'line', x: 'm', series: Array.from({ length: 9 }, (_, i) => ({ key: `s${i}`, label: 'S' })), points: [] }), 'chart', [])).toMatchObject({ ok: false });
    expect(widgetData({ content: [{ type: 'text', text: 'x'.repeat(MAX_WIDGET_JSON + 1) }] }, 'text', [])).toMatchObject({ ok: false });
  });

  test('links in lists and tables are checked; a failing or empty tool is refused', () => {
    const list = (url: string) => asText({ items: [{ title: 't', link: { url } }] });
    expect(widgetData(list('https://api.example.com/1'), 'list', ['api.example.com'])).toMatchObject({ ok: true });
    expect(widgetData(list('https://other.example.com/1'), 'list', ['api.example.com'])).toMatchObject({ ok: false });
    expect(widgetData({ isError: true, content: [{ type: 'text', text: 'down' }] }, 'text', [])).toMatchObject({ ok: false, error: 'The tool failed: down' });
    expect(widgetData(null, 'text', [])).toMatchObject({ ok: false });
    expect(widgetData({ content: [] }, 'text', [])).toMatchObject({ ok: false });
    expect(widgetData({ structuredContent: { text: 'hi' }, content: [] }, 'text', [])).toEqual({ ok: true, data: { type: 'text', text: 'hi' } });
  });
});
