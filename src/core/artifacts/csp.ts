/**
 * CSP policy builder for hosted artifact pages. Subdomain isolation does most
 * of the work; CSP is the second layer. SDK script is pinned by SHA256;
 * custom JS bundles add their per-version SHA256 to `script-src`.
 */

export interface CspInput {
  /** SHA256 hashes (raw hex) of trusted inline/external scripts. */
  scriptSha256s: string[];
  /** Origin of the gateway WS (e.g. `wss://gateway.example.com`). */
  gatewayWss?: string;
  /** Extra `frame-ancestors` entries beyond `'self'`. */
  frameAncestors?: string[];
}

export function buildEmbedCsp(input: CspInput): string {
  const scriptHashes = input.scriptSha256s
    .map((h) => `'sha256-${hexToBase64(h)}'`)
    .join(' ');
  const connect = ["'self'"];
  if (input.gatewayWss) connect.push(input.gatewayWss);

  const frameAncestors = ["'self'", ...(input.frameAncestors ?? [])];

  return [
    `default-src 'none'`,
    `connect-src ${connect.join(' ')}`,
    `script-src 'self' ${scriptHashes}`.trim(),
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: https:`,
    `font-src 'self' data:`,
    `frame-ancestors ${frameAncestors.join(' ')}`,
    `base-uri 'none'`,
    `form-action 'none'`,
  ].join('; ');
}

function hexToBase64(hex: string): string {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== 64) {
    throw new Error('csp: invalid sha256 hex (expect 64 hex chars)');
  }
  return Buffer.from(hex, 'hex').toString('base64');
}
