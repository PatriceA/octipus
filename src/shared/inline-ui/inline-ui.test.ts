import { describe, expect, it } from 'vitest';
import {
  buildContentDocument,
  buildHostDocument,
  cleanSuggestedText,
  clampInlineUiHeight,
  contentCsp,
  findInlineUiFences,
  hostCsp,
  inlineUiFallbackText,
  inlineUiMarker,
  inlineUiMarkerIds,
  inlineUiReportLine,
  inlineUiSpeechText,
  INLINE_UI_LIMITS,
  INLINE_UI_RUNTIME_SOURCES,
  isSafeInlineUiLink,
  jsonForScript,
  lintInlineUi,
  parseCsp,
  parseInlineUiHostMessage,
  parseInlineUiInfo,
  replaceInlineUiFences,
  sanitizeInlineUiTitle,
  splitInlineUiBody,
  splitInlineUiSegments,
  transformOutsideInlineUiFences,
} from './index';

const ID = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';

describe('fence parsing', () => {
  it('finds a block with its attributes and body', () => {
    const text = 'Here:\n\n```octi-ui title="Loan calculator" height=360\n<div>hi</div>\n```\nDone.';
    const [f] = findInlineUiFences(text);
    expect(f).toMatchObject({ title: 'Loan calculator', height: 360, body: '<div>hi</div>', closed: true });
    expect(text.slice(f.start, f.end)).toBe('```octi-ui title="Loan calculator" height=360\n<div>hi</div>\n```\n');
  });

  it('accepts tildes, longer fences and single-quoted or bare attributes', () => {
    const text = "~~~~octi-ui title='A' height=200\n```js\ninner\n```\n~~~~";
    const [f] = findInlineUiFences(text);
    expect(f.title).toBe('A');
    expect(f.body).toBe('```js\ninner\n```');
    expect(f.closed).toBe(true);
  });

  it('skips an octi-ui fence shown inside another fenced block', () => {
    const text = '````markdown\n```octi-ui\n<p>example</p>\n```\n````\n';
    expect(findInlineUiFences(text)).toHaveLength(0);
  });

  it('reports an unclosed fence (cut off or still streaming)', () => {
    const [f] = findInlineUiFences('Intro\n```octi-ui\n<div>partial');
    expect(f.closed).toBe(false);
    expect(f.body).toBe('<div>partial');
  });

  it('needs the closing fence to be at least as long as the opening one', () => {
    const [f] = findInlineUiFences('````octi-ui\n```\n<p>x</p>\n````');
    expect(f.body).toBe('```\n<p>x</p>');
  });

  it('defaults and cleans titles', () => {
    expect(parseInlineUiInfo('').title).toBe('Interactive answer');
    expect(sanitizeInlineUiTitle('a]|b\n[c')).toBe('ab c');
    expect(sanitizeInlineUiTitle(`x${String.fromCharCode(0x202e)}y`)).toBe('xy');
    expect(sanitizeInlineUiTitle('t'.repeat(200))).toHaveLength(80);
    expect(parseInlineUiInfo('height=abc').height).toBeUndefined();
  });

  it('replaces fences and keeps the surrounding lines', () => {
    const text = 'A\n```octi-ui title="T"\n<p>x</p>\n```\nB';
    expect(replaceInlineUiFences(text, (f) => `[${f.title}]`)).toBe('A\n[T]\nB');
  });

  it('transforms only the text outside fences', () => {
    const text = 'aaaa\n```octi-ui\n<p>aaaa</p>\n```\naaaa';
    expect(transformOutsideInlineUiFences(text, (t) => t.replace(/a/g, 'b'))).toBe('bbbb\n```octi-ui\n<p>aaaa</p>\n```\nbbbb');
  });
});

describe('markers', () => {
  it('round-trips through segments, only on a line of their own and outside code', () => {
    const text = `Intro\n${inlineUiMarker(ID, 'Calc')}\nOutro\n\`\`\`\n${inlineUiMarker(ID, 'Not this')}\n\`\`\`\ninline [[octi-ui:${ID}|x]] text`;
    const segments = splitInlineUiSegments(text);
    expect(segments.filter((s) => s.kind === 'block')).toEqual([{ kind: 'block', id: ID, title: 'Calc' }]);
    expect(segments[0]).toEqual({ kind: 'text', text: 'Intro' });
  });

  it('lists marker ids and renders fallbacks', () => {
    const text = `x\n${inlineUiMarker(ID, 'Calc')}\n`;
    expect(inlineUiMarkerIds(text)).toEqual([ID]);
    expect(inlineUiFallbackText(text)).toContain('Interactive answer “Calc”');
    expect(inlineUiFallbackText('a\n```octi-ui title="Draft"\n<p>x</p>\n```\nb')).toContain('“Draft”');
    expect(inlineUiSpeechText(`Hi\n${inlineUiMarker(ID, 'Calc')}`)).toBe('Hi\n');
  });
});

describe('body split and lint', () => {
  it('splits styles, inline scripts and markup', () => {
    const parts = splitInlineUiBody('<style>a{}</style><div>x</div><script>go()</script><script src="https://cdn/x.js"></script>');
    expect(parts).toMatchObject({ css: 'a{}', html: '<div>x</div>', js: 'go()', issues: ['script-src'] });
  });

  it('flags a cut-off script and an unclosed fence as fatal', () => {
    const parts = splitInlineUiBody('<div>x</div><script>let a = 1');
    expect(parts.issues).toContain('unclosed-script');
    expect(lintInlineUi(parts, { closed: true }).some((i) => i.code === 'cut-off' && i.severity === 'fatal')).toBe(true);
    expect(lintInlineUi(splitInlineUiBody('<p>x</p>'), { closed: false })[0].code).toBe('cut-off');
  });

  it('enforces size limits at the boundary', () => {
    const at = splitInlineUiBody(`<p>${'x'.repeat(INLINE_UI_LIMITS.htmlChars - 7)}</p>`);
    expect(at.html.length).toBe(INLINE_UI_LIMITS.htmlChars);
    expect(lintInlineUi(at, { closed: true })).toEqual([]);
    const over = splitInlineUiBody(`<p>${'x'.repeat(INLINE_UI_LIMITS.htmlChars - 6)}</p>`);
    expect(lintInlineUi(over, { closed: true }).map((i) => i.code)).toContain('too-large');
  });

  it('marks parts that will not work as repairable', () => {
    const codes = (body: string) => lintInlineUi(splitInlineUiBody(body), { closed: true }).map((i) => i.code);
    expect(codes('<button onclick="go()">x</button>')).toContain('inline-handler');
    expect(codes('<img src="https://x/y.png">')).toContain('remote-resource');
    expect(codes('<form><input type="password"></form>')).toEqual(expect.arrayContaining(['refused-element', 'credential-input']));
    expect(codes('<a href="javascript:alert(1)">x</a>')).toContain('javascript-url');
    expect(codes('<svg><set attributeName="href" to="https://x"/></svg>')).toContain('smil-href');
    expect(codes('<style>@import url(https://x/y.css);</style><p>x</p>')).toContain('remote-css');
    expect(codes('<p>fine</p>')).toEqual([]);
  });
});

describe('frame documents', () => {
  it('escapes everything that could end a script element', () => {
    const out = jsonForScript({ a: '</script><!--', b: `x${String.fromCharCode(0x2028)}y` });
    expect(out).not.toContain('<');
    expect(out).not.toContain(String.fromCharCode(0x2028));
    expect(JSON.parse(out)).toEqual({ a: '</script><!--', b: `x${String.fromCharCode(0x2028)}y` });
  });

  it('puts the CSP first and never concatenates generated text into markup', () => {
    const input = { channel: 'c1', title: 'T', html: '</script><plaintext>', css: '</style><link rel=dns-prefetch href=//x>', js: '</script>', mode: 'scripted' as const, theme: 'dark' as const };
    const { doc, hostNonce, contentNonce } = buildHostDocument(input);
    expect(doc.startsWith('<!doctype html><html><head><meta http-equiv="Content-Security-Policy"')).toBe(true);
    expect(doc).not.toContain('<plaintext>');
    expect(doc).not.toContain('<link');
    expect(doc.split('</script>')).toHaveLength(2);
    expect(hostNonce).toMatch(/^[0-9a-f]{32}$/);
    expect(contentNonce).not.toBe(hostNonce);
    const content = buildContentDocument(input, contentNonce);
    expect(content).not.toContain('<plaintext>');
    expect(content.split('</script>')).toHaveLength(2);
  });

  it('keeps the runtime sources constant (only the payload varies)', () => {
    const a = buildContentDocument({ channel: 'a', title: '', html: '<p>1</p>', css: '', js: '', mode: 'static', theme: 'dark' }, 'n1');
    expect(a).toContain(INLINE_UI_RUNTIME_SOURCES.content);
    expect(INLINE_UI_RUNTIME_SOURCES.content).not.toContain('${');
    expect(INLINE_UI_RUNTIME_SOURCES.host).not.toContain('${');
  });

  it('never attaches script in static or preview mode', () => {
    const doc = buildContentDocument({ channel: 'a', title: '', html: '<p>1</p>', css: '', js: 'alert(1)', mode: 'static', theme: 'dark' }, 'n');
    expect(doc).not.toContain('alert(1)');
    const preview = buildContentDocument({ channel: 'a', title: '', html: '<p>1</p>', css: '', js: 'alert(1)', mode: 'scripted', preview: true, theme: 'dark' }, 'n');
    expect(preview).not.toContain('alert(1)');
  });

  it('lets the host CSP allow everything the content CSP allows (inherited policy container)', () => {
    const host = parseCsp(hostCsp('h', 'c'));
    const content = parseCsp(contentCsp('c'));
    for (const [directive, sources] of content) {
      const hostSources = host.get(directive) ?? host.get('default-src') ?? [];
      for (const source of sources) {
        if (source === "'none'") continue;
        expect(hostSources, `${directive} ${source}`).toContain(source);
      }
    }
    expect(host.get('frame-src')).toEqual(["'none'"]);
    expect(host.get('connect-src')).toEqual(["'none'"]);
  });
});

describe('bridge', () => {
  const msg = (extra: Record<string, unknown>) => ({ v: 1, src: 'octi-ui-host', ch: 'c', ...extra });

  it('accepts only well-formed messages for its own mount', () => {
    expect(parseInlineUiHostMessage(msg({ type: 'ready' }), 'c')).toEqual({ type: 'ready' });
    expect(parseInlineUiHostMessage(msg({ type: 'ready' }), 'other')).toBeNull();
    expect(parseInlineUiHostMessage({ ...msg({ type: 'ready' }), src: 'x' }, 'c')).toBeNull();
    expect(parseInlineUiHostMessage(msg({ type: 'height', height: Number.NaN }), 'c')).toBeNull();
    expect(parseInlineUiHostMessage(msg({ type: 'link', url: 'http://x.test' }), 'c')).toBeNull();
    expect(parseInlineUiHostMessage(msg({ type: 'link', url: 'https://u:p@x.test' }), 'c')).toBeNull();
    expect(parseInlineUiHostMessage(msg({ type: 'link', url: 'https://x.test/a' }), 'c')).toEqual({ type: 'link', url: 'https://x.test/a' });
    expect(parseInlineUiHostMessage(msg({ type: 'error', kind: 'script', errorClass: 'Evil', line: 3 }), 'c'))
      .toEqual({ type: 'error', kind: 'script', errorClass: 'other', line: 3, items: [] });
    expect(parseInlineUiHostMessage(msg({ type: 'stopped', reason: 'navigation', host: 'x.test' }), 'c')).toMatchObject({ reason: 'navigation' });
    expect(parseInlineUiHostMessage(msg({ type: 'nope' }), 'c')).toBeNull();
  });

  it('cleans suggested text', () => {
    expect(cleanSuggestedText(`  hi${String.fromCharCode(0x202e)} there${String.fromCharCode(0x200b)}\nnext  `)).toBe('hi there\nnext');
    expect(cleanSuggestedText('x'.repeat(5000))).toHaveLength(INLINE_UI_LIMITS.promptChars);
    expect(isSafeInlineUiLink(`https://x.test/${'a'.repeat(3000)}`)).toBe(false);
  });

  it('writes model-facing report lines from enums only', () => {
    expect(inlineUiReportLine({ id: ID, outcome: 'script-error', errorClass: 'TypeError', line: 12 }))
      .toBe(`(system note: interactive answer ${ID} reported script-error TypeError line 12)`);
  });

  it('clamps heights', () => {
    expect(clampInlineUiHeight(Number.NaN)).toBe(INLINE_UI_LIMITS.defaultHeight);
    expect(clampInlineUiHeight(5)).toBe(INLINE_UI_LIMITS.minHeight);
    expect(clampInlineUiHeight(5000)).toBe(INLINE_UI_LIMITS.maxHeight);
    expect(clampInlineUiHeight(5000, 1000)).toBe(800);
  });
});

describe('fence edge cases', () => {
  it('the language is matched in any letter case, everywhere', async () => {
    const { hasInlineUiFence, inlineUiFallbackText, withoutInlineUiFences, findInlineUiFences } = await import('./fence');
    const text = 'Intro\n```Octi-UI title="Calc"\n<p>SOURCE</p>\n```\nEnd';
    expect(findInlineUiFences(text)).toHaveLength(1);
    expect(hasInlineUiFence(text)).toBe(true);
    expect(inlineUiFallbackText(text)).not.toContain('SOURCE');
    expect(withoutInlineUiFences(text)).not.toContain('SOURCE');
  });

  it('a line of inline code with backticks is not a fence, so a later marker still renders', async () => {
    const { splitInlineUiSegments } = await import('./fence');
    const segments = splitInlineUiSegments('Run ```npm i``` first.\n[[octi-ui:11111111-1111-4111-8111-111111111111|Calc]]\nDone.');
    expect(segments.filter((s) => s.kind === 'block')).toHaveLength(1);
  });
});

describe('splitInlineUiBody reads a body in document order', () => {
  it('accepts any end tag a browser accepts, in any letter case', async () => {
    const { splitInlineUiBody } = await import('./fence');
    const parts = splitInlineUiBody('<STYLE>a{}</style >\n<p>x</p><script>go()</script\t\n bar><p>y</p>');
    expect(parts).toEqual({ css: 'a{}', html: '<p>x</p><p>y</p>', js: 'go()', issues: [] });
  });

  it('keeps a <style> inside a script string as script', async () => {
    const { splitInlineUiBody } = await import('./fence');
    const parts = splitInlineUiBody("<p>x</p><script>el.innerHTML = '<style>b{}</style>';</script>");
    expect(parts.css).toBe('');
    expect(parts.js).toBe("el.innerHTML = '<style>b{}</style>';");
  });

  it('never leaves a style or script tag in the markup, even one joined from the text around a removed element', async () => {
    const { splitInlineUiBody } = await import('./fence');
    for (const body of [
      '<p>a</p><scr<style></style>ipt>alert(1)</scr<style></style>ipt><p>b</p>',
      '<p>a</p><sc<sc<script></script>ript></script>ript>x',
      '<sty<script></script>le>body{}</style>',
    ]) {
      expect(splitInlineUiBody(body).html.toLowerCase(), body).not.toMatch(/<(script|style)/);
    }
  });
});
