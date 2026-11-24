import { describe, expect, test } from 'vitest';
import { canonicalHost, egressPolicySchema, type EgressPolicy } from '@/shared/egress-policy';
import { canonicalAddress, egressPolicyActive, egressTargetOf, evaluateEgress, redirectChainOf } from './egress-policy';

const policy = (input: unknown): EgressPolicy => egressPolicySchema.parse(input);
const https = (host: string, port = 443) => ({ host, port, scheme: 'https' as const });
const http = (host: string, port = 80) => ({ host, port, scheme: 'http' as const });
const tool = { tool: 'websearch' };

describe('canonicalHost', () => {
  test.each([
    ['EXAMPLE.COM', 'example.com'],
    ['example.com.', 'example.com'],
    ['example.com..', 'example.com'],
    ['bücher.example', 'xn--bcher-kva.example'],
    ['ex%41mple.com', 'example.com'],
    ['example。com', 'example.com'],
    ['0x08080808', '8.8.8.8'],
    ['134744072', '8.8.8.8'],
    ['[2001:4860:4860:0:0:0:0:8888]', '2001:4860:4860::8888'],
    ['2001:4860:4860::8888', '2001:4860:4860::8888'],
    ['user@example.com', null],
    ['example.com/path', null],
    ['exa mple.com', null],
    ['fe80::1%eth0', null],
    ['', null],
  ])('%s → %s', (raw, expected) => {
    expect(canonicalHost(raw)).toBe(expected);
  });

  test('an IPv4-mapped IPv6 address is its IPv4 for the rules', () => {
    expect(canonicalAddress('::ffff:8.8.8.8')).toBe('8.8.8.8');
    expect(canonicalAddress('[::FFFF:808:808]')).toBe('8.8.8.8');
  });
});

describe('egressPolicySchema', () => {
  test('a rule names exactly one of host or cidr', () => {
    expect(() => policy({ rules: [{ action: 'allow' }] })).toThrow(/exactly one/);
    expect(() => policy({ rules: [{ action: 'allow', host: 'a.com', cidr: '8.8.8.0/24' }] })).toThrow(/exactly one/);
  });

  test('wildcards that would match nothing are refused with a reason', () => {
    expect(() => policy({ rules: [{ action: 'deny', host: '*.*.com' }] })).toThrow(/a wildcard is only/);
    expect(() => policy({ rules: [{ action: 'deny', host: 'api.*' }] })).toThrow(/wildcard/);
    expect(policy({ rules: [{ action: 'deny', host: '*' }] }).rules).toHaveLength(1);
  });

  test('an IPv4-mapped range is the IPv4 range it stands for; one too short to convert is refused', () => {
    const p = policy({ rules: [{ action: 'deny', cidr: '::ffff:203.0.113.0/120' }] });
    expect(evaluateEgress(p, tool, https('x.example'), ['203.0.113.7']).allowed).toBe(false);
    expect(evaluateEgress(p, tool, https('x.example'), ['::ffff:203.0.113.7']).allowed).toBe(false);
    expect(() => policy({ rules: [{ action: 'deny', cidr: '::ffff:0:0/90' }] })).toThrow(/address range/);
  });

  test('the number of tool and role entries is bounded', () => {
    const many = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`t${i}`, { rules: [] }]));
    expect(() => policy({ tools: many })).toThrow(/At most 200 tool entries/);
    expect(() => policy({ roles: many })).toThrow(/At most 200 role entries/);
  });

  test('malformed hosts and ranges are refused', () => {
    expect(() => policy({ rules: [{ action: 'deny', host: 'user@evil.com' }] })).toThrow();
    expect(() => policy({ rules: [{ action: 'deny', host: '*.8.8.8.8' }] })).toThrow();
    expect(() => policy({ rules: [{ action: 'deny', cidr: '8.8.8.0/33' }] })).toThrow();
    expect(() => policy({ rules: [{ action: 'deny', cidr: 'nope/8' }] })).toThrow();
  });

  test('the default policy is inactive: an install without one behaves as before', () => {
    expect(egressPolicyActive(policy({}))).toBe(false);
    expect(egressPolicyActive(policy({ default: 'deny' }))).toBe(true);
    expect(egressPolicyActive(policy({ tools: { shell: { rules: [{ action: 'deny', host: 'a.com' }] } } }))).toBe(true);
    expect(egressPolicyActive(policy({ requireEnforcement: true }))).toBe(true);
  });
});

describe('evaluateEgress', () => {
  const denyByDefault = policy({
    default: 'deny',
    rules: [
      { action: 'allow', host: 'api.example.com' },
      { action: 'allow', host: '*.docs.example.com', ports: [443], schemes: ['https'] },
      { action: 'deny', host: 'secret.docs.example.com', note: 'internal docs' },
    ],
  });

  test('exact and suffix matches allow; anything else gets the default', () => {
    expect(evaluateEgress(denyByDefault, tool, https('api.example.com'), ['93.184.216.34']).allowed).toBe(true);
    expect(evaluateEgress(denyByDefault, tool, https('v2.docs.example.com'), ['93.184.216.34']).allowed).toBe(true);
    // The suffix rule covers subdomains, not the apex nor a look-alike.
    expect(evaluateEgress(denyByDefault, tool, https('docs.example.com'), ['93.184.216.34']).allowed).toBe(false);
    expect(evaluateEgress(denyByDefault, tool, https('evildocs.example.com'), ['93.184.216.34']).allowed).toBe(false);
    expect(evaluateEgress(denyByDefault, tool, https('api.example.com.evil.net'), ['93.184.216.34']).allowed).toBe(false);
    const other = evaluateEgress(denyByDefault, tool, https('other.net'), ['93.184.216.34']);
    expect(other).toMatchObject({ allowed: false, rule: 'default (deny)' });
  });

  test('deny wins over allow, and the refusal names the rule', () => {
    const d = evaluateEgress(denyByDefault, tool, https('secret.docs.example.com'), ['93.184.216.34']);
    expect(d.allowed).toBe(false);
    expect(d.rule).toContain('global rule 3 (deny secret.docs.example.com)');
    expect(d.rule).toContain('internal docs');
  });

  test('ports and schemes narrow a rule', () => {
    expect(evaluateEgress(denyByDefault, tool, https('v2.docs.example.com', 8443), ['93.184.216.34']).allowed).toBe(false);
    expect(evaluateEgress(denyByDefault, tool, http('v2.docs.example.com', 443), ['93.184.216.34']).allowed).toBe(false);
  });

  test('case, trailing dots, IDN and percent-escapes cannot dodge a deny', () => {
    const p = policy({ rules: [{ action: 'deny', host: 'evil.com' }, { action: 'deny', host: '*.bücher.example' }] });
    for (const host of ['EVIL.com', 'evil.com.', 'evil.com...', 'ev%69l.com', 'evil。com']) {
      const d = evaluateEgress(p, tool, https(host), ['93.184.216.34']);
      expect(d.allowed, host).toBe(false);
    }
    expect(evaluateEgress(p, tool, https('shop.xn--bcher-kva.example'), ['93.184.216.34']).allowed).toBe(false);
    expect(evaluateEgress(p, tool, https('shop.BÜCHER.example'), ['93.184.216.34']).allowed).toBe(false);
  });

  test('a deny by address catches a name that resolves into it (no DNS-name bypass)', () => {
    const p = policy({ rules: [{ action: 'deny', cidr: '93.184.216.0/24', note: 'that provider' }] });
    expect(evaluateEgress(p, tool, https('innocent.example'), ['1.1.1.1', '93.184.216.34']).allowed).toBe(false);
    expect(evaluateEgress(p, tool, https('innocent.example'), ['1.1.1.1']).allowed).toBe(true);
    // A host rule naming an IP is an address rule too.
    const q = policy({ rules: [{ action: 'deny', host: '93.184.216.34' }] });
    expect(evaluateEgress(q, tool, https('rebound.example'), ['93.184.216.34']).allowed).toBe(false);
  });

  test('every spelling of an address literal is judged as that address', () => {
    const p = policy({ rules: [{ action: 'deny', host: '8.8.8.8' }, { action: 'deny', cidr: '2001:4860::/32' }] });
    for (const host of ['8.8.8.8', '0x08080808', '134744072', '8.8.8.8.', '::ffff:8.8.8.8', '[::ffff:808:808]']) {
      expect(evaluateEgress(p, tool, https(host)).allowed, host).toBe(false);
    }
    for (const host of ['2001:4860:4860::8888', '[2001:4860:4860:0:0:0:0:8888]', '2001:4860:4860:0000:0000:0000:0000:8888']) {
      expect(evaluateEgress(p, tool, https(host)).allowed, host).toBe(false);
    }
  });

  test('an allow by address must cover every resolved address', () => {
    const p = policy({ default: 'deny', rules: [{ action: 'allow', cidr: '93.184.216.0/24' }] });
    expect(evaluateEgress(p, tool, https('a.example'), ['93.184.216.34']).allowed).toBe(true);
    expect(evaluateEgress(p, tool, https('a.example'), ['93.184.216.34', '1.1.1.1']).allowed).toBe(false);
    expect(evaluateEgress(p, tool, https('a.example'), []).allowed).toBe(false);
  });

  test('a name check before resolution: final when no address rule applies (a denied name is never resolved)', () => {
    expect(evaluateEgress(denyByDefault, tool, https('secret.docs.example.com')).allowed).toBe(false);
    // Deny default, no name allow, no address rule: refused on the name alone.
    expect(evaluateEgress(denyByDefault, tool, https('other.net'))).toMatchObject({ allowed: false, rule: 'default (deny)' });
    expect(evaluateEgress(denyByDefault, tool, https('api.example.com'))).toMatchObject({ allowed: true });
    expect(evaluateEgress(denyByDefault, tool, https('api.example.com')).provisional).toBeUndefined();
  });

  test('a name check is provisional only where an address could still change the answer', () => {
    const p = policy({ default: 'deny', rules: [{ action: 'allow', host: 'good.com' }, { action: 'deny', cidr: '203.0.113.0/24' }] });
    // An allowed name may still resolve into the denied range.
    expect(evaluateEgress(p, tool, https('good.com'))).toMatchObject({ allowed: true, provisional: true });
    // Nothing could allow an unlisted name: refused before resolution.
    expect(evaluateEgress(p, tool, https('evil.com'))).toMatchObject({ allowed: false, rule: 'default (deny)' });
    // With an address allow, an unlisted name could still be allowed by where it resolves.
    const q = policy({ default: 'deny', rules: [{ action: 'allow', cidr: '93.184.216.0/24' }] });
    expect(evaluateEgress(q, tool, https('x.example'))).toMatchObject({ allowed: true, provisional: true });
    expect(evaluateEgress(q, tool, https('x.example'), ['1.1.1.1']).allowed).toBe(false);
  });

  test('"*" is every host', () => {
    const p = policy({ rules: [{ action: 'deny', host: '*' }, { action: 'allow', host: 'never.example' }] });
    expect(evaluateEgress(p, tool, https('evil.com'), ['1.1.1.1']).allowed).toBe(false);
    expect(evaluateEgress(p, tool, https('1.1.1.1')).allowed).toBe(false);
    const q = policy({ default: 'deny', rules: [{ action: 'allow', host: '*', ports: [443] }] });
    expect(evaluateEgress(q, tool, https('any.example'), ['1.1.1.1']).allowed).toBe(true);
    expect(evaluateEgress(q, tool, http('any.example'), ['1.1.1.1']).allowed).toBe(false);
  });

  test('6to4 and IPv4-compatible addresses are judged as their IPv4', () => {
    const p = policy({ rules: [{ action: 'deny', cidr: '8.8.8.0/24' }] });
    expect(evaluateEgress(p, tool, https('2002:808:808::1')).allowed).toBe(false);
    expect(evaluateEgress(p, tool, https('::8.8.8.8')).allowed).toBe(false);
    expect(evaluateEgress(p, tool, https('name.example'), ['2002:808:801::']).allowed).toBe(false);
    expect(canonicalAddress('::1')).toBe('::1');
  });

  test('tool and role rules add to the global ones; the tool default wins over the role default', () => {
    const p = policy({
      default: 'allow',
      rules: [{ action: 'deny', host: 'blocked.example' }],
      tools: { shell: { default: 'deny', rules: [{ action: 'allow', host: 'registry.npmjs.org' }] } },
      roles: { research: { default: 'allow', rules: [{ action: 'deny', host: '*.social.example' }] }, coding: { default: 'deny' } },
    });
    const addr = ['93.184.216.34'];
    expect(evaluateEgress(p, { tool: 'shell' }, https('registry.npmjs.org'), addr).allowed).toBe(true);
    expect(evaluateEgress(p, { tool: 'shell' }, https('pypi.org'), addr)).toMatchObject({ allowed: false, rule: 'tool shell default (deny)' });
    expect(evaluateEgress(p, { tool: 'shell', role: 'research' }, https('pypi.org'), addr).allowed).toBe(false);
    expect(evaluateEgress(p, { tool: 'websearch', role: 'research' }, https('x.social.example'), addr).allowed).toBe(false);
    expect(evaluateEgress(p, { tool: 'websearch', role: 'coding' }, https('pypi.org'), addr)).toMatchObject({ allowed: false, rule: 'role coding default (deny)' });
    // A global deny wins over a tool allow.
    const q = policy({ rules: [{ action: 'deny', host: 'x.example' }], tools: { shell: { rules: [{ action: 'allow', host: 'x.example' }] } } });
    expect(evaluateEgress(q, { tool: 'shell' }, https('x.example'), addr).allowed).toBe(false);
  });

  test('malformed hosts and ports are refused', () => {
    const p = policy({});
    expect(evaluateEgress(p, tool, https('user@host')).allowed).toBe(false);
    expect(evaluateEgress(p, tool, https('example.com', 0)).allowed).toBe(false);
    expect(evaluateEgress(p, tool, https('example.com'), ['not-an-ip']).allowed).toBe(false);
  });
});

describe('egressTargetOf', () => {
  test('userinfo in a URL is not the host', () => {
    expect(egressTargetOf('https://allowed.example@evil.example/x')).toEqual({ host: 'evil.example', port: 443, scheme: 'https' });
    expect(egressTargetOf('http://allowed.example:pw@evil.example:8080/')).toEqual({ host: 'evil.example', port: 8080, scheme: 'http' });
  });
  test('other schemes are not judged here', () => {
    expect(egressTargetOf('file:///etc/passwd')).toBeNull();
    expect(egressTargetOf('not a url')).toBeNull();
  });
});

describe('redirectChainOf', () => {
  test('lists a navigation first to last', () => {
    const a = { url: () => 'https://a.example/', redirectedFrom: () => null };
    const b = { url: () => 'https://b.example/', redirectedFrom: () => a };
    const c = { url: () => 'https://c.example/', redirectedFrom: () => b };
    expect(redirectChainOf(c)).toEqual(['https://a.example/', 'https://b.example/', 'https://c.example/']);
    expect(redirectChainOf(null)).toEqual([]);
  });
});
