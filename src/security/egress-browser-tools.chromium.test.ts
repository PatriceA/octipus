/**
 * The browser tools under an active egress policy, with a real headless
 * Chromium through the egress proxy: `browser` open/navigate/evaluate,
 * `websearch` fetch_page and `visual`'s capture.
 *
 * - An allowed page loads (behind the proxy `serverAddr()` is the proxy's own
 *   127.0.0.1, which must not read as a private-address refusal).
 * - A redirect to a denied host is refused before the host is contacted.
 * - WebRTC cannot send UDP around the proxy.
 * - A context opened for one tool/role is not reused by another.
 *
 * Playwright's own browser download is not assumed: the test launches the
 * headless shell found under /opt/pw-browsers (or PLAYWRIGHT_BROWSERS_PATH)
 * and skips when there is none.
 */
import dns from 'node:dns';
import { createSocket } from 'node:dgram';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { egressPolicySchema } from '@/shared/egress-policy';
import { installedChromium } from '@/test-helpers/chromium';

/** An installed headless Chromium shell (Playwright's own download is not assumed), or ''. */
const EXECUTABLE = installedChromium();

const state = vi.hoisted(() => ({ policy: undefined as unknown, executable: '' }));
state.executable = EXECUTABLE;

vi.mock('playwright', async (orig) => {
  const real = await orig<typeof import('playwright')>();
  const chromium = Object.create(real.chromium) as typeof real.chromium;
  chromium.launch = (options = {}) => real.chromium.launch({ ...options, executablePath: state.executable });
  return { ...real, chromium, default: { ...real, chromium } };
});
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
vi.mock('@/db/repositories/audit-repository', () => ({ auditRepository: { log: async () => {} } }));
vi.mock('@/security/permissions', () => ({ getPermissionManager: () => ({ check: async () => ({ level: 'ALLOW', source: 'policy' }) }) }));
vi.mock('@/security/approval-route', () => ({ routeApprovalFor: async () => ({ route: 'execute', source: 'policy' }) }));
vi.mock('@/core/action-recovery', async (orig) => ({ ...(await orig<typeof import('@/core/action-recovery')>()), actionRecovery: { run: async (_c: unknown, _t: unknown, _n: unknown, _a: unknown, run: () => Promise<unknown>) => run() } }));
// The proxy may reach the local test server standing in for `*.test` hosts.
vi.mock('@/security/egress-proxy', async (orig) => {
  const real = await orig<typeof import('@/security/egress-proxy')>();
  return {
    ...real,
    startEgressProxy: (options: import('@/security/egress-proxy').EgressProxyOptions) => real.startEgressProxy({
      ...options, allowPrivateAddresses: true,
      resolve: async (host: string) => { if (host.endsWith('.test')) return ['127.0.0.1']; throw new Error(`test resolver: unknown host ${host}`); },
    }),
  };
});

const { BrowserTool } = await import('@/tools/browser');
const { WebSearchTool } = await import('@/tools/websearch');
const { VisualTool } = await import('@/tools/visual');
const { sharedChromium } = await import('@/tools/browser/shared-chromium');
const { withEgressSubject } = await import('./egress-policy');

const ctx = (role: string) => ({ id: `agent-${role}`, userId: 'u1', sessionId: 's1', role, status: 'running' }) as never;
type Handler = { name: string; execute(args: Record<string, unknown>, c: never): Promise<unknown> };
const pick = (handlers: Handler[], name: string) => handlers.find((h) => h.name === name || h.name.endsWith(`__${name}`))!;

describe.skipIf(!EXECUTABLE)('browser tools through the egress proxy (real Chromium)', () => {
  let server: Server;
  let port = 0;
  const hits: string[] = [];
  const udp = createSocket('udp4');
  let udpPort = 0;
  let udpHits = 0;
  let browser: { handlers: Handler[] };

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(`${req.headers.host?.split(':')[0]}${req.url}`);
      if (req.url === '/to-denied') { res.writeHead(302, { location: `http://denied.test:${port}/secret` }).end(); return; }
      res.setHeader('content-type', 'text/html');
      res.end('<html><head><title>Allowed page</title></head><body><main>allowed body text that is long enough to be read as content by the page extractor, not a bot wall.</main></body></html>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as { port: number }).port;
    udp.on('message', () => { udpHits++; });
    await new Promise<void>((r) => udp.bind(0, '127.0.0.1', () => r()));
    udpPort = udp.address().port;
    const tool = new BrowserTool();
    await tool.initialize();
    browser = { handlers: tool.getToolHandlers() as unknown as Handler[] };
  });
  afterAll(async () => {
    await sharedChromium.close();
    udp.close();
    await new Promise<void>((r) => server.close(() => r()));
  });
  beforeEach(() => {
    state.policy = egressPolicySchema.parse({ default: 'deny', rules: [{ action: 'allow', host: 'good.test' }] });
    hits.length = 0;
    vi.spyOn(dns.promises, 'resolve4').mockImplementation(async () => ['93.184.216.34']);
    vi.spyOn(dns.promises, 'resolve6').mockRejectedValue(new Error('no AAAA'));
  });

  test('browser: an allowed page loads; a redirect to a denied host is refused before it is contacted', async () => {
    const open = pick(browser.handlers, 'open');
    const page = await open.execute({ url: `http://good.test:${port}/page` }, ctx('research')) as Record<string, unknown>;
    expect(page.error).toBeUndefined();
    expect(page.title).toBe('Allowed page');
    expect(hits).toEqual(['good.test/page']);
    hits.length = 0;
    await expect(open.execute({ url: `http://good.test:${port}/to-denied` }, ctx('research'))).rejects.toThrow(/refused by the egress proxy/);
    expect(hits).toEqual(['good.test/to-denied']);
    // navigate on the open page behaves the same.
    const navigate = pick(browser.handlers, 'navigate');
    await expect(navigate.execute({ pageId: page.pageId, url: `http://good.test:${port}/again` }, ctx('research'))).resolves.toMatchObject({ title: 'Allowed page' });
  }, 60_000);

  test('browser: WebRTC cannot send UDP around the proxy', async () => {
    const stun = `(async () => {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${udpPort}' }] });
      pc.createDataChannel('x');
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise((r) => setTimeout(r, 2500));
      pc.close();
      return 'ran';
    })()`;
    // Control: the same page through the same kind of proxy, in a Chromium
    // launched WITHOUT the hardening arguments, does leak a STUN packet —
    // so a zero below is the arguments' doing, not a test that cannot see.
    const { chromium } = await import('playwright');
    const { browserEgressFor } = await import('./browser-egress');
    const egress = await browserEgressFor({ tool: 'browser', role: 'research', userId: 'u1' });
    const bare = await chromium.launch({ headless: true });
    try {
      const page = await (await bare.newContext({ proxy: egress!.proxy })).newPage();
      await page.goto(`http://good.test:${port}/page`);
      udpHits = 0;
      expect(await page.evaluate(stun)).toBe('ran');
      expect(udpHits).toBeGreaterThan(0);
    } finally { await bare.close(); egress?.close(); }

    const opened = await pick(browser.handlers, 'open').execute({ url: `http://good.test:${port}/page` }, ctx('research')) as Record<string, unknown>;
    expect(opened.pageId).toBeTruthy();
    udpHits = 0;
    const result = await pick(browser.handlers, 'evaluate').execute({ pageId: opened.pageId, script: stun }, ctx('research'));
    expect(JSON.stringify(result)).toContain('ran');
    expect(udpHits).toBe(0);
  }, 60_000);

  test('browser: a context opened for one role is not reused by another', async () => {
    const open = pick(browser.handlers, 'open');
    await expect(open.execute({ url: `http://good.test:${port}/page`, contextId: 'shared-ctx' }, ctx('research'))).resolves.toMatchObject({ title: 'Allowed page' });
    await expect(open.execute({ url: `http://good.test:${port}/page`, contextId: 'shared-ctx' }, ctx('coding'))).rejects.toThrow(/opened by another tool or agent role/);
  }, 60_000);

  test('websearch fetch_page: allowed loads, a denied redirect is refused', async () => {
    const tool = new WebSearchTool();
    await tool.initialize();
    const fetchPage = pick(tool.getToolHandlers() as unknown as Handler[], 'fetch_page');
    const ok = await fetchPage.execute({ url: `http://good.test:${port}/page` }, ctx('research')) as Record<string, unknown>;
    expect(ok.error).toBeUndefined();
    expect(String(ok.text)).toContain('allowed body text');
    hits.length = 0;
    await expect(fetchPage.execute({ url: `http://good.test:${port}/to-denied` }, ctx('research'))).rejects.toThrow(/refused by the egress proxy/);
    expect(hits).toEqual(['good.test/to-denied']);
  }, 60_000);

  test('visual: allowed captures, a denied redirect is refused', async () => {
    const tool = new VisualTool() as unknown as { captureUrls(urls: Array<{ url: string }>, b: string): Promise<{ shots: unknown[] }> };
    const run = (url: string) => withEgressSubject({ tool: 'visual', role: 'research', userId: 'u1' }, () => tool.captureUrls([{ url }], 'chromium'));
    await expect(run(`http://good.test:${port}/page`)).resolves.toMatchObject({ backend: 'playwright' });
    hits.length = 0;
    await expect(run(`http://good.test:${port}/to-denied`)).rejects.toThrow(/refused by the egress proxy/);
    expect(hits).toEqual(['good.test/to-denied']);
  }, 60_000);
});
