/**
 * Expanded values are data, never markup: whatever a value holds, the
 * rendered page has exactly the template's elements and attributes, and the
 * value's text comes back unchanged once the browser decodes it. Parsed with
 * htmlparser2, as a browser would split elements and attributes.
 */
import type { ChildNode, Element, Text } from 'domhandler';
import { parseDocument } from 'htmlparser2';
import { describe, expect, test } from 'vitest';
import { escapeTemplateValue, renderTemplate } from './render';

const isTag = (n: ChildNode): n is Element => n.type === 'tag' || n.type === 'script' || n.type === 'style';
const isText = (n: ChildNode): n is Text => n.type === 'text';

interface Shape { tag: string; attrs: string[]; children: Shape[] }

function shape(nodes: ChildNode[]): Shape[] {
  return nodes.filter(isTag).map((el: Element) => ({ tag: el.name, attrs: Object.keys(el.attribs).sort(), children: shape(el.children) }));
}
function textOf(nodes: ChildNode[]): string {
  return nodes.map((n) => (isText(n) ? n.data : isTag(n) ? textOf(n.children) : '')).join('');
}
const parse = (html: string) => parseDocument(html, { decodeEntities: true }).children;

describe('values the sanitizer used to corrupt or let through', () => {
  const render = (template: string, data: Record<string, unknown>) => renderTemplate(template, { data });

  test('text that looks like an attribute stays text, and the closing tag stays', () => {
    const out = render('<p>{{data.d}}</p>', { d: 'Status online=yes' });
    expect(out).toBe(`<p>${escapeTemplateValue('Status online=yes')}</p>`);
    expect(textOf(parse(out))).toBe('Status online=yes');
  });

  test('markup in a value is shown as text, whole', () => {
    const code = '<button onclick=go()>Go</button> done';
    const out = render('<pre>{{data.code}}</pre>', { code });
    expect(shape(parse(out))).toEqual([{ tag: 'pre', attrs: [], children: [] }]);
    expect(textOf(parse(out))).toBe(code);
  });

  test('a URL containing "on…=" survives in a quoted attribute', () => {
    const out = render('<a href="{{data.u}}">u</a>', { u: 'https://ex.com/onboarding=1' });
    const [a] = parse(out) as Element[];
    expect(a.attribs).toEqual({ href: 'https://ex.com/onboarding=1' });
    expect(textOf(a.children)).toBe('u');
  });

  test('data alone cannot add an attribute', () => {
    const out = renderTemplate('{{#each data.items}}<a href="{{this.link}}" title="{{this.title}}">x</a>{{/each}}', {
      data: { items: [{ link: 'https://x.test/onx=y', title: 'onfocus=alert(1) autofocus tabindex=1' }] },
    });
    const [a] = parse(out) as Element[];
    expect(Object.keys(a.attribs).sort()).toEqual(['href', 'title']);
    expect(a.attribs.title).toBe('onfocus=alert(1) autofocus tabindex=1');
  });

  test('a value is not expanded as a second template', () => {
    const out = renderTemplate('<p>{{data.a}}</p>', { data: { a: '{{data.b}}', b: 'secret' } });
    expect(textOf(parse(out))).toBe('{{data.b}}');
  });

  test('a handler right after a closing quote is stripped', () => {
    for (const t of ['<a href=""onclick=alert(1)>x</a>', '<img src="x"onerror="alert(1)">', "<img src='x'onerror='alert(1)'>"]) {
      const out = render(t, {});
      expect(out, t).not.toMatch(/onclick|onerror/i);
      const [el] = parse(out) as Element[];
      expect(Object.keys(el.attribs).some((k) => k.startsWith('on')), t).toBe(false);
    }
  });
});

describe('property: any value renders as exactly its own text', () => {
  const ALPHABET = ['=', '/', '"', "'", '<', '>', ' ', '\t', '\n', 'on', 'onclick=', 'onerror=', 'a', 'Z', '1', '&', '`', '{{', '}}', 'script', '</p', '&amp;', '{', '}', 'é'];
  // Deterministic, so a failure reproduces.
  let seed = 0x2f6b1d;
  const next = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed);
  const randomValue = () => Array.from({ length: next() % 12 }, () => ALPHABET[next() % ALPHABET.length]).join('');

  const TEMPLATES = [
    { html: '<p class="v">{{data.v}}</p>', expect: [{ tag: 'p', attrs: ['class'], children: [] }], attr: null },
    { html: '<a href="{{data.v}}" title="t">x</a>', expect: [{ tag: 'a', attrs: ['href', 'title'], children: [] }], attr: 'href' },
    { html: "<img alt='{{data.v}}' src=x>", expect: [{ tag: 'img', attrs: ['alt', 'src'], children: [] }], attr: 'alt' },
    { html: '<div><span>{{data.v}}</span><b>k</b></div>', expect: [{ tag: 'div', attrs: [], children: [{ tag: 'span', attrs: [], children: [] }, { tag: 'b', attrs: [], children: [] }] }], attr: null },
  ];

  test('500 random values in text and quoted attributes', () => {
    for (let i = 0; i < 500; i++) {
      const v = randomValue();
      for (const t of TEMPLATES) {
        const out = renderTemplate(t.html, { data: { v } });
        const nodes = parse(out);
        expect(shape(nodes), `${t.html} with ${JSON.stringify(v)}`).toEqual(t.expect);
        if (t.attr) {
          const el = nodes.find(isTag) as Element;
          expect(el.attribs[t.attr], JSON.stringify(v)).toBe(v);
        } else {
          const el = nodes.find(isTag) as Element;
          const holder = t.html.startsWith('<div') ? (el.children.find(isTag) as Element) : el;
          expect(textOf(holder.children), JSON.stringify(v)).toBe(v);
        }
        // The value's escaped form appears verbatim: nothing was cut from it.
        expect(out).toContain(escapeTemplateValue(v));
      }
    }
  });
});
