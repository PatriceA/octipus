/**
 * CSP policy builder for hosted artifact pages. Subdomain isolation does most
 * of the work; CSP is the second layer. SDK script is pinned by SHA256;
 * custom JS bundles add their per-version SHA256 to `script-src`.
 */

import { coreLogger } from '@/utils/logger';

export interface CspInput {
  /** SHA256 hashes (raw hex) of trusted inline/external scripts. */
  scriptSha256s: string[];
  /** Origin of the gateway WS (e.g. `wss://gateway.example.com`). */
  gatewayWss?: string;
  /** Extra `frame-ancestors` entries beyond `'self'`. */
  frameAncestors?: string[];
  /**
   * `none`: the page reaches nothing — no fetch or socket (not even the
   * gateway), images only from `data:` and `blob:`.
   */
  network?: 'default' | 'none';
}

/**
 * An origin an artifact may be framed by: `https://host`, `http://host`,
 * optionally with a port, or `https://*.host`. Nothing else — the value is
 * spliced into a CSP header, where a `;` or a space would start a directive of
 * the author's choosing (a second `sandbox … allow-same-origin` ahead of the
 * server's own, say).
 */
const EMBED_ORIGIN_RE = /^https?:\/\/(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?$/;

export function isEmbedOrigin(value: string): boolean {
  return EMBED_ORIGIN_RE.test(value);
}

/**
 * The stored allow-list as CSP sources: entries that are not an origin are
 * dropped (and logged) — rows written before the API validated them.
 */
export function embedOriginSources(origins: readonly string[] | null | undefined): string[] {
  const valid: string[] = [];
  for (const origin of origins ?? []) {
    if (isEmbedOrigin(origin)) valid.push(origin);
    else coreLogger.warn({ origin }, 'artifact.csp.invalid_embed_origin — dropped from frame-ancestors');
  }
  return valid;
}

export function buildEmbedCsp(input: CspInput): string {
  const scriptHashes = input.scriptSha256s
    .map((h) => `'sha256-${hexToBase64(h)}'`)
    .join(' ');
  const closed = input.network === 'none';
  const connect = closed ? ["'none'"] : ["'self'"];
  if (input.gatewayWss && !closed) connect.push(input.gatewayWss);

  const frameAncestors = ["'self'", ...embedOriginSources(input.frameAncestors)];

  return [
    `default-src 'none'`,
    `connect-src ${connect.join(' ')}`,
    `script-src 'self' ${scriptHashes}`.trim(),
    `style-src 'self' 'unsafe-inline'`,
    closed ? `img-src data: blob:` : `img-src 'self' data: https:`,
    `font-src 'self' data:`,
    `frame-ancestors ${frameAncestors.join(' ')}`,
    `base-uri 'none'`,
    `form-action 'none'`,
  ].join('; ');
}

/**
 * The embed's policy as a response header: the same policy plus `sandbox
 * allow-scripts`. In path-prefix mode the embed is served from the app's own
 * origin, so opening `/__artifacts__/a/<slug>/embed` as a top-level page would
 * run the artifact's scripts with the app's cookies and storage. The directive
 * gives the page an opaque origin wherever it is opened; framed, it changes
 * nothing (the frames already carry `sandbox="allow-scripts"`). Header only:
 * browsers ignore `sandbox` in a `<meta>` policy.
 */
export function embedCspHeader(csp: string): string {
  return `${csp}; sandbox allow-scripts`;
}

function hexToBase64(hex: string): string {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== 64) {
    throw new Error('csp: invalid sha256 hex (expect 64 hex chars)');
  }
  return Buffer.from(hex, 'hex').toString('base64');
}
