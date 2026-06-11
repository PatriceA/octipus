import { describe, expect, test } from 'bun:test';
import { safeUrl, sanitizeHtmlFragment, sanitizeStyle } from './sanitize';

describe('sanitizeHtmlFragment', () => {
  test('keeps allowlisted formatting tags', () => {
    const out = sanitizeHtmlFragment('<p>Hello <strong>world</strong> and <em>all</em></p>');
    expect(out).toBe('<p>Hello <strong>world</strong> and <em>all</em></p>');
  });

  test('drops <script> entirely (content too)', () => {
    const out = sanitizeHtmlFragment('<p>safe</p><script>alert(1)</script>');
    expect(out).toContain('<p>safe</p>');
    expect(out).not.toContain('alert');
    expect(out).not.toContain('<script');
  });

  test('strips event-handler and style attributes', () => {
    const out = sanitizeHtmlFragment('<p onclick="steal()" style="x">hi</p>');
    expect(out).toBe('<p>hi</p>');
  });

  test('drops javascript: and data: hrefs but keeps http(s)', () => {
    expect(sanitizeHtmlFragment('<a href="javascript:alert(1)">x</a>')).toBe('<a>x</a>');
    expect(sanitizeHtmlFragment('<a href="https://example.com">x</a>')).toBe('<a href="https://example.com">x</a>');
  });

  test('drops img src pointing at a private/metadata IP', () => {
    expect(sanitizeHtmlFragment('<img src="http://169.254.169.254/latest">')).toBe('<img>');
    expect(sanitizeHtmlFragment('<img src="https://cdn.example.com/a.png" alt="a">'))
      .toBe('<img src="https://cdn.example.com/a.png" alt="a">');
  });

  test('unwraps unknown tags but keeps their text', () => {
    expect(sanitizeHtmlFragment('<marquee>scrolly</marquee>')).toBe('scrolly');
  });

  test('escapes stray angle brackets in text', () => {
    expect(sanitizeHtmlFragment('<p>1 < 2 && 3 > 2</p>')).toContain('1 &lt; 2');
  });
});

describe('sanitizeStyle', () => {
  test('keeps cosmetic declarations', () => {
    expect(sanitizeStyle('color: #333; font-weight: bold; text-align: center'))
      .toBe('color: #333; font-weight: bold; text-align: center');
  });
  test('drops resource-loading and script vectors', () => {
    // `background` shorthand isn't even allowlisted now — dropped on property.
    expect(sanitizeStyle('background: url(https://t.example/p.gif)')).toBe('');
    expect(sanitizeStyle('background-color: url(https://t.example/p.gif)')).toBe('');
    expect(sanitizeStyle('width: expression(alert(1))')).toBe('');
    expect(sanitizeStyle('color: red; behavior: url(x.htc)')).toBe('color: red');
  });
  test('defeats whitespace-split function tokens (url\\n( / expression\\t()', () => {
    expect(sanitizeStyle('background-color: url\n(https://t.example/p.gif)')).toBe('');
    expect(sanitizeStyle('width: expression\t(alert(1))')).toBe('');
  });
  test('blocks host-context functions (var) but keeps color functions (rgb/rgba)', () => {
    expect(sanitizeStyle('color: var(--leak)')).toBe('');
    expect(sanitizeStyle('color: rgb(10, 20, 30)')).toBe('color: rgb(10, 20, 30)');
    expect(sanitizeStyle('background-color: rgba(0,0,0,0.5)')).toBe('background-color: rgba(0,0,0,0.5)');
  });
  test('drops non-allowlisted properties (e.g. position for overlays)', () => {
    expect(sanitizeStyle('position: fixed; top: 0; color: blue')).toBe('color: blue');
  });
});

describe('sanitizeHtmlFragment — presentational (email) mode', () => {
  test('keeps sanitized inline style', () => {
    const out = sanitizeHtmlFragment('<p style="color:#08c;position:fixed">hi</p>', { presentational: true });
    expect(out).toBe('<p style="color: #08c">hi</p>');
  });
  test('keeps table layout attributes', () => {
    const out = sanitizeHtmlFragment(
      '<table width="600" bgcolor="#fff"><tr><td align="center" colspan="2">x</td></tr></table>',
      { presentational: true },
    );
    expect(out).toContain('width="600"');
    expect(out).toContain('bgcolor="#fff"');
    expect(out).toContain('align="center"');
    expect(out).toContain('colspan="2"');
  });
  test('still drops scripts and unsafe urls in presentational mode', () => {
    const out = sanitizeHtmlFragment('<p style="x">a</p><script>bad()</script><a href="javascript:1">b</a>', { presentational: true });
    expect(out).not.toContain('bad');
    expect(out).not.toContain('javascript:');
  });
  test('reader (default) mode still strips style entirely', () => {
    expect(sanitizeHtmlFragment('<p style="color:red">hi</p>')).toBe('<p>hi</p>');
  });
});

describe('safeUrl', () => {
  test('rejects javascript and data schemes', () => {
    expect(safeUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeUrl('data:text/html,<script>')).toBeUndefined();
  });
  test('rejects private/loopback hosts', () => {
    expect(safeUrl('http://localhost/x')).toBeUndefined();
    expect(safeUrl('http://10.0.0.1/x')).toBeUndefined();
    expect(safeUrl('http://169.254.169.254/')).toBeUndefined();
  });
  test('keeps http(s) and relative urls', () => {
    expect(safeUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(safeUrl('/relative/path')).toBe('/relative/path');
  });
});
