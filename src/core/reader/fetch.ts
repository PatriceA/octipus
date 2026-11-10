/**
 * Fetch a URL through the SSRF guard and extract a ReaderDoc. The guard
 * (validateExternalUrl + IP-pinned connect) is reused verbatim from the shared
 * sanitize utility — no new outbound surface. Fails loud on blocked URLs and
 * non-HTML responses.
 *
 * The body is read as a stream and cut at `MAX_HTML_BYTES` whatever the
 * response declares: a missing or lying Content-Length (a chunked body) never
 * gets more than that into memory. Also what the plugin host API's `web:read`
 * runs (src/api/routes/plugin-host.ts).
 */
import { fetchGuarded } from '@/utils/sanitize';
import { extractReaderDoc } from './extract';
import type { ReaderDoc } from './types';

const READER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Hard cap on a fetched page so a huge document can't exhaust memory. */
export const MAX_HTML_BYTES = 5_000_000;

/** A fetch that failed; `blocked` when the SSRF guard refused the address (or a redirect's). */
export class ReaderFetchError extends Error {
  constructor(message: string, readonly blocked = false) {
    super(message);
    this.name = 'ReaderFetchError';
  }
}

/** At most `max` bytes of `res`'s body, as text: reading stops (and the stream is cancelled) at the cap. */
export async function readCapped(res: Response, max = MAX_HTML_BYTES): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < max) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = max - total;
      const chunk = value.byteLength > room ? value.subarray(0, room) : value;
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(all);
}

export async function fetchReaderDoc(url: string): Promise<ReaderDoc> {
  let res: Response;
  try {
    res = await fetchGuarded(url, {
      headers: { 'User-Agent': READER_UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(15_000),
      redirect: 'follow',
    });
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    throw new ReaderFetchError(message, /SSRF guard|blocked/i.test(message));
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new ReaderFetchError(`Reader fetch failed: HTTP ${res.status} for ${url}`);
  }
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType && !/html|xml/i.test(contentType)) {
    await res.body?.cancel().catch(() => {});
    throw new ReaderFetchError(`Reader can only render HTML pages (got "${contentType}")`);
  }
  // Reject early on a declared Content-Length; the capped read is the backstop.
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > MAX_HTML_BYTES) {
    await res.body?.cancel().catch(() => {});
    throw new ReaderFetchError(`Reader page too large (${Math.round(declared / 1e6)} MB)`);
  }
  const html = await readCapped(res);
  return extractReaderDoc(html, url);
}
