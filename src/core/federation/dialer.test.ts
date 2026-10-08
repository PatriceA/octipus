/**
 * The guarded dialer's refusals (docs/plans/federation-spec.md §5.1, FI6,
 * §11 item 3). The pinned dial itself is exercised against a real host in
 * `peer-link.test.ts`.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { WebSocketServer } from 'ws';
import { DialError, openGuardedSocket, vetDialTarget } from './dialer';

const LAN = ['127.0.0.1/32'];
const publicResolver = async () => ['93.184.216.34'];

async function refusal(p: Promise<unknown>): Promise<DialError> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(DialError);
  return err as DialError;
}

describe('vetDialTarget', () => {
  test('loopback is refused unless federation.lanCidrs names it', async () => {
    expect((await refusal(vetDialTarget('wss://127.0.0.1:4443/federation', { lanCidrs: [] }))).code).toBe('address_refused');
    expect((await refusal(vetDialTarget('ws://127.0.0.1:4443/federation', { lanCidrs: [] }))).code).toBe('address_refused');
    expect((await refusal(vetDialTarget('wss://[::1]:4443/federation', { lanCidrs: [] }))).code).toBe('address_refused');
    // A name that resolves to loopback is the same address.
    expect((await refusal(vetDialTarget('wss://peer.test/federation', { lanCidrs: [], resolve: async () => ['127.0.0.1'] }))).code).toBe('address_refused');
    expect(await vetDialTarget('ws://127.0.0.1:4443/federation', { lanCidrs: LAN })).toMatchObject({ address: '127.0.0.1' });
  });

  test('link-local, metadata, private and ambiguous addresses are refused', async () => {
    for (const url of [
      'wss://169.254.169.254/federation',
      'wss://10.1.2.3/federation',
      'wss://192.168.1.5/federation',
      'wss://[fe80::1]/federation',
      'wss://2130706433/federation',
      'wss://0x7f000001/federation',
    ]) {
      expect((await refusal(vetDialTarget(url, { lanCidrs: [] }))).code, url).toBe('address_refused');
    }
    // lanCidrs opens exactly the ranges it names.
    expect(await vetDialTarget('ws://192.168.1.5/federation', { lanCidrs: ['192.168.1.0/24'] })).toMatchObject({ address: '192.168.1.5' });
    expect((await refusal(vetDialTarget('ws://192.168.2.5/federation', { lanCidrs: ['192.168.1.0/24'] }))).code).toBe('address_refused');
  });

  test('an IPv4-mapped IPv6 literal is the IPv4 address it maps', async () => {
    // WHATWG URL parsing spells it `::ffff:7f00:1`.
    expect((await refusal(vetDialTarget('ws://[::ffff:127.0.0.1]:4443/federation', { lanCidrs: [] }))).code).toBe('address_refused');
    expect(await vetDialTarget('ws://[::ffff:127.0.0.1]:4443/federation', { lanCidrs: LAN })).toMatchObject({ address: '::ffff:7f00:1' });
    expect(await vetDialTarget('ws://127.0.0.1:4443/federation', { lanCidrs: ['::ffff:127.0.0.1'] })).toMatchObject({ address: '127.0.0.1' });
  });

  test('a name with any private address among its answers is refused', async () => {
    const resolve = async () => ['93.184.216.34', '10.0.0.7'];
    expect((await refusal(vetDialTarget('wss://peer.example/federation', { lanCidrs: [], resolve }))).code).toBe('address_refused');
  });

  test('ws:// to a public name is refused; wss:// to it is pinned to the checked address', async () => {
    expect((await refusal(vetDialTarget('ws://peer.example/federation', { lanCidrs: [], resolve: publicResolver }))).code).toBe('tls_required');
    expect((await refusal(vetDialTarget('ws://93.184.216.34/federation', { lanCidrs: [] }))).code).toBe('tls_required');
    const ok = await vetDialTarget('wss://peer.example/federation', { lanCidrs: [], resolve: publicResolver });
    expect(ok.address).toBe('93.184.216.34');
    expect(ok.url.hostname).toBe('peer.example');
  });

  test('other schemes, credentials and garbage are refused', async () => {
    for (const url of ['https://peer.example/federation', 'not a url', 'wss://u:p@peer.example/federation']) {
      expect((await refusal(vetDialTarget(url, { lanCidrs: [], resolve: publicResolver }))).code, url).toBe('bad_url');
    }
    expect((await refusal(vetDialTarget('wss://nowhere.example/federation', { lanCidrs: [], resolve: async () => [] }))).code).toBe('unresolvable');
  });
});

describe('openGuardedSocket follows no redirect', () => {
  let redirector: Server;
  let target: Server;
  let targetWss: WebSocketServer;
  let targetHits = 0;

  beforeAll(async () => {
    target = createServer();
    targetWss = new WebSocketServer({ server: target });
    targetWss.on('connection', () => { targetHits++; });
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
    const targetPort = (target.address() as AddressInfo).port;

    redirector = createServer();
    redirector.on('upgrade', (_req, socket) => {
      socket.end(`HTTP/1.1 302 Found\r\nLocation: ws://127.0.0.1:${targetPort}/federation\r\nContent-Length: 0\r\n\r\n`);
    });
    await new Promise<void>((r) => redirector.listen(0, '127.0.0.1', r));
  });

  afterAll(async () => {
    targetWss.close();
    await new Promise((r) => target.close(r));
    await new Promise((r) => redirector.close(r));
  });

  test('a 302 to the upgrade fails the dial and the redirect target is never reached', async () => {
    const port = (redirector.address() as AddressInfo).port;
    const err = await refusal(openGuardedSocket(`ws://127.0.0.1:${port}/federation`, { lanCidrs: LAN, maxPayload: 1 << 20 }));
    expect(err.code).toBe('connect_failed');
    expect(err.message).toMatch(/302/);
    expect(targetHits).toBe(0);
  });
});
