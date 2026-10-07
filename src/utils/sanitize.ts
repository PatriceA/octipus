import dns from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';

/**
 * The single boundary for "this output is too big to hand a model". Exported
 * so the spill path saves exactly what this would otherwise cut off — two
 * different thresholds would mean output that is truncated but never saved.
 */
export const DEFAULT_MAX_LENGTH = 50_000;

export interface UrlValidation {
  valid: boolean;
  reason?: string;
  /**
   * The public IPs the hostname resolved to during validation. Present only
   * when `valid` and the host was a DNS name (empty for IP-literal URLs, which
   * carry the address in the URL itself). Callers pin their connection to one
   * of these to close the DNS-rebinding (TOCTOU) gap — see {@link fetchGuarded}.
   */
  addresses?: string[];
}

/**
 * Validate a URL against SSRF attacks.
 * Rejects private/reserved IPs, non-http(s) schemes, and localhost.
 */
export async function validateExternalUrl(
  url: string
): Promise<UrlValidation> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, reason: 'Invalid URL' };
  }

  // 1. Only allow http/https
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, reason: `Disallowed scheme: ${parsed.protocol}` };
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  // 2. Reject localhost
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return { valid: false, reason: 'Localhost URLs are not allowed' };
  }

  // 3. Reject ambiguous / non-standard IP literal encodings before we ever
  //    resolve. `http://2130706433/`, `http://0x7f000001/`, and octal forms
  //    all decode to 127.0.0.1 but slip past a dotted-quad check (and DNS
  //    resolution of them fails, so the old fallback treated them as a public
  //    "hostname"). Anything that looks numeric/hex but isn't a clean
  //    dotted-quad IPv4 or bracketed IPv6 is refused outright.
  if (looksLikeNonStandardIpLiteral(hostname)) {
    return { valid: false, reason: `Ambiguous IP literal not allowed: ${hostname}` };
  }

  // 4. If the host is already a standard IP literal, check it directly.
  if (isIpLiteral(hostname)) {
    if (isPrivateIP(hostname)) {
      return { valid: false, reason: `IP ${hostname} is in a private/reserved range` };
    }
    return { valid: true };
  }

  // 5. Otherwise resolve the hostname (both families) and check every address.
  const addresses: string[] = [];
  try {
    addresses.push(...(await dns.promises.resolve4(hostname)));
  } catch { /* no A records */ }
  try {
    addresses.push(...(await dns.promises.resolve6(hostname)));
  } catch { /* no AAAA records */ }

  if (addresses.length === 0) {
    return { valid: false, reason: `Could not resolve hostname: ${hostname}` };
  }

  for (const ip of addresses) {
    if (isPrivateIP(ip)) {
      return { valid: false, reason: `IP ${ip} is in a private/reserved range` };
    }
  }

  // Return the vetted addresses so callers can pin the connection to one of
  // them (see fetchGuarded) rather than re-resolving — which is what closes the
  // DNS-rebinding (TOCTOU) gap where a malicious resolver answers with a public
  // IP here and a private one at connect time.
  return { valid: true, addresses };
}

/**
 * Assert that a concrete connected IP (e.g. from Playwright's
 * `response.serverAddr()`) is public. Defense-in-depth for connection paths
 * that can't be IP-pinned: verify *after* connecting and reject a rebind.
 */
export function assertPublicAddress(ip: string | null | undefined): { ok: boolean; reason?: string } {
  if (!ip) return { ok: true }; // nothing to check (e.g. served from cache)
  if (isPrivateIP(ip)) return { ok: false, reason: `Connected to private/reserved IP ${ip}` };
  return { ok: true };
}

/**
 * SSRF-safe fetch. Validates the URL, then pins the connection to a vetted IP
 * so the host is never re-resolved between check and connect (closes DNS
 * rebinding). For https, SNI + Host are kept as the original hostname so TLS
 * cert validation is unchanged. Throws on a blocked URL.
 */
export async function fetchGuarded(url: string, init: RequestInit = {}, maxRedirects = 5): Promise<Response> {
  const validation = await validateExternalUrl(url);
  if (!validation.valid) {
    throw new Error(`URL blocked (SSRF guard): ${validation.reason}`);
  }

  const addresses = validation.addresses ?? [];

  // Redirects must NOT be followed by the underlying fetch — the guard only
  // validated THIS hop. Force `redirect: 'manual'` and re-run the guard on each
  // redirect target so an open redirect to a private IP (e.g. cloud metadata)
  // can't bypass the check. A caller asking for 'follow' (or the default) gets
  // safe, re-validated following; 'manual'/'error' is honored as-is.
  const wantsFollow = init.redirect !== 'manual' && init.redirect !== 'error';
  const guardedInit: RequestInit = { ...init, redirect: 'manual' };

  let res: Response;
  // IP-literal URLs have no resolved addresses — they were vetted directly and
  // carry the address in the URL, so there is nothing to re-resolve.
  if (addresses.length === 0) {
    res = await fetch(url, guardedInit);
  } else {
    res = await fetchPinned(url, addresses[0], guardedInit);
  }

  if (wantsFollow && res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location');
    if (location && maxRedirects > 0) {
      // Drain the hop we are abandoning. Its body is a live socket, and with
      // keep-alive an unread one is held until GC — Reader and Deep Research
      // follow a redirect on most real URLs, so it accumulates per fetch.
      await res.body?.cancel().catch(() => { /* already closed */ });
      const next = new URL(location, url).toString(); // resolve relative redirects
      return fetchGuarded(next, init, maxRedirects - 1);
    }
  }
  return res;
}

/**
 * `RequestInit['body']` reduced to bytes. Covers what `fetch` accepts and this
 * path can send without streaming; anything else is refused loudly rather than
 * silently sent as "[object Object]".
 */
function toBodyBuffer(body: BodyInit): Buffer {
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (Buffer.isBuffer(body)) return body;
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  throw new TypeError(`fetchPinned: unsupported body type ${body?.constructor?.name ?? typeof body}`);
}

/**
 * A `lookup` for `node:net`/`node:http(s)` (and `ws`, which passes it through)
 * that answers every resolution with `ip`, so the socket connects to the
 * address that was vetted and the hostname is never re-resolved. SNI and the
 * Host header still carry the hostname.
 *
 * `all: true` is not optional to support: Node's happy-eyeballs
 * (autoSelectFamily, on by default since 20) asks for the whole list, and
 * answering with a bare string there throws "Invalid IP address".
 */
export function pinnedLookup(ip: string): never {
  return ((hostname: string, options: { all?: boolean }, cb: (...a: unknown[]) => void) => {
    const family = ip.includes(':') ? 6 : 4;
    void hostname;
    if (options?.all) cb(null, [{ address: ip, family }]);
    else cb(null, ip, family);
  }) as never;
}

/**
 * One hop with the socket pinned to an already-vetted IP, while SNI, the Host
 * header and certificate verification all still use the real hostname.
 *
 * This cannot be `fetch`: pinning there meant rewriting the URL to the IP and
 * restoring the hostname through `tls: { serverName }`, which is a Bun option.
 * Node's undici ignores unknown init keys silently, so after the Node
 * migration every guarded HTTPS request went out with the IP as SNI and died
 * in the handshake ("fetch failed") — Reader, Deep Research, webhook actions
 * and provider discovery all lost their outbound path at once. `node:http(s)`
 * has a `lookup` hook, which pins the address without touching the URL, so
 * nothing has to be un-done afterwards.
 */
export async function fetchPinned(url: string, ip: string, init: RequestInit = {}): Promise<Response> {
  const parsed = new URL(url);
  const send = parsed.protocol === 'https:' ? httpsRequest : httpRequest;

  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, key) => {
    headers[key] = value;
  });

  // Materialise the body up front so its length is known. Without an explicit
  // Content-Length, `node:http` falls back to `Transfer-Encoding: chunked`,
  // which undici's `fetch` never did for a string body — and plenty of webhook
  // receivers (API Gateway and several WAFs among them) reject a chunked
  // request body outright. `src/hooks/actions.ts` POSTs JSON through here.
  // `node:http` neither negotiates nor decodes content-encoding, so a caller
  // that asks for gzip would get compressed bytes handed to `res.text()` as if
  // they were HTML. Refusing to ask is the whole fix: servers reply identity.
  delete headers['accept-encoding'];
  delete headers['Accept-Encoding'];
  headers['accept-encoding'] = 'identity';

  const body = init.body == null ? null : toBodyBuffer(init.body);
  if (body && headers['content-length'] === undefined && headers['Content-Length'] === undefined) {
    headers['content-length'] = String(body.byteLength);
  }

  return new Promise<Response>((resolve, reject) => {
    const req = send(
      url,
      {
        method: init.method ?? 'GET',
        headers,
        lookup: pinnedLookup(ip),
      },
      (res) => {
        const resHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) for (const one of value) resHeaders.append(key, one);
          else if (value !== undefined) resHeaders.set(key, value);
        }
        const status = res.statusCode ?? 502;
        // 204/205/304 are null-body statuses — Response rejects a body on them.
        const nullBody = status === 204 || status === 205 || status === 304;
        if (nullBody) res.resume();
        resolve(
          new Response(nullBody ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), {
            status,
            statusText: res.statusMessage,
            headers: resHeaders,
          }),
        );
      },
    );

    req.on('error', reject);

    const signal = init.signal;
    if (signal) {
      const abort = (): void => {
        req.destroy(new Error('The operation was aborted'));
      };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }

    if (body) req.write(body);
    req.end();
  });
}

/** True for a clean dotted-quad IPv4 or a hex-grouped IPv6 literal. */
export function isIpLiteral(host: string): boolean {
  if (/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(host)) {
    return host.split('.').every((p) => Number(p) <= 255 && !(p.length > 1 && p[0] === '0'));
  }
  return host.includes(':'); // IPv6
}

/**
 * Detects integer/hex/octal IPv4 encodings and malformed dotted forms that are
 * not safe to hand to a private-range check (and that DNS won't resolve).
 */
export function looksLikeNonStandardIpLiteral(host: string): boolean {
  if (host.includes(':')) return false; // IPv6 handled by isIpLiteral
  if (/^\d+$/.test(host)) return true; // pure decimal integer (e.g. 2130706433)
  if (/^0x[0-9a-f]+$/i.test(host)) return true; // hex (0x7f000001)
  // Dotted but with hex/octal/oversized octets, e.g. 0x7f.0.0.1 or 0177.0.0.1
  if (host.includes('.') && /^[\dxa-f.]+$/i.test(host) && /[a-fx]/i.test(host)) return true;
  const octets = host.split('.');
  if (octets.length === 4 && octets.every((o) => /^\d+$/.test(o))) {
    // dotted-quad but octal (leading zero) or out-of-range → not standard
    return octets.some((o) => Number(o) > 255 || (o.length > 1 && o[0] === '0'));
  }
  return false;
}

/**
 * An IPv6 address as its eight 16-bit groups, or null when it does not parse.
 * Accepts `::` compression, a dotted IPv4 tail (`::ffff:1.2.3.4`) and a zone
 * suffix (`fe80::1%eth0`), so every spelling of one address is checked alike.
 */
function ipv6Groups(ip: string): number[] | null {
  let addr = ip.split('%')[0].toLowerCase();
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  if (v4) {
    const o = v4.slice(1).map(Number);
    if (o.some((n) => n > 255)) return null;
    addr = `${addr.slice(0, v4.index)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === '') return [];
    const groups = part.split(':');
    if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
    return groups.map((g) => parseInt(g, 16));
  };
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

/** The IPv4 address held in two IPv6 groups, dotted. */
function embeddedIPv4(hi: number, lo: number): string {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
}

function isPrivateIPv6(ip: string): boolean {
  const g = ipv6Groups(ip);
  if (!g) return true; // unparseable: refuse rather than guess
  const [a, b] = g;
  const zeroPrefix = (n: number) => g.slice(0, n).every((x) => x === 0);
  // ::/96 — unspecified, loopback and the deprecated IPv4-compatible
  // `::a.b.c.d` (URL parsing turns `[::127.0.0.1]` into `::7f00:1`).
  if (zeroPrefix(6)) return true;
  // ::ffff:0:0/96 IPv4-mapped and ::ffff:0:0:0/96 IPv4-translated.
  if (zeroPrefix(5) && g[5] === 0xffff) return true;
  if (zeroPrefix(4) && g[4] === 0xffff && g[5] === 0) return true;
  // NAT64 well-known 64:ff9b::/96 and local-use 64:ff9b:1::/48: the whole
  // class, whatever IPv4 it embeds — a NAT64 gateway reaches the v4 side.
  if (a === 0x64 && b === 0xff9b) return true;
  if (a === 0x100 && b === 0 && g[2] === 0 && g[3] === 0) return true; // 100::/64 discard
  if (a === 0x2001 && b === 0) return true; // 2001::/32 Teredo (tunnels to an embedded IPv4)
  if (a === 0x2001 && b === 0xdb8) return true; // 2001:db8::/32 documentation
  if (a === 0x2001 && (b & 0xfff0) === 0x10) return true; // 2001:10::/28 ORCHID
  if (a === 0x2002) return isPrivateIP(embeddedIPv4(b, g[2])); // 2002::/16 6to4: its embedded IPv4
  if ((a & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((a & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((a & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((a & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

export function isPrivateIP(ip: string): boolean {
  if (ip.includes(':')) return isPrivateIPv6(ip);

  // IPv4 checks
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p))) {
    return false;
  }

  const [a, b] = parts;

  if (a === 0) return true; // 0.0.0.0/8 ("this network")
  if (a === 127) return true; // loopback
  if (a === 10) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata 169.254.169.254)
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 192 && b === 0 && parts[2] === 0) return true; // 192.0.0.0/24 (IETF protocol)
  if (a === 192 && b === 0 && parts[2] === 2) return true; // 192.0.2.0/24 TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a === 198 && b === 51 && parts[2] === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && parts[2] === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast + reserved (224.0.0.0/3)

  return false;
}

/**
 * Safely compile a user-supplied regex pattern.
 * Returns null if the pattern is too complex or invalid.
 */
export function safeRegExp(pattern: string, flags?: string): RegExp | null {
  // Reject patterns that could cause catastrophic backtracking
  if (pattern.length > 200) return null;
  if (/(\.\*){3,}/.test(pattern)) return null; // repeated .*
  if (/(\([^)]*\+[^)]*\))\1*\+/.test(pattern)) return null; // nested quantifiers
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

/**
 * Sanitize tool output for inclusion in LLM messages.
 * Converts to string and truncates if over limit.
 */
export function sanitizeToolOutput(
  output: unknown,
  options: { maxLength?: number } = {}
): string {
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;

  let str: string;
  if (typeof output === 'string') {
    str = output;
  } else if (output === null || output === undefined) {
    return '';
  } else {
    try {
      str = JSON.stringify(output);
    } catch {
      str = String(output);
    }
  }

  if (str.length > maxLength) {
    return str.slice(0, maxLength) + ' [truncated]';
  }

  return str;
}
