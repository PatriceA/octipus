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

  const hostname = parsed.hostname.toLowerCase();

  // 2. Reject localhost and 0.0.0.0
  if (
    hostname === 'localhost' ||
    hostname === '0.0.0.0' ||
    hostname === '[::1]' ||
    hostname === '::1'
  ) {
    return { valid: false, reason: 'Localhost URLs are not allowed' };
  }

  // 3. Resolve hostname to IPs and check against private ranges
  let addresses: string[];
  try {
    // Try IPv4 first
    addresses = await dns.promises.resolve4(hostname);
  } catch {
    try {
      // Fall back to IPv6
      addresses = await dns.promises.resolve6(hostname);
    } catch {
      // If hostname looks like an IP literal, check it directly
      addresses = [hostname.replace(/^\[|\]$/g, '')];
    }
  }

  for (const ip of addresses) {
    if (isPrivateIP(ip)) {
      return { valid: false, reason: `IP ${ip} is in a private/reserved range` };
    }
  }

  return { valid: true };
}

function isPrivateIP(ip: string): boolean {
  // IPv6 loopback and private
  if (ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80')) {
    return true;
  }

  // IPv4 checks
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p))) {
    // Not a valid IPv4, could be an IPv6 we already checked above
    return false;
  }

  const [a, b] = parts;

  // 127.x.x.x (loopback)
  if (a === 127) return true;
  // 10.x.x.x (private)
  if (a === 10) return true;
  // 172.16.0.0 - 172.31.255.255 (private)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.x.x (private)
  if (a === 192 && b === 168) return true;
  // 169.254.x.x (link-local)
  if (a === 169 && b === 254) return true;
  // 0.0.0.0
  if (a === 0 && b === 0 && parts[2] === 0 && parts[3] === 0) return true;

  return false;
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
