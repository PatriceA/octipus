/**
 * Fetch a URL through the SSRF guard and extract a ReaderDoc. The guard
 * (validateExternalUrl + IP-pinned connect) is reused verbatim from the shared
 * sanitize utility — no new outbound surface. Fails loud on blocked URLs and
 * non-HTML responses.
 */
import { fetchGuarded } from '@/utils/sanitize';
import { extractReaderDoc } from './extract';
import type { ReaderDoc } from './types';

const READER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export async function fetchReaderDoc(url: string): Promise<ReaderDoc> {
  const res = await fetchGuarded(url, {
    headers: { 'User-Agent': READER_UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    signal: AbortSignal.timeout(15_000),
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(`Reader fetch failed: HTTP ${res.status} for ${url}`);
  }
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType && !/html|xml/i.test(contentType)) {
    throw new Error(`Reader can only render HTML pages (got "${contentType}")`);
  }
  const html = await res.text();
  return extractReaderDoc(html, url);
}
