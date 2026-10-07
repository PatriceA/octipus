/**
 * The address a request really came from.
 *
 * `X-Forwarded-For` and `X-Real-IP` are client-supplied headers: anyone can
 * send `X-Forwarded-For: 127.0.0.1`. They mean something only when a reverse
 * proxy the operator runs wrote them, so they are honoured only when the TCP
 * peer (the socket address) is listed in `security.trustedProxies`. Otherwise
 * the socket address is the answer, whatever the headers say.
 *
 * Every consumer of a client address goes through `clientIp`: the gateway's
 * pre-auth connection cap, the REST rate limits, the login lockouts and the
 * audit log. A second, header-first reader anywhere would reopen the hole.
 */
import { BlockList, isIP } from 'node:net';
import { getConfig } from '@/config';
import { securityLogger } from '@/utils/logger';

/** What `clientIp` answers when there is no socket (an in-process `app.handle` call). */
export const UNKNOWN_CLIENT_IP = 'unknown';

/** `::ffff:10.0.0.1` → `10.0.0.1`, so one entry matches both socket families. */
function normalizeAddress(address: string): string {
  const trimmed = address.trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed);
  return mapped ? mapped[1] : trimmed;
}

/**
 * Parse `security.trustedProxies` into a matcher. Entries are single addresses
 * (`10.0.0.5`, `::1`) or CIDR ranges (`10.0.0.0/8`, `fd00::/8`). A malformed
 * entry throws: a typo here would otherwise silently trust nobody, or the
 * operator would believe a proxy is trusted when it is not.
 */
export function parseTrustedProxies(entries: readonly string[]): BlockList {
  return parseAddressList(entries, 'security.trustedProxies');
}

/**
 * Parse a list of addresses and CIDR ranges into a matcher; `setting` names
 * the config key in the error. Shared with `federation.lanCidrs`.
 */
export function parseAddressList(entries: readonly string[], setting: string): BlockList {
  const list = new BlockList();
  for (const raw of entries) {
    const entry = raw.trim();
    const slash = entry.indexOf('/');
    const address = normalizeAddress(slash === -1 ? entry : entry.slice(0, slash));
    const family = isIP(address);
    if (family === 0) {
      throw new Error(`${setting}: "${raw}" is not an IP address or CIDR range`);
    }
    const type = family === 4 ? 'ipv4' : 'ipv6';
    if (slash === -1) {
      list.addAddress(address, type);
      continue;
    }
    const prefix = Number(entry.slice(slash + 1));
    const max = family === 4 ? 32 : 128;
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) {
      throw new Error(`${setting}: "${raw}" has an invalid prefix length`);
    }
    list.addSubnet(address, prefix, type);
  }
  return list;
}

let cached: { key: string; list: BlockList } | null = null;

function trustedProxies(): BlockList {
  const entries = getConfig().security?.trustedProxies ?? [];
  const key = entries.join(',');
  if (cached?.key !== key) cached = { key, list: parseTrustedProxies(entries) };
  return cached.list;
}

function isTrusted(list: BlockList, address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return list.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** Whether `address` (either socket family spelling) is in `list`. */
export function addressInList(list: BlockList, address: string): boolean {
  return isTrusted(list, normalizeAddress(address));
}

/** Whether the socket peer `address` is a trusted reverse proxy. */
export function isTrustedProxy(address: string): boolean {
  return addressInList(trustedProxies(), address);
}

/**
 * The client address for a request that arrived on `socketAddress`.
 *
 * When the peer is a trusted proxy, `X-Forwarded-For` is read right to left,
 * skipping the trusted proxies in the chain: the first untrusted hop is the
 * client. Everything left of it was written by the client and is ignored.
 * `X-Real-IP` is the fallback for a proxy that sets only that header.
 */
export function clientIp(request: Request, socketAddress: string | undefined): string {
  if (!socketAddress) return UNKNOWN_CLIENT_IP;
  const peer = normalizeAddress(socketAddress);
  const list = trustedProxies();
  if (!isTrusted(list, peer)) return peer;

  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const hops = forwarded.split(',').map(normalizeAddress).filter(Boolean);
    for (let i = hops.length - 1; i >= 0; i--) {
      const hop = hops[i];
      if (isIP(hop) === 0) {
        // Our own proxy wrote everything right of here, so a non-address at
        // this position means the proxy is misconfigured. Say so, and fall back
        // to the proxy itself rather than to a value nobody vouches for.
        securityLogger.warn({ peer, forwarded }, 'Trusted proxy sent a malformed X-Forwarded-For; using the proxy address');
        return peer;
      }
      if (!isTrusted(list, hop)) return hop;
    }
    // Every hop is a trusted proxy: the request started inside the proxy tier.
    return hops[0] ?? peer;
  }

  const real = request.headers.get('x-real-ip');
  if (real) {
    const address = normalizeAddress(real);
    if (isIP(address) !== 0) return address;
    securityLogger.warn({ peer, real }, 'Trusted proxy sent a malformed X-Real-IP; using the proxy address');
  }
  return peer;
}

/**
 * `clientIp` for a stored record (audit rows, session metadata): undefined
 * instead of the `unknown` placeholder, which an `inet` column rejects.
 */
export function recordedClientIp(request: Request, socketAddress: string | undefined): string | undefined {
  const ip = clientIp(request, socketAddress);
  return ip === UNKNOWN_CLIENT_IP ? undefined : ip;
}
