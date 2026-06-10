import { describe, expect, test } from 'bun:test';
import { safeUrl, sanitizeHtmlFragment } from './sanitize';

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
