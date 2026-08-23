import { describe, expect, test } from 'vitest';
import { extractReaderDoc } from './extract';

const ARTICLE = `<!doctype html><html><head>
  <title>Site — My Article</title>
  <meta property="og:title" content="My Article">
  <meta property="og:site_name" content="Example News">
  <meta name="author" content="Jane Doe">
  <meta property="article:published_time" content="2026-05-01T10:00:00Z">
  <meta property="og:image" content="https://cdn.example.com/lead.jpg">
</head><body>
  <nav class="site-nav"><a href="/">Home</a><a href="/about">About</a></nav>
  <header>banner junk</header>
  <article>
    <h1>My Article</h1>
    <p>This is the <strong>first</strong> paragraph with real content worth reading.</p>
    <p>A second paragraph that adds more words so the article scores well above chrome.</p>
    <aside class="related">Related links you should ignore</aside>
    <script>window.tracker = function(){ steal() }</script>
    <p>Final paragraph. <a href="https://example.com/more">Read more</a> and <a href="javascript:alert(1)">bad</a>.</p>
  </article>
  <footer>copyright</footer>
  <div class="advert">BUY NOW</div>
</body></html>`;

describe('extractReaderDoc', () => {
  const doc = extractReaderDoc(ARTICLE, 'https://example.com/post');

  test('extracts metadata', () => {
    expect(doc.title).toBe('My Article');
    expect(doc.byline).toBe('Jane Doe');
    expect(doc.siteName).toBe('Example News');
    expect(doc.publishedAt).toBe('2026-05-01T10:00:00Z');
    expect(doc.leadImage).toBe('https://cdn.example.com/lead.jpg');
    expect(doc.url).toBe('https://example.com/post');
  });

  test('keeps article prose, drops nav/footer/aside/ads', () => {
    expect(doc.textContent).toContain('first paragraph with real content');
    expect(doc.textContent).toContain('second paragraph');
    expect(doc.textContent).not.toContain('Home');
    expect(doc.textContent).not.toContain('copyright');
    expect(doc.textContent).not.toContain('BUY NOW');
    expect(doc.textContent).not.toContain('Related links');
  });

  test('sanitizes — no script, styles, or event handlers survive', () => {
    expect(doc.contentHtml).not.toContain('<script');
    expect(doc.contentHtml).not.toContain('steal()');
    expect(doc.contentHtml).not.toMatch(/onclick|onerror|onload/i);
    // Allowed markup is preserved.
    expect(doc.contentHtml).toContain('<strong>first</strong>');
    expect(doc.contentHtml).toContain('<h1>My Article</h1>');
  });

  test('drops javascript: links but keeps safe ones', () => {
    expect(doc.contentHtml).toContain('href="https://example.com/more"');
    expect(doc.contentHtml).not.toContain('javascript:');
    // The bad link text remains, just without the dangerous href.
    expect(doc.contentHtml).toContain('bad');
  });

  test('drops dangerous + private-network URLs, keeps http(s)/relative', () => {
    const html = `<article><p>x</p>
      <a href="javascript:alert(1)">a</a>
      <a href="data:text/html,nope">b</a>
      <a href="http://169.254.169.254/latest/meta-data/">d</a>
      <a href="http://10.0.0.1/admin">e</a>
      <a href="//127.0.0.1/x">f</a>
      <a href="https://safe.example/ok">g</a>
      <a href="/relative/path">h</a>
      <img src="javascript:alert(2)" alt="i">
      <img src="https://cdn.example/p.png" alt="j"></article>`;
    const d = extractReaderDoc(html, 'https://t.test');
    expect(d.contentHtml).not.toMatch(/javascript:/i);
    expect(d.contentHtml).not.toContain('data:text/html');
    expect(d.contentHtml).not.toContain('169.254.169.254');
    expect(d.contentHtml).not.toContain('10.0.0.1');
    expect(d.contentHtml).not.toContain('127.0.0.1');
    expect(d.contentHtml).toContain('href="https://safe.example/ok"');
    expect(d.contentHtml).toContain('href="/relative/path"');
    expect(d.contentHtml).toContain('src="https://cdn.example/p.png"');
  });

  test('strips media/embed subtrees entirely', () => {
    const html = `<article><p>keep this</p><object data="x.swf">objdata</object><video><source src="x.mp4"></video><embed src="y"></article>`;
    const d = extractReaderDoc(html, 'https://t.test');
    expect(d.contentHtml).toContain('keep this');
    expect(d.contentHtml).not.toMatch(/<object|<video|<source|<embed/i);
    expect(d.textContent).not.toContain('objdata');
  });

  test('computes word count and read time', () => {
    expect(doc.wordCount).toBeGreaterThan(20);
    expect(doc.estReadMinutes).toBeGreaterThanOrEqual(1);
  });
});

describe('extractReaderDoc resilience', () => {
  test('malformed HTML does not throw and yields a usable doc', () => {
    const doc = extractReaderDoc('<html><body><p>orphan <b>bold</p></body>', 'https://x.test');
    expect(doc.textContent).toContain('orphan');
    expect(doc.title).toBe('https://x.test'); // no title → falls back to url
  });

  test('empty input yields an empty-but-valid doc', () => {
    const doc = extractReaderDoc('', 'https://empty.test');
    expect(doc.wordCount).toBe(0);
    expect(doc.estReadMinutes).toBe(1);
    expect(doc.url).toBe('https://empty.test');
  });
});
