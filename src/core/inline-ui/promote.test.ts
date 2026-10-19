import { describe, expect, test } from 'vitest';
import { INLINE_UI_REFUSED_ELEMENTS } from '@/shared/inline-ui';
import { cssForStyleElement, PROMOTED_OCTI_SHIM, promotedPage, sanitizeInlineUiMarkup, usesOctiBridge } from './promote';

const clean = (html: string) => sanitizeInlineUiMarkup(html);

describe('sanitizeInlineUiMarkup (the frame rules, on the server)', () => {
  test('every element the frame refuses is removed with its content', () => {
    // Void elements have no content (a browser ignores a `<frame>` tag in a
    // body altogether): what follows them is a sibling, in a browser too.
    const VOID = ['meta', 'link', 'base', 'embed', 'frame'];
    for (const name of INLINE_UI_REFUSED_ELEMENTS) {
      const out = clean(`<p>a</p><${name}><b>inside</b></${name}><p>b</p>`);
      expect(out.html, name).toBe(VOID.includes(name) ? '<p>a</p><b>inside</b><p>b</p>' : '<p>a</p><p>b</p>');
      expect(out.removed, name).toContain('element');
    }
  });

  test('elements a browser reads as raw text are refused, so their content cannot turn into markup', () => {
    // The parser ends a raw-text element where a browser does — at its end tag,
    // even inside what looks like an attribute — so the `<img>` after it is a
    // real element on both sides, and it is sanitized like any other.
    for (const name of ['xmp', 'noembed', 'noframes']) {
      const out = clean(`<${name}><p title="</${name}><img src=x onerror=alert(1)>"></p></${name}>`);
      expect(out.html, name).toBe('<img>"&gt;<p></p>');
    }
    // `<plaintext>` has no end tag: everything after it is its text.
    expect(clean('<plaintext><p title="</plaintext><img src=x onerror=alert(1)>"></p>').html).toBe('');
    const noscript = clean('<noscript><p title="</noscript><img src=x onerror=alert(1)>"></p></noscript>');
    expect(noscript.html).not.toMatch(/<img|onerror/);
  });

  test('a <style> moves into the CSS, also inside SVG and MathML, where browsers would re-parse it as markup', () => {
    const out = clean('<svg><style><img src=x onerror=alert(1)></style><circle r="2"></circle></svg><p>t</p><style>p{color:red}</style>');
    expect(out.html).toBe('<svg><circle r="2"></circle></svg><p>t</p>');
    expect(out.css).toContain('p{color:red}');
    const math = clean('<math><mtext><table><mglyph><style><img src=x onerror=alert(1)></style></mglyph></table></mtext></math>');
    expect(math.html).not.toMatch(/<img|onerror|<style/);
  });

  test('handlers, dropped attributes and remote resources go; data: images stay', () => {
    const out = clean('<button onclick="go()" formaction="https://x" autofocus>b</button><img src="https://t.example/p.gif" alt="t"><img src="data:image/png;base64,AA" alt="d"><video src="https://v"></video>');
    expect(out.html).not.toMatch(/onclick|formaction|autofocus|t\.example|https:\/\/v/);
    expect(out.html).toContain('src="data:image/png;base64,AA"');
    expect(out.html).toContain('disablepictureinpicture=""');
    expect(out.removed).toEqual(expect.arrayContaining(['inline-handler', 'attribute', 'remote-resource']));
  });

  test('links become what the frame makes them: https and in-page anchors only, never a live href', () => {
    const out = clean('<a href="https://docs.example/a" role="button">docs</a><a href="#s">jump</a><a href="javascript:alert(1)">x</a><a href="http://plain">p</a>');
    expect(out.html).toContain('<a data-octi-href="https://docs.example/a" role="link" tabindex="0">docs</a>');
    expect(out.html).toContain('<a data-octi-anchor="s" role="link" tabindex="0">jump</a>');
    expect(out.html).not.toMatch(/\shref=|javascript:|http:\/\/plain/);
    expect(out.removed).toContain('url');
  });

  test('SVG keeps fragment references, not links', () => {
    const out = clean('<svg><defs><path id="p" d="M0 0"></path></defs><use href="#p"></use><a href="https://x"><text>t</text></a></svg>');
    expect(out.html).toContain('<use href="#p"></use>');
    expect(out.html).not.toContain('https://x');
  });

  test('password and file inputs are replaced by a notice', () => {
    const out = clean('<input type="password"><input autocomplete="current-password"><input type="file"><input type="text" value="ok">');
    expect(out.html.match(/field removed/g)).toHaveLength(3);
    expect(out.html).toContain('<input type="text" value="ok">');
    expect(out.removed).toContain('credential-input');
  });

  test('text and attributes are written escaped; braces cannot become template placeholders', () => {
    const out = clean('<p title="a &quot;b&quot; {{title}}">1 &lt; 2 {{data.x}}</p><!-- note --><textarea><b>raw</b></textarea>');
    expect(out.html).toBe('<p title="a &quot;b&quot; &#123;&#123;title}}">1 &lt; 2 &#123;&#123;data.x}}</p><textarea>&lt;b&gt;raw&lt;/b&gt;</textarea>');
  });

  test('text-security is taken out of style attributes', () => {
    const out = clean('<input style="color:red;-webkit-text-security:disc">');
    expect(out.html).toBe('<input style="color:red;">');
    expect(out.removed).toContain('text-security');
  });

  test('render-cost limits match the frame', () => {
    expect(clean('<svg>' + '<use href="#a"></use>'.repeat(201) + '</svg>').removed).toContain('cost');
    expect(clean('<svg>' + '<filter></filter>'.repeat(21) + '</svg>').removed).toContain('cost');
  });
});

describe('promotedPage', () => {
  test('the script runs after the octi shim; the CSS cannot close its <style>', () => {
    const page = promotedPage({ html: '<p id="r">0</p><style>p{}</style>', css: 'b::after{content:"</style><script>x</script>"}', js: "document.getElementById('r').textContent = '1'; octi.prompt('x');", scripts: true });
    expect(page.script.startsWith(PROMOTED_OCTI_SHIM)).toBe(true);
    expect(page.script).toContain("textContent = '1'");
    expect(page.css).not.toContain('</style');
    expect(page.css).toContain('p{}');
    expect(page.template).toBe('<p id="r">0</p>');
  });

  test('a static answer without links has no script; one with links gets the shim for them', () => {
    expect(promotedPage({ html: '<p>x</p>', css: '', js: 'ignored()', scripts: false }).script).toBe('');
    expect(promotedPage({ html: '<a href="https://x.example">x</a>', css: '', js: '', scripts: false }).script).toContain('data-octi-href');
  });

  test('cssForStyleElement escapes every "<"', () => {
    expect(cssForStyleElement('a{}</style>')).toBe('a{}\\3c /style>');
  });

  test('usesOctiBridge', () => {
    expect(usesOctiBridge("octi.prompt('a')")).toBe(true);
    expect(usesOctiBridge("window.octi['openLink']('a')")).toBe(true);
    expect(usesOctiBridge('const doctor = 1;')).toBe(false);
  });
});
