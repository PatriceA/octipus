import { describe, expect, test } from 'bun:test';
import { escapeHtml, renderRssFeed, renderTemplate, sanitizeTemplate } from './render';

describe('escapeHtml', () => {
  test('escapes the five entities', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
  });
  test('null/undefined → empty', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});

describe('sanitizeTemplate', () => {
  test('strips <script> and inline handlers', () => {
    const out = sanitizeTemplate(
      `<div onclick="x()">hi</div><script>alert(1)</script><img onerror='y()'/>`,
    );
    expect(out).not.toContain('script');
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('onerror');
  });
});

describe('renderTemplate', () => {
  test('substitutes values and escapes', () => {
    const out = renderTemplate('<p>{{data.x}}</p>', { data: { x: '<b>z</b>' } });
    expect(out).toBe('<p>&lt;b&gt;z&lt;/b&gt;</p>');
  });

  test('each block iterates and escapes', () => {
    const out = renderTemplate(
      '<ul>{{#each data.items}}<li>{{this.t}}</li>{{/each}}</ul>',
      { data: { items: [{ t: 'a' }, { t: '<b>' }] } },
    );
    expect(out).toBe('<ul><li>a</li><li>&lt;b&gt;</li></ul>');
  });

  test('missing path → empty string', () => {
    expect(renderTemplate('<i>{{data.missing.x}}</i>', { data: {} })).toBe('<i></i>');
  });

  test('XSS via template expression cannot inject script', () => {
    const out = renderTemplate('<div>{{data.x}}</div>', { data: { x: '<script>alert(1)</script>' } });
    expect(out).not.toContain('<script');
  });

  test('XSS via template body is stripped by sanitizer', () => {
    const out = renderTemplate('<div>{{data.x}}</div><script>bad()</script>', { data: { x: 'ok' } });
    expect(out).toBe('<div>ok</div>');
  });
});

describe('renderRssFeed', () => {
  test('produces XML with escaped items', () => {
    const xml = renderRssFeed({
      title: 'T & T',
      link: 'https://x',
      items: [{ title: 'A<>', link: 'https://x/1', summary: 'sum' }],
    });
    expect(xml).toContain('<title>T &amp; T</title>');
    expect(xml).toContain('<title>A&lt;&gt;</title>');
  });
});
