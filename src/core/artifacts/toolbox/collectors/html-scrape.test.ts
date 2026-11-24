import { describe, expect, test, vi } from 'vitest';
import { htmlScrapeCollector } from './html-scrape';

const ctx = { principalId: 'p', workspaceId: 'w' };

const SAMPLE_HTML = `
<html><body>
  <article class="post" data-id="1">
    <h2>First</h2>
    <a href="/p/1">read</a>
    <time datetime="2024-01-01">Jan 1</time>
  </article>
  <article class="post" data-id="2">
    <h2>Second &amp; co</h2>
    <a href="/p/2">read</a>
    <time datetime="2024-01-02">Jan 2</time>
  </article>
  <article class="ad">
    <h2>NOT A POST</h2>
  </article>
  <article class="post nested" data-id="3">
    <h2>Third <span class="badge">new</span></h2>
    <a href="/p/3">read</a>
  </article>
</body></html>
`;

// The collector fetches through the SSRF guard (fetchGuarded); stub it there.
vi.mock('@/utils/sanitize', async (orig) => ({
  ...(await orig<typeof import('@/utils/sanitize')>()),
  fetchGuarded: async () => new Response(SAMPLE_HTML, { status: 200, headers: { 'content-type': 'text/html' } }),
}));

describe('art_collect_html_scrape', () => {
  test('extracts repeating rows with text + attribute fields', async () => {
    const out = await htmlScrapeCollector.execute(
      {
        url: 'https://x',
        row: 'article.post',
        fields: {
          title: 'h2',
          href: 'a@href',
          date: 'time@datetime',
        },
      },
      ctx,
    );
    expect(out.count).toBe(3);
    expect(out.items[0]).toEqual({ title: 'First', href: '/p/1', date: '2024-01-01' });
    expect(out.items[1].title).toBe('Second & co');
    expect(out.items[2].title).toBe('Third new');
  });

  test('respects limit', async () => {
    const out = await htmlScrapeCollector.execute(
      {
        url: 'https://x',
        row: 'article.post',
        fields: { title: 'h2' },
        limit: 2,
      },
      ctx,
    );
    expect(out.count).toBe(2);
  });

  test('extracts via attribute filter', async () => {
    const out = await htmlScrapeCollector.execute(
      {
        url: 'https://x',
        row: 'article[data-id=2]',
        fields: { title: 'h2' },
      },
      ctx,
    );
    expect(out.count).toBe(1);
    expect(out.items[0].title).toBe('Second & co');
  });

  test('throws on missing required params', async () => {
    await expect(htmlScrapeCollector.execute(
      { url: '', row: 'a', fields: {} } as never,
      ctx,
    )).rejects.toThrow(/url/);
  });

  test('throws on unsupported selector token', async () => {
    await expect(htmlScrapeCollector.execute(
      { url: 'https://x', row: 'article > .post', fields: { t: 'h2' } },
      ctx,
    )).rejects.toThrow(/unsupported|html_scrape/);
  });
});
