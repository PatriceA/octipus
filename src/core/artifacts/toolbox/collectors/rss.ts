/**
 * art_collect_rss — fetch and parse an RSS/Atom feed into a stable
 * `{ items: [{title, link, pubDate, summary}] }` shape. Wraps the same
 * regex-based parser used by the legacy `kind: "rss"` source so behaviour
 * is identical, just discoverable by name now.
 */

import { parseRss, type RssItem } from '../../refresh';
import type { ToolboxTool } from '../types';

interface Params {
  url: string;
}

interface Result {
  items: RssItem[];
}

export const rssCollector: ToolboxTool<Params, Result> = {
  id: 'art_collect_rss',
  family: 'collect',
  description: 'Fetch an RSS or Atom feed and normalize it to `{ items[] }` with title/link/pubDate/summary.',
  keywords: ['rss', 'atom', 'feed', 'news', 'syndication'],
  defaultPermission: 'ASK',
  params: {
    url: { type: 'string', required: true, description: 'Feed URL (RSS 2.0 or Atom).' },
  },
  returns: '`{ items: [{ title, link, pubDate, summary }] }` — `pubDate` may be null.',
  examples: [
    {
      summary: 'Hacker News front page feed',
      params: { url: 'https://hnrss.org/frontpage' },
    },
  ],
  tips: [
    'Bind a list/timeline widget to `<source-name>.items` — items are pre-sorted as the feed returned them.',
  ],

  async execute(params) {
    if (!params.url) throw new Error('art_collect_rss: missing `url`');
    const res = await fetch(params.url, {
      headers: { accept: 'application/rss+xml, application/xml' },
    });
    if (!res.ok) throw new Error(`rss ${res.status}: ${res.statusText}`);
    const xml = await res.text();
    return { items: parseRss(xml) };
  },
};

export default rssCollector;
