/**
 * Source gathering for Deep Research — web search (SearXNG) + SSRF-guarded page
 * fetch with lightweight text extraction. Network-bound; the research service
 * takes these as injectable deps so it stays unit-testable. Failures degrade to
 * empty results rather than throwing (the service decides if zero sources is fatal).
 */
import { getElementsByTagName, removeElement, textContent } from 'domutils';
import { parseDocument } from 'htmlparser2';
import { fetchGuarded } from '@/utils/sanitize';
import { coreLogger } from '@/utils/logger';

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Web search via a configured SearXNG instance. Returns [] if unavailable. */
export async function searxngSearch(query: string, max: number): Promise<SearchHit[]> {
  const base = process.env.SEARXNG_URL || 'http://localhost:8888';
  try {
    const params = new URLSearchParams({ q: query, format: 'json', categories: 'general' });
    const res = await fetch(`${base}/search?${params}`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
    return (data.results ?? [])
      .filter((r) => r.url)
      .slice(0, max)
      .map((r) => ({ title: r.title ?? r.url ?? '', url: r.url ?? '', snippet: r.content ?? '' }));
  } catch (err) {
    coreLogger.debug({ err: (err as Error).message }, 'research: searxng search failed');
    return [];
  }
}

/** Fetch a page through the SSRF guard and return cleaned main-content text. */
export async function fetchSourceText(url: string): Promise<string> {
  try {
    const res = await fetchGuarded(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(12_000),
      redirect: 'follow',
    });
    if (!res.ok) return '';
    const ctype = res.headers.get('content-type') ?? '';
    if (ctype && !/html|xml|text/i.test(ctype)) return '';
    const doc = parseDocument(await res.text());
    for (const tag of ['script', 'style', 'nav', 'header', 'footer', 'aside', 'noscript']) {
      for (const el of getElementsByTagName(tag, doc, true)) removeElement(el);
    }
    const main =
      getElementsByTagName('article', doc, true)[0] ||
      getElementsByTagName('main', doc, true)[0] ||
      getElementsByTagName('body', doc, true)[0];
    return main ? textContent(main).replace(/\s+/g, ' ').trim().slice(0, 6000) : '';
  } catch (err) {
    coreLogger.debug({ url, err: (err as Error).message }, 'research: source fetch failed');
    return '';
  }
}
