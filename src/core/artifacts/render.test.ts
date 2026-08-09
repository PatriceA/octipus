import { describe, expect, test } from 'bun:test';
import { escapeHtml, extractInteractiveScript, renderRssFeed, renderTemplate, sanitizeTemplate } from './render';

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

describe('sanitizeTemplate — unquoted handlers', () => {
  test('strips an unquoted on*= attribute (valid HTML5, was passing through)', () => {
    expect(sanitizeTemplate('<button onclick=alert(1)>x</button>')).toBe('<button>x</button>');
  });
});

describe('extractInteractiveScript', () => {
  test('lifts <script> and rewrites on*= handlers into bindings', () => {
    const r = extractInteractiveScript(
      `<button onclick="newPrompt()">Go</button><script>function newPrompt(){ x = 1; }</script>`,
    );
    expect(r.template).not.toContain('<script');
    expect(r.template).not.toContain('onclick');
    expect(r.template).toContain('data-octi-h="h0"');
    expect(r.source).toContain('function newPrompt()');
    expect(r.source).toContain('__octiBind("h0", "click"');
    // Handler code and user code share one scope — that is why they are
    // concatenated into a single source rather than relying on globals.
    expect(r.source.indexOf('function newPrompt()')).toBeLessThan(r.source.indexOf('__octiBind("h0"'));
  });

  test('handles a truncated <script> (no closing tag)', () => {
    const r = extractInteractiveScript('<div>x</div><script>let a = 1;');
    expect(r.template).toBe('<div>x</div>');
    expect(r.source).toContain('let a = 1;');
  });

  test('drops third-party <script src> with a warning', () => {
    const r = extractInteractiveScript('<script src="https://evil.example/x.js"></script><p>hi</p>');
    expect(r.source).toBe('');
    expect(r.warnings[0]).toMatch(/only run its own inline JS/);
  });

  test('decodes HTML entities in handler code', () => {
    const r = extractInteractiveScript(`<b onclick="f(&quot;a&quot;)">x</b>`);
    expect(r.source).toContain('f("a")');
  });

  test('a non-JS <script type> is dropped, not fed to the bundler', () => {
    // One JSON data island used to be concatenated into the entry file and fail
    // the build for the WHOLE page, killing every real handler on it.
    const r = extractInteractiveScript(
      `<script type="application/json" id="cfg">{"theme":"dark"}</script><button onclick="go()">x</button><script>function go(){}</script>`,
    );
    expect(r.source).not.toContain('"theme"');
    expect(r.source).toContain('function go()');
    expect(r.warnings[0]).toMatch(/application\/json/);
  });

  test('type="module" and explicit JS mime types still bundle', () => {
    expect(extractInteractiveScript('<script type="module">let a=1;</script>').source).toContain('let a=1;');
    expect(extractInteractiveScript('<script type="text/javascript">let b=2;</script>').source).toContain('let b=2;');
  });

  test('unquoted handler attributes are extracted, not left in the markup', () => {
    const r = extractInteractiveScript('<button onclick=go()>x</button>');
    expect(r.template).not.toContain('onclick');
    expect(r.source).toContain('go()');
  });

  // Why `writeVersion` must carry the previous bundle forward: an agent that
  // does get_live_artifact -> edit -> update_live_artifact feeds the STORED
  // template back in, and there is no script left in it to rebuild from.
  test('re-extracting an already-extracted template yields no source but keeps its markers', () => {
    const once = extractInteractiveScript('<button onclick="go()">x</button><script>function go(){}</script>');
    const twice = extractInteractiveScript(once.template);
    expect(twice.source).toBe('');
    expect(twice.template).toContain('data-octi-h="h0"');
  });

  test('a static page is returned untouched with no source', () => {
    const html = '<p>nothing to run</p>';
    expect(extractInteractiveScript(html)).toEqual({ template: html, source: '', warnings: [] });
  });
});
