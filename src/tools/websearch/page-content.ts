import { fetchGuarded } from '@/utils/sanitize';

/** Serialized by Playwright; clone so extraction cannot break a still-rendering SPA. */
export function extractPageText(): string {
  const body = document.body?.cloneNode(true) as HTMLElement | undefined;
  if (!body) return '';
  body.querySelectorAll('script, style, nav, header, footer, iframe, .cookie-banner, #cookie-consent')
    .forEach(el => el.remove());
  body.querySelectorAll('br, p, div, section, article, li, tr, h1, h2, h3, h4, pre').forEach(el => el.append('\n'));
  const candidates = [...body.querySelectorAll('main, article, [role="main"], .content, #content'), body];
  for (const target of candidates) {
    const text = (target.textContent || '').trim();
    if (text) return text;
  }
  return '';
}

/** Only use a literal schema reference actually published by Swagger/ReDoc. */
export function apiDocumentUrl(html: string, pageUrl: string): string | undefined {
  if (!/SwaggerUIBundle|<redoc\b/i.test(html)) return;
  const reference = html.match(/\b(?:url\s*:\s*|spec-url\s*=\s*)["']([^"'<>\s]+\.(?:yaml|yml|json)(?:\?[^"'<>\s]*)?)["']/i)?.[1];
  if (!reference) return;
  try {
    const url = new URL(reference, pageUrl);
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch { /* malformed reference */ }
}

export async function fetchApiDocument(url: string): Promise<string> {
  const response = await fetchGuarded(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`API schema HTTP ${response.status}`); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('API schema response has no body');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 2 * 1024 * 1024) throw new Error('API schema exceeds 2 MiB');
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!/(?:"(?:openapi|swagger)"\s*:|^\s*(?:openapi|swagger)\s*:)/m.test(text)) {
    throw new Error('Linked document is not an OpenAPI schema');
  }
  return text;
}
