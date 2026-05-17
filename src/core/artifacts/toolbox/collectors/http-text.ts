/**
 * art_collect_http_text — fetch a URL as text (HTML, XML, CSV, plain). Pairs
 * with downstream transforms (regex_extract, html_scrape parser) since the
 * raw payload is rarely useful by itself.
 */

import { resolveVaultHeaders } from '../../refresh';
import type { ToolboxTool } from '../types';

interface Params {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
}

interface Result {
  body: string;
  status: number;
  contentType: string | null;
}

export const httpTextCollector: ToolboxTool<Params, Result> = {
  id: 'art_collect_http_text',
  family: 'collect',
  description:
    'Fetch a URL as raw text (HTML / XML / CSV / plain) — pair with a parsing transform downstream.',
  keywords: ['http', 'fetch', 'text', 'html', 'xml', 'csv', 'raw'],
  defaultPermission: 'ASK',
  params: {
    url: { type: 'string', required: true, description: 'Absolute HTTP(S) URL.' },
    method: { type: 'string', enum: ['GET', 'POST'], default: 'GET', description: 'HTTP method.' },
    headers: {
      type: 'object',
      description: 'Request headers. Values may reference ${vault.<key>}.',
    },
    body: { type: 'string', description: 'Raw request body, sent as-is when method=POST.' },
  },
  returns: '`{ body, status, contentType }` — body is the raw response text.',
  examples: [
    {
      summary: 'Fetch HN front page for downstream scraping',
      params: { url: 'https://news.ycombinator.com' },
    },
  ],
  tips: ['For JSON endpoints prefer `art_collect_http_json` so callers get a parsed object.'],

  async execute(params) {
    if (!params.url) throw new Error('art_collect_http_text: missing `url`');
    const headers = await resolveVaultHeaders(params.headers ?? {});
    const res = await fetch(params.url, {
      method: params.method ?? 'GET',
      headers,
      body: params.body,
    });
    if (!res.ok) throw new Error(`http ${res.status}: ${res.statusText}`);
    return {
      body: await res.text(),
      status: res.status,
      contentType: res.headers.get('content-type'),
    };
  },
};

export default httpTextCollector;
