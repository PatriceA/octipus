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

/**
 * Why a rule's `host` does nothing as written, or null when it is usable:
 * `*` (every host), `*.example.com` (subdomains of example.com, not the
 * apex), or an exact host / IP. A `*` anywhere else (`*.*.com`, `api.*`) would
 * be compared as a literal name and match nothing, so it is refused.
 */
export function hostPatternProblem(pattern: string): string | null {
  if (pattern === '*') return null;
  const wildcard = pattern.startsWith('*.');
  const rest = wildcard ? pattern.slice(2) : pattern;
  if (rest.includes('*')) return `"${pattern}": a wildcard is only "*" (every host) or a leading "*." (subdomains)`;
  const host = canonicalHost(rest);
  if (host === null) return `"${pattern}" is not a host name or IP address`;
  if (wildcard && ipFamily(host) !== 0) return `"${pattern}": an IP address has no subdomains; use a cidr rule`;
  return null;
}

/** An IPv6 address (canonical or not) as its eight groups; null when it does not parse. */
export function ipv6GroupsOf(address: string): number[] | null {
  const canonical = canonicalHost(address);
  if (!canonical || ipFamily(canonical) !== 6) return null;
  const [head, tail] = canonical.includes('::') ? canonical.split('::') : [canonical, null];
  const parse = (part: string) => (part === '' ? [] : part.split(':').map((g) => parseInt(g, 16)));
  const h = parse(head);
  const t = tail === null ? [] : parse(tail);
  const groups = tail === null ? h : [...h, ...new Array<number>(8 - h.length - t.length).fill(0), ...t];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/**
 * The IPv4 address an IPv6 address carries and stands for, or null: an
 * IPv4-mapped (`::ffff:a.b.c.d`), IPv4-compatible (`::a.b.c.d`) or 6to4
 * (`2002:aabb:ccdd::/48`) address reaches that IPv4 host, so the rules judge
 * it as that IPv4.
 */
export function embeddedIPv4(groups: number[]): string | null {
  const v4 = (hi: number, lo: number) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
  const zero = (n: number) => groups.slice(0, n).every((g) => g === 0);
  if (zero(5) && groups[5] === 0xffff) return v4(groups[6], groups[7]);
  if (zero(6) && groups[6] !== 0) return v4(groups[6], groups[7]);
  if (groups[0] === 0x2002) return v4(groups[1], groups[2]);
  return null;
}

/**
 * `203.0.113.0/24`, `2001:db8::/32`. An IPv6 range inside the IPv4-mapped,
 * IPv4-compatible or 6to4 space is the IPv4 range it stands for
 * (`::ffff:203.0.113.0/120` is `203.0.113.0/24`), since addresses there are
 * judged as their IPv4; one based there but too short to convert
 * (`::ffff:0:0/90`) is refused (null). An ordinary IPv6 range (`::/0`
 * included) matches native IPv6 addresses only: an embedded IPv4 is judged
 * by IPv4 rules.
 */
export function parseCidr(cidr: string): { address: string; prefix: number; family: 'ipv4' | 'ipv6' } | null {
  const m = /^([^/]+)\/(\d{1,3})$/.exec(cidr.trim());
  if (!m) return null;
  const version = ipFamily(m[1]);
  const prefix = Number(m[2]);
  if (version === 0 || prefix > (version === 4 ? 32 : 128)) return null;
  if (version === 4) return { address: m[1], prefix, family: 'ipv4' };
  const groups = ipv6GroupsOf(m[1]);
  if (!groups) return null;
  const v4 = embeddedIPv4(groups);
  const sixToFour = groups[0] === 0x2002;
  if (v4 !== null) {
    if (sixToFour && prefix >= 16) return { address: v4, prefix: Math.min(32, prefix - 16), family: 'ipv4' };
    if (!sixToFour && prefix >= 96) return { address: v4, prefix: prefix - 96, family: 'ipv4' };
    return null;
  }
  return { address: canonicalHost(m[1]) ?? m[1].toLowerCase(), prefix, family: 'ipv6' };
}

export const egressSchemeSchema = z.enum(['http', 'https', 'ssh']);
export type EgressScheme = z.infer<typeof egressSchemeSchema>;

export const egressRuleSchema = z.object({
  action: z.enum(['allow', 'deny']),
  /** `api.example.com` (exact), `*.example.com` (any subdomain) or an IP literal. */
  host: z.string().min(1).max(260).superRefine((value, ctx) => {
    const problem = hostPatternProblem(value);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  }).optional(),
  /** An address range matched against the resolved addresses of every request. */
  cidr: z.string().refine((value) => parseCidr(value) !== null, 'Use an address range such as 203.0.113.0/24 (an IPv6 range over IPv4-mapped or 6to4 space must lie wholly inside it; prefer the IPv4 range)').optional(),
  /** Ports the rule covers; every port when absent. */
  ports: z.array(z.number().int().min(1).max(65535)).min(1).max(64).optional(),
  /** Schemes the rule covers; all when absent. A proxy tunnel (CONNECT) counts as https; git over SSH as ssh. */
  schemes: z.array(egressSchemeSchema).min(1).optional(),
  /** Why the rule exists, shown in refusals and the audit log. */
  note: z.string().max(200).optional(),
}).strict().refine((rule) => (rule.host === undefined) !== (rule.cidr === undefined), 'A rule names exactly one of host or cidr');
export type EgressRule = z.infer<typeof egressRuleSchema>;

const egressDefaultSchema = z.enum(['allow', 'deny']);
/** Tool and role entries each: enough for every tool and role, bounded so a pasted blob cannot grow without limit. */
const MAX_SCOPES = 200;

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
  tools: z.record(z.string().regex(/^[a-z0-9][a-z0-9:_.-]{0,99}$/i), egressScopeSchema)
    .refine((scopes) => Object.keys(scopes).length <= MAX_SCOPES, `At most ${MAX_SCOPES} tool entries`).default({}),
  /** By agent role (`research`, `coding`, ...): the role a tool call runs under. */
  roles: z.record(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i), egressScopeSchema)
    .refine((scopes) => Object.keys(scopes).length <= MAX_SCOPES, `At most ${MAX_SCOPES} role entries`).default({}),
  /**
   * Refuse what the policy cannot judge instead of letting it through: a
   * shell command whose network no sandbox confines, and the tool actions
   * listed as not covered (docs/EGRESS-POLICY.md#not-covered).
   */
  requireEnforcement: z.boolean().default(false),
}).strict();
export type EgressPolicy = z.infer<typeof egressPolicySchema>;

export const DEFAULT_EGRESS_POLICY: EgressPolicy = { default: 'allow', rules: [], tools: {}, roles: {}, requireEnforcement: false };
