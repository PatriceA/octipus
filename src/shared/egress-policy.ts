import { z } from 'zod';

/** 4 for a dotted-quad IPv4 address, 6 for an IPv6 one, 0 otherwise (no `node:net`: shared code). */
export function ipFamily(value: string): 0 | 4 | 6 {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return value.split('.').every((o) => Number(o) <= 255) ? 4 : 0;
  if (!value.includes(':') || !/^[0-9a-f:.]+$/i.test(value)) return 0;
  try { new URL(`http://[${value}]/`); return 6; } catch { return 0; }
}

/**
 * The operator's declarative egress policy (`security.egressPolicy`): which
 * hosts, ports and schemes a tool may reach. The engine that evaluates it is
 * src/security/egress-policy.ts; docs/EGRESS-POLICY.md is the reference.
 */

/**
 * One spelling for every way a host name can be written: lower case, IDN as
 * punycode, percent-escapes and full-width dots decoded, numeric IPv4 forms
 * (`0x7f000001`, `2130706433`) as dotted quads, IPv6 compressed and without
 * brackets, and no trailing dot. Null when it is not a host at all — anything
 * carrying userinfo, a path, a port, whitespace or an IPv6 zone.
 *
 * WHATWG URL parsing does the decoding, which is the same parser `fetch` and
 * `new URL()` use on the request side, so a rule and a request can never
 * disagree on what a name means.
 */
export function canonicalHost(raw: string): string | null {
  let host = raw.trim();
  if (!host || /[@/?#\\\s]/.test(host)) return null;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  const v6 = host.includes(':');
  if (v6 && host.includes('%')) return null;
  let parsed: string;
  try {
    parsed = new URL(`http://${v6 ? `[${host}]` : host}/`).hostname;
  } catch {
    return null;
  }
  if (parsed.startsWith('[') && parsed.endsWith(']')) return parsed.slice(1, -1);
  parsed = parsed.replace(/\.+$/, '');
  if (!parsed || parsed.includes('..') || parsed.startsWith('.')) return null;
  return parsed;
}

/** `*.example.com` (subdomains of example.com, not the apex) or an exact host / IP. */
function validHostPattern(pattern: string): boolean {
  const wildcard = pattern.startsWith('*.');
  const host = canonicalHost(wildcard ? pattern.slice(2) : pattern);
  return host !== null && !(wildcard && ipFamily(host) !== 0);
}

/** `203.0.113.0/24`, `2001:db8::/32`. */
export function parseCidr(cidr: string): { address: string; prefix: number; family: 'ipv4' | 'ipv6' } | null {
  const m = /^([^/]+)\/(\d{1,3})$/.exec(cidr.trim());
  if (!m) return null;
  const version = ipFamily(m[1]);
  const prefix = Number(m[2]);
  if (version === 0 || prefix > (version === 4 ? 32 : 128)) return null;
  return { address: m[1].toLowerCase(), prefix, family: version === 4 ? 'ipv4' : 'ipv6' };
}

export const egressSchemeSchema = z.enum(['http', 'https']);
export type EgressScheme = z.infer<typeof egressSchemeSchema>;

export const egressRuleSchema = z.object({
  action: z.enum(['allow', 'deny']),
  /** `api.example.com` (exact), `*.example.com` (any subdomain) or an IP literal. */
  host: z.string().min(1).max(260).refine(validHostPattern, 'Use a host name, *.domain or an IP address').optional(),
  /** An address range matched against the resolved addresses of every request. */
  cidr: z.string().refine((value) => parseCidr(value) !== null, 'Use an address range such as 203.0.113.0/24').optional(),
  /** Ports the rule covers; every port when absent. */
  ports: z.array(z.number().int().min(1).max(65535)).min(1).max(64).optional(),
  /** Schemes the rule covers; both when absent. A proxy tunnel (CONNECT) counts as https. */
  schemes: z.array(egressSchemeSchema).min(1).optional(),
  /** Why the rule exists, shown in refusals and the audit log. */
  note: z.string().max(200).optional(),
}).strict().refine((rule) => (rule.host === undefined) !== (rule.cidr === undefined), 'A rule names exactly one of host or cidr');
export type EgressRule = z.infer<typeof egressRuleSchema>;

const egressDefaultSchema = z.enum(['allow', 'deny']);

/** Rules for one tool or role, added to the global ones. */
export const egressScopeSchema = z.object({
  /** Overrides the global default for this tool (or role). A tool's default wins over a role's. */
  default: egressDefaultSchema.optional(),
  rules: z.array(egressRuleSchema).max(500).default([]),
}).strict();
export type EgressScope = z.infer<typeof egressScopeSchema>;

export const egressPolicySchema = z.object({
  /** What a request no rule matches gets. `allow` keeps the behaviour of an install without a policy. */
  default: egressDefaultSchema.default('allow'),
  rules: z.array(egressRuleSchema).max(500).default([]),
  /** By tool id (`websearch`, `shell`, `browser`, `vision`) or `plugin:<package>`. */
  tools: z.record(z.string().regex(/^[a-z0-9][a-z0-9:_.-]{0,99}$/i), egressScopeSchema).default({}),
  /** By agent role (`research`, `coding`, ...): the role a tool call runs under. */
  roles: z.record(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i), egressScopeSchema).default({}),
  /**
   * Refuse a shell command whose network the sandbox cannot confine (sandbox
   * off, or no working runner), instead of running it with the proxy as
   * advice only.
   */
  requireEnforcement: z.boolean().default(false),
}).strict();
export type EgressPolicy = z.infer<typeof egressPolicySchema>;

export const DEFAULT_EGRESS_POLICY: EgressPolicy = { default: 'allow', rules: [], tools: {}, roles: {}, requireEnforcement: false };
