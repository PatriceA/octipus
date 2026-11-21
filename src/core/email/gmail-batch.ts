/**
 * Gmail's HTTP batch endpoint: many GETs in one multipart request, so a page
 * of the inbox costs two calls (the list, then this) instead of one per
 * message. Both halves are pure: the request body built here, and the
 * multipart answer read back into one result per request.
 *
 * Each inner request is a path under Gmail's own API; nothing here takes a
 * host, so a caller cannot point a batch anywhere else.
 */

/** Gmail's documented cap is 100 calls per batch; a page here is at most 50. */
export const GMAIL_BATCH_MAX = 100;

const SAFE_PATH = /^\/gmail\/v1\/users\/me\/[A-Za-z0-9/_\-.?=&%]+$/;

/** The multipart body for `paths` (each a `/gmail/v1/users/me/...` GET). Part N answers as `response-item-N`. */
export function buildGmailBatch(paths: string[], boundary: string): string {
  if (paths.length === 0 || paths.length > GMAIL_BATCH_MAX) throw new Error('a Gmail batch takes 1 to 100 requests');
  if (!/^[A-Za-z0-9_]{8,70}$/.test(boundary)) throw new Error('invalid batch boundary');
  const parts = paths.map((path, i) => {
    if (!SAFE_PATH.test(path)) throw new Error('invalid batch request path');
    return `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <item-${i}>\r\n\r\nGET ${path} HTTP/1.1\r\n\r\n`;
  });
  return `${parts.join('')}--${boundary}--\r\n`;
}

export interface GmailBatchResult { status: number; body: unknown }

/** The boundary a multipart Content-Type names, or null. */
export function batchBoundary(contentType: string): string | null {
  const m = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
  return m ? (m[1] ?? m[2]) : null;
}

/**
 * Read a batch answer into results indexed like the requests. A part that is
 * missing, has no status line or carries broken JSON is simply absent, so the
 * caller fetches that one message on its own.
 */
export function parseGmailBatch(contentType: string, text: string): Map<number, GmailBatchResult> {
  const out = new Map<number, GmailBatchResult>();
  const boundary = batchBoundary(contentType);
  if (!boundary) return out;
  for (const raw of text.split(`--${boundary}`)) {
    const part = raw.replace(/^\r?\n/, '');
    if (!part.trim() || part.startsWith('--')) continue;
    // Outer part headers, blank line, then the inner HTTP response.
    const split = part.search(/\r?\n\r?\n/);
    if (split < 0) continue;
    const id = part.slice(0, split).match(/^content-id:\s*<?response-item-(\d+)>?\s*$/im);
    if (!id) continue;
    const inner = part.slice(split).replace(/^(\r?\n)+/, '');
    const status = inner.match(/^HTTP\/[\d.]+\s+(\d{3})/);
    if (!status) continue;
    const bodyAt = inner.search(/\r?\n\r?\n/);
    const bodyText = bodyAt < 0 ? '' : inner.slice(bodyAt).trim();
    let body: unknown = null;
    if (bodyText) {
      try { body = JSON.parse(bodyText); } catch { continue; }
    }
    out.set(Number(id[1]), { status: Number(status[1]), body });
  }
  return out;
}
