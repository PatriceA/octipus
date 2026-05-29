import dns from 'node:dns';

const DEFAULT_MAX_LENGTH = 50_000;

/**
 * Validate a URL against SSRF attacks.
 * Rejects private/reserved IPs, non-http(s) schemes, and localhost.
 */
export async function validateExternalUrl(
  url: string
): Promise<{ valid: boolean; reason?: string }> {
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

  // NOTE: callers re-resolve at connect time (fetch/page.goto), so a malicious
  // resolver can still rebind to a private IP between this check and the
  // connection (TOCTOU). Connect-time pinning is tracked as a follow-up.
  return { valid: true };
}

/** True for a clean dotted-quad IPv4 or a hex-grouped IPv6 literal. */
function isIpLiteral(host: string): boolean {
  if (/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(host)) {
    return host.split('.').every((p) => Number(p) <= 255 && !(p.length > 1 && p[0] === '0'));
  }
  return host.includes(':'); // IPv6
}

/**
 * Detects integer/hex/octal IPv4 encodings and malformed dotted forms that are
 * not safe to hand to a private-range check (and that DNS won't resolve).
 */
function looksLikeNonStandardIpLiteral(host: string): boolean {
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

function isPrivateIP(ip: string): boolean {
  // IPv6 loopback, unspecified, unique-local (fc00::/7), link-local (fe80::/10).
  if (ip.includes(':')) {
    if (ip === '::1' || ip === '::') return true;
    if (/^f[cd]/i.test(ip)) return true; // fc00::/7
    if (/^fe[89ab]/i.test(ip)) return true; // fe80::/10
    // IPv4-mapped (::ffff:a.b.c.d, normalized to ::ffff:h:h) and NAT64
    // (64:ff9b::/96) are common SSRF bypasses — disallow the whole class.
    if (/^::ffff:/i.test(ip) || /^64:ff9b:/i.test(ip)) return true;
    return false;
  }

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
