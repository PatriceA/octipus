/**
 * Egress policy engine — one decision for every outbound path a tool takes
 * (docs/EGRESS-POLICY.md).
 *
 * The operator writes `security.egressPolicy` (src/shared/egress-policy.ts):
 * allow and deny rules by host (exact or `*.domain`), address range, port and
 * scheme, a default, and further rules per tool and per agent role. This
 * module evaluates it. The paths that consult it:
 *
 * - `fetchGuarded` (src/utils/sanitize.ts) — the web-fetch tools, vision's
 *   image fetch, the plugin host's `web:read`. Every redirect hop is a new
 *   `fetchGuarded` call, so it is checked like the first.
 * - The egress proxy (src/security/egress-proxy.ts) — sandboxed shell
 *   commands that asked for network, and plugin package servers.
 * - The browser and websearch page tools, which navigate with Playwright
 *   (`assertBrowserNavigationAllowed`).
 *
 * The policy narrows; it never widens. The SSRF guard (`isPrivateIP`) still
 * refuses loopback, private, link-local and metadata addresses first, whatever
 * a rule allows.
 *
 * Evaluation, for one request `host:port` over `scheme`:
 *
 * 1. The host is put in canonical form (`canonicalHost`): case, IDN,
 *    percent-escapes, numeric IPv4 forms, IPv6 spelling and a trailing dot
 *    cannot make a name miss a rule.
 * 2. The rules that apply are the global ones, the role's and the tool's.
 * 3. A deny rule that matches wins: the name, or ANY resolved address.
 * 4. Otherwise an allow rule that matches allows: the name, or an address
 *    rule that covers EVERY resolved address.
 * 5. Otherwise the default: the tool's, else the role's, else the global one.
 *
 * Address rules are checked against the addresses the caller resolved and will
 * connect to (both `fetchGuarded` and the proxy pin the connection to them), so
 * a name re-resolving to another address afterwards cannot change the answer.
 *
 * A tool call carries its subject (tool id, role) through `withEgressSubject`,
 * set by `BaseTool` around every handler. Outbound traffic with no subject —
 * model providers, webhooks, federation — is the operator's own and is not
 * judged by this policy.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { BlockList } from 'node:net';
import { getConfig } from '@/config';
import { canonicalHost, DEFAULT_EGRESS_POLICY, type EgressPolicy, type EgressRule, type EgressScheme, type EgressScope, embeddedIPv4, ipFamily, ipv6GroupsOf, parseCidr } from '@/shared/egress-policy';
import { coreLogger } from '@/utils/logger';

export interface EgressSubject {
  /** The tool id (`websearch`, `shell`) or `plugin:<package>`. */
  tool?: string;
  /** The agent role the call runs under. */
  role?: string;
  /**
   * The roles of the agents that spawned it, root first: the call is judged
   * under each of them too (a child cannot widen its parent's egress).
   */
  roles?: string[];
  userId?: string;
  agentId?: string;
  sessionId?: string;
}

export interface EgressTarget {
  host: string;
  port: number;
  scheme: EgressScheme;
}

export interface EgressDecision {
  allowed: boolean;
  /** The canonical host (or the raw one, when it does not parse). */
  host: string;
  port: number;
  scheme: EgressScheme;
  /** The rule that decided, or `default (deny)` / `default (allow)`. */
  rule: string;
  /** True for a name-only check that found no deny: the addresses are still to be checked. */
  provisional?: boolean;
}

const subjects = new AsyncLocalStorage<EgressSubject>();

/** Run `run` as `subject`: outbound requests inside it are judged as that tool and role. */
export function withEgressSubject<T>(subject: EgressSubject, run: () => T): T {
  return subjects.run(subject, run);
}

export function currentEgressSubject(): EgressSubject | undefined {
  return subjects.getStore();
}

/** Whether `policy` changes anything: an install without one behaves exactly as before. */
export function egressPolicyActive(policy: EgressPolicy): boolean {
  const scopes: EgressScope[] = [...Object.values(policy.tools), ...Object.values(policy.roles)];
  return policy.default === 'deny' || policy.requireEnforcement || policy.rules.length > 0
    || scopes.some((scope) => scope.rules.length > 0 || scope.default === 'deny');
}

/** The configured policy; the default (no restriction) where configuration is not loaded. */
export function activeEgressPolicy(): EgressPolicy {
  try {
    return getConfig().security.egressPolicy ?? DEFAULT_EGRESS_POLICY;
  } catch (err) {
    coreLogger.debug({ err: (err as Error).message }, 'Egress policy: configuration not loaded, no policy applies');
    return DEFAULT_EGRESS_POLICY;
  }
}

/**
 * An address as the rules see it: canonical, and an IPv6 address that stands
 * for an IPv4 host — IPv4-mapped, IPv4-compatible, 6to4 — as that IPv4.
 */
export function canonicalAddress(address: string): string | null {
  const host = canonicalHost(address);
  if (!host) return null;
  if (ipFamily(host) !== 6) return host;
  const groups = ipv6GroupsOf(host);
  return (groups && embeddedIPv4(groups)) ?? host;
}

interface CompiledRule {
  rule: EgressRule;
  label: string;
  /** A host name rule (not an IP); `any` for `*`. */
  name?: { host: string; wildcard: boolean; any: boolean };
  /** An address rule: a cidr, or a host rule naming an IP. */
  range?: BlockList;
}

const compiled = new WeakMap<EgressRule, CompiledRule>();

function compile(rule: EgressRule, label: string): CompiledRule {
  const cached = compiled.get(rule);
  if (cached && cached.label === label) return cached;
  const out: CompiledRule = { rule, label };
  if (rule.host === '*') {
    out.name = { host: '*', wildcard: false, any: true };
  } else if (rule.host !== undefined) {
    const wildcard = rule.host.startsWith('*.');
    const host = canonicalHost(wildcard ? rule.host.slice(2) : rule.host);
    const ip = host ? canonicalAddress(host) : null;
    if (host && ip && ipFamily(ip) !== 0 && !wildcard) {
      out.range = new BlockList();
      out.range.addAddress(ip, ipFamily(ip) === 4 ? 'ipv4' : 'ipv6');
    } else if (host) {
      out.name = { host, wildcard, any: false };
    }
  } else if (rule.cidr !== undefined) {
    const cidr = parseCidr(rule.cidr);
    if (cidr) {
      out.range = new BlockList();
      out.range.addSubnet(cidr.address, cidr.prefix, cidr.family);
    }
  }
  compiled.set(rule, out);
  return out;
}

function inRange(range: BlockList, address: string): boolean {
  const family = ipFamily(address);
  return family !== 0 && range.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** Whether a rule covers this port and scheme at all. */
function covers(c: CompiledRule, target: EgressTarget): boolean {
  return (!c.rule.ports || c.rule.ports.includes(target.port)) && (!c.rule.schemes || c.rule.schemes.includes(target.scheme));
}

/**
 * Whether `c` matches. A deny address rule matches when ANY address is in
 * range; an allow one only when EVERY address is (the connection may go to
 * any of them).
 */
function matches(c: CompiledRule, host: string, target: EgressTarget, addresses: string[]): boolean {
  if (!covers(c, target)) return false;
  if (c.name) {
    if (c.name.any) return true;
    if (ipFamily(host) !== 0) return false;
    return c.name.wildcard ? host.endsWith(`.${c.name.host}`) : host === c.name.host;
  }
  if (c.range && addresses.length > 0) {
    return c.rule.action === 'deny'
      ? addresses.some((a) => inRange(c.range!, a))
      : addresses.every((a) => inRange(c.range!, a));
  }
  return false;
}

function describe(rule: EgressRule, scope: string, index: number): string {
  return `${scope} rule ${index + 1} (${rule.action} ${rule.host ?? rule.cidr}${rule.ports ? ` ports ${rule.ports.join(',')}` : ''}${rule.schemes ? ` ${rule.schemes.join('/')}` : ''})${rule.note ? `: ${rule.note}` : ''}`;
}

/** The context metadata key carrying the spawn chain's roles (set by the swarm spawner, server-side). */
export const EGRESS_ROLE_CHAIN_KEY = 'egressRoleChain';

/** The ancestors' roles from a context's metadata, root first. */
export function egressRoleChain(metadata: unknown): string[] {
  const chain = (metadata as Record<string, unknown> | undefined)?.[EGRESS_ROLE_CHAIN_KEY];
  return Array.isArray(chain) ? chain.filter((r): r is string => typeof r === 'string') : [];
}

/**
 * A child's context metadata with the spawn chain's roles appended: the
 * parent's own chain and the parent's role. Every spawn path calls it (the
 * swarm spawner, pipeline/hook workers), so no child loses its ancestors.
 */
export function withEgressRoleChain(metadata: Record<string, unknown> | undefined, parent: { role?: string; metadata?: unknown }): Record<string, unknown> {
  const chain = [...egressRoleChain(parent.metadata), ...(parent.role ? [parent.role] : [])];
  return { ...(metadata ?? {}), [EGRESS_ROLE_CHAIN_KEY]: chain };
}

/** The roles a call is judged under: the agent's own and every ancestor's in its spawn chain. */
export function subjectRoles(subject: EgressSubject): string[] {
  return [...new Set([...(subject.roles ?? []), ...(subject.role ? [subject.role] : [])])];
}

/**
 * Decide one request. `resolved` is the list of addresses the connection will
 * use. An IP-literal host is its own address.
 *
 * Omitted, only the name is judged, which is final unless an address could
 * still change the answer: a deny on the name refuses; with no address rule
 * that covers this port and scheme, the name's allow or the default decides;
 * with a deny default, no name allow and no address allow that could match,
 * it refuses — before anything is resolved, so a denied name never leaves as
 * a DNS query. Otherwise the result is `provisional`: resolve, then ask again.
 *
 * A call under a spawn chain of roles is judged under each of them (the
 * agent's own and every ancestor's): it is allowed only when every one allows
 * it, so a restricted agent cannot fetch through a child of a looser role.
 */
export function evaluateEgress(policy: EgressPolicy, subject: EgressSubject, target: EgressTarget, resolved?: readonly string[]): EgressDecision {
  const roles = subjectRoles(subject);
  if (roles.length <= 1) return evaluateOne(policy, subject.tool, roles[0], target, resolved);
  let provisional: EgressDecision | null = null;
  let last: EgressDecision | null = null;
  for (const role of roles) {
    const decision = evaluateOne(policy, subject.tool, role, target, resolved);
    if (!decision.allowed) return decision;
    if (decision.provisional) provisional ??= decision;
    last = decision;
  }
  return provisional ?? (last as EgressDecision);
}

function evaluateOne(policy: EgressPolicy, tool: string | undefined, role: string | undefined, target: EgressTarget, resolved?: readonly string[]): EgressDecision {
  const host = canonicalHost(target.host);
  const base = { port: target.port, scheme: target.scheme };
  if (!host || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535) {
    return { ...base, allowed: false, host: target.host, rule: 'malformed host or port' };
  }
  const literal = canonicalAddress(host);
  const isLiteral = literal !== null && ipFamily(literal) !== 0;
  const addresses = isLiteral ? [literal] : (resolved ?? []).map(canonicalAddress).filter((a): a is string => a !== null && ipFamily(a) !== 0);
  const nameOnly = !isLiteral && resolved === undefined;
  if (!isLiteral && resolved !== undefined && addresses.length !== resolved.length) {
    return { ...base, allowed: false, host, rule: 'malformed resolved address' };
  }
  const roleScope = role ? policy.roles[role] : undefined;
  const toolScope = tool ? policy.tools[tool] : undefined;
  const rules: CompiledRule[] = [
    ...policy.rules.map((r, i) => compile(r, describe(r, 'global', i))),
    ...(roleScope?.rules ?? []).map((r, i) => compile(r, describe(r, `role ${role}`, i))),
    ...(toolScope?.rules ?? []).map((r, i) => compile(r, describe(r, `tool ${tool}`, i))),
  ];
  const judged = isLiteral ? literal : host;
  const fallback = toolScope?.default ?? roleScope?.default ?? policy.default;
  const from = toolScope?.default ? `tool ${tool} default` : roleScope?.default ? `role ${role} default` : 'default';
  const byDefault = { ...base, allowed: fallback === 'allow', host, rule: `${from} (${fallback})` };
  const deny = rules.find((c) => c.rule.action === 'deny' && matches(c, judged, target, addresses));
  if (deny) return { ...base, allowed: false, host, rule: deny.label };
  if (nameOnly) {
    const addressRules = rules.filter((c) => c.range && covers(c, target));
    const nameAllow = rules.find((c) => c.rule.action === 'allow' && c.name && matches(c, judged, target, []));
    if (addressRules.length === 0) return nameAllow ? { ...base, allowed: true, host, rule: nameAllow.label } : byDefault;
    if (!nameAllow && fallback === 'deny' && !addressRules.some((c) => c.rule.action === 'allow')) return byDefault;
    return { ...base, allowed: true, host, rule: 'name not denied; addresses not yet known', provisional: true };
  }
  const allow = rules.find((c) => c.rule.action === 'allow' && matches(c, judged, target, addresses));
  if (allow) return { ...base, allowed: true, host, rule: allow.label };
  return byDefault;
}

/** A request the egress policy refused. Its message is what the model reads. */
export class EgressDeniedError extends Error {
  readonly code = 'egress_denied';
  constructor(readonly decision: EgressDecision, subject: EgressSubject) {
    super(`Network access to ${decision.host}:${decision.port} (${decision.scheme}) is denied by the operator's egress policy for ${subject.tool ? `tool ${subject.tool}` : 'this tool'}${subject.role ? ` as role ${subject.role}` : ''} — ${decision.rule}. Do not retry this host; use an allowed source or ask the user.`);
    this.name = 'EgressDeniedError';
  }
}

/** Where a refusal happened, for the log and the audit row. */
export type EgressPath = 'fetch' | 'browser' | 'shell-proxy' | 'plugin-proxy' | 'git' | 'github';

/**
 * Log and audit one refusal: host, port, scheme, tool, role and the rule —
 * never a path, query, header or body.
 */
export function reportEgressDenial(decision: EgressDecision, subject: EgressSubject, path: EgressPath): void {
  const details = { host: decision.host, port: decision.port, scheme: decision.scheme, tool: subject.tool ?? null, role: subject.role ?? null, rule: decision.rule, path };
  coreLogger.warn({ ...details, agentId: subject.agentId }, 'Egress refused by policy');
  void import('@/db/repositories/audit-repository')
    .then(({ auditRepository }) => auditRepository.log({
      userId: subject.userId ?? 'system', action: 'permission_denied', resourceType: 'egress',
      resourceId: `${decision.host}:${decision.port}`, sessionId: subject.sessionId ?? null, details,
    }))
    .catch((err: unknown) => coreLogger.warn({ err: (err as Error).message, ...details }, 'Egress refusal could not be written to the audit log'));
}

/**
 * Judge one request of the current tool call against the configured policy
 * and throw `EgressDeniedError` when it is refused. No subject (not a tool
 * call) or no policy: nothing to do. Without `resolved` the name alone must
 * settle it: a provisional answer (an address rule could still apply) is a
 * refusal here — use `precheckEgressName` before resolving instead.
 */
export function enforceEgress(target: EgressTarget, resolved: readonly string[] | undefined, path: EgressPath, subject = currentEgressSubject()): void {
  if (!subject) return;
  const policy = activeEgressPolicy();
  if (!egressPolicyActive(policy)) return;
  let decision = evaluateEgress(policy, subject, target, resolved);
  if (decision.provisional) decision = { ...decision, allowed: false, provisional: false, rule: 'its addresses are not known, and an address rule applies' };
  if (decision.allowed) return;
  reportEgressDenial(decision, subject, path);
  throw new EgressDeniedError(decision, subject);
}

/**
 * The name-only check before a host is resolved: refuses what the name alone
 * settles (a deny, or a deny default nothing could lift), so a refused name
 * is never looked up — DNS is a channel too. A provisional answer passes:
 * judge again with the addresses.
 */
export function precheckEgressName(target: EgressTarget, path: EgressPath, subject = currentEgressSubject()): void {
  if (!subject) return;
  const policy = activeEgressPolicy();
  if (!egressPolicyActive(policy)) return;
  const decision = evaluateEgress(policy, subject, target);
  if (decision.allowed) return;
  reportEgressDenial(decision, subject, path);
  throw new EgressDeniedError(decision, subject);
}

/** `precheckEgressName` for a URL. */
export function precheckEgressUrl(url: string | URL, path: EgressPath, subject = currentEgressSubject()): void {
  const target = egressTargetOf(url);
  if (target) precheckEgressName(target, path, subject);
}

/** The target of a URL: its host, its port (or the scheme's), its scheme. Null for a non-http(s) URL. */
export function egressTargetOf(url: string | URL): EgressTarget | null {
  let parsed: URL;
  try { parsed = typeof url === 'string' ? new URL(url) : url; } catch { return null; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const scheme = parsed.protocol === 'https:' ? 'https' : 'http';
  return { host: parsed.hostname, port: parsed.port ? Number(parsed.port) : scheme === 'https' ? 443 : 80, scheme };
}

/** `enforceEgress` for a URL; a URL with another scheme is not this policy's to judge (the SSRF guard refuses it). */
export function enforceEgressForUrl(url: string | URL, resolved: readonly string[] | undefined, path: EgressPath, subject = currentEgressSubject()): void {
  const target = egressTargetOf(url);
  if (target) enforceEgress(target, resolved, path, subject);
}

/** A Playwright navigation response, structurally. */
interface NavigationResponse { request(): RedirectedRequest; serverAddr(): Promise<{ ipAddress: string } | null> }

/**
 * After a Playwright navigation, a backstop: every hop of the redirect chain,
 * each with the addresses it resolves to now (the last with the address the
 * page was actually served from), against the policy; a refused hop means the
 * page is not handed to the model. The judgement BEFORE each hop is contacted
 * is the egress proxy the browser context is routed through
 * (src/security/browser-egress.ts). Nothing to do outside a tool call or
 * without a policy.
 */
export async function assertBrowserNavigationAllowed(response: NavigationResponse | null | undefined, subject = currentEgressSubject(), resolveHost: (host: string) => Promise<string[]> = lookupAll): Promise<void> {
  if (!response || !subject || !egressPolicyActive(activeEgressPolicy())) return;
  const hops = redirectChainOf(response.request());
  const servedFrom = (await response.serverAddr())?.ipAddress;
  for (const [i, hop] of hops.entries()) {
    const target = egressTargetOf(hop);
    if (!target) continue;
    let addresses: string[] | undefined;
    if (i === hops.length - 1 && servedFrom) addresses = [servedFrom];
    else {
      try { addresses = await resolveHost(target.host); }
      catch (err) { coreLogger.debug({ host: target.host, err: (err as Error).message }, 'Egress: a redirect hop no longer resolves; judged by name alone'); }
    }
    enforceEgress(target, addresses, 'browser', subject);
  }
}

async function lookupAll(host: string): Promise<string[]> {
  const { lookup } = await import('node:dns/promises');
  return (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
}

/** For the egress proxy: a decision function over the policy, reporting refusals. */
export type EgressDecide = (target: EgressTarget, resolved?: readonly string[]) => EgressDecision;

export function egressDecider(subject: EgressSubject, path: EgressPath): EgressDecide {
  return (target, resolved) => {
    const policy = activeEgressPolicy();
    if (!egressPolicyActive(policy)) return { allowed: true, host: target.host, port: target.port, scheme: target.scheme, rule: 'no policy' };
    const decision = evaluateEgress(policy, subject, target, resolved);
    if (!decision.allowed) reportEgressDenial(decision, subject, path);
    return decision;
  };
}

/** A navigation's request and the requests it was redirected from (Playwright's `Request`, structurally). */
interface RedirectedRequest { url(): string; redirectedFrom(): RedirectedRequest | null }

/** Every URL a navigation went through, first to last. */
export function redirectChainOf(request: RedirectedRequest | null | undefined): string[] {
  const chain: string[] = [];
  for (let r = request ?? null; r; r = r.redirectedFrom()) chain.unshift(r.url());
  return chain;
}
