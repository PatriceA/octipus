import { describe, expect, test } from 'vitest';
import { visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { hostname } from 'node:os';
import { fileUrlFor, hyperlink, linkify, linkifyStyled, safeUrl, sanitizeHyperlinks } from './hyperlinks';
import { displayText } from './terminal-text';

const links = (text: string) => [...text.matchAll(/\x1b\]8;;([^\x1b]*)\x1b\\([^\x1b]*)\x1b\]8;;\x1b\\/g)].map(m => [m[2], m[1]]);

describe('safe URLs', () => {
  test('only http, https and file; nothing that can end or extend the sequence', () => {
    expect(safeUrl('https://example.com/a?b=c#d')).toBe('https://example.com/a?b=c#d');
    expect(safeUrl('file:///etc/hosts')).toBe('file:///etc/hosts');
    expect(safeUrl('file://localhost/etc/hosts')).toBe('file:///etc/hosts');
    expect(safeUrl(fileUrlFor('a.ts:1', '/repo'))).not.toBeNull();
    // Another machine's file: a UNC path, which Windows opens over SMB with the user's credentials.
    expect(safeUrl('file://attacker.example/share/x')).toBeNull();
    expect(safeUrl('file://10.0.0.5/c$/x')).toBeNull();
    for (const bad of ['javascript:alert(1)', 'ssh://host', 'data:text/html,x', 'https://x.com/\x07\x1b]52;c;AAAA', 'https://x.com/a b', 'not a url', '']) {
      expect(safeUrl(bad)).toBeNull();
    }
    expect(hyperlink('text', 'javascript:alert(1)')).toBe('text');
  });

  test('a rendered link to another scheme is dropped, its text kept', () => {
    const row = `see \x1b]8;;javascript:alert(1)\x1b\\click\x1b]8;;\x1b\\ and \x1b]8;;https://ok.example\x1b\\ok\x1b]8;;\x1b\\`;
    const clean = sanitizeHyperlinks(row);
    expect(links(clean)).toEqual([['ok', 'https://ok.example/']].map(([t]) => [t, 'https://ok.example']));
    expect(clean).not.toContain('javascript');
    expect(clean).toContain('click');
  });
});

describe('linkify', () => {
  test('URLs without trailing punctuation, balanced brackets kept', () => {
    expect(links(linkify('Docs: https://example.com/guide. And (https://en.wikipedia.org/wiki/Foo_(bar)).', '/p'))).toEqual([
      ['https://example.com/guide', 'https://example.com/guide'],
      ['https://en.wikipedia.org/wiki/Foo_(bar)', 'https://en.wikipedia.org/wiki/Foo_(bar)'],
    ]);
  });

  test('path:line references open the file, resolved from the project', () => {
    const host = hostname().toLowerCase();
    expect(links(linkify('Failed at src/app.ts:42:7 and ./lib/x.js:3, not at version 1.2 or 10:30.', '/work/repo'))).toEqual([
      ['src/app.ts:42:7', `file://${host}/work/repo/src/app.ts`],
      ['./lib/x.js:3', `file://${host}/work/repo/lib/x.js`],
    ]);
    expect(fileUrlFor('/abs/a b.ts:1', '/x')).toBe(`file://${host}/abs/a%20b.ts`);
  });

  test('outside text cannot inject its own link: it is cleaned before linking', () => {
    const evil = displayText('\x1b]8;;javascript:alert(1)\x1b\\click me\x1b]8;;\x1b\\ https://ok.example/');
    const out = linkify(evil, '/p');
    expect(links(out)).toEqual([['https://ok.example/', 'https://ok.example/']]);
    expect(out).not.toContain('javascript');
  });

  test('a link survives wrapping and does not count as width', () => {
    const text = linkify(`read https://example.com/${'x'.repeat(60)} now`, '/p');
    const rows = wrapTextWithAnsi(text, 30);
    expect(rows.every(row => visibleWidth(row) <= 30)).toBe(true);
    // Every row the URL spans is linked to the whole URL.
    const linked = rows.filter(row => row.includes('\x1b]8;;https://'));
    expect(linked.length).toBeGreaterThan(1);
  });

  test('in styled rows only plain runs are linked, never inside a link already there', () => {
    const row = `\x1b[1mBuild\x1b[22m failed in \x1b[33msrc/main.ts:9\x1b[39m — \x1b]8;;https://ci.example/1\x1b\\see src/ci.ts:1\x1b]8;;\x1b\\`;
    const out = linkifyStyled(row, '/p');
    expect(links(out).map(([text]) => text)).toEqual(['src/main.ts:9', 'see src/ci.ts:1']);
  });
});
