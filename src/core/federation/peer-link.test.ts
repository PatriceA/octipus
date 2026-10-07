/**
 * The peer link end to end (docs/plans/federation-spec.md §5, §11 items 2,
 * 3 and the send-queue cap of 8): a real `/federation` endpoint on
 * 127.0.0.1, dialled through the guarded dialer or by a hand-rolled client
 * that deviates from the protocol one field at a time.
 *
 * Two installs in one process: two identities built from fresh keys, the
 * host's endpoint on a random port, `federation.lanCidrs = 127.0.0.1/32`.
 * Backed by ephemeral PGlite (the blocked-instance check reads
 * `federation_instances`) and the embedded key-value store (nonces).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { App, listen, type RunningServer } from '@/api/http';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

type Identity = import('./identity').InstanceIdentity;
type Mods = {
  identity: typeof import('./identity');
  host: typeof import('./host-server');
  dialer: typeof import('./dialer');
  seal: typeof import('./seal');
  link: typeof import('./link');
  protocol: typeof import('./protocol');
  visitor: typeof import('./visitor-client');
  mode: typeof import('./mode');
  config: typeof import('@/config');
};

let m: Mods;
let server: RunningServer;
let url: string;
let hostId: Identity;
let visitorId: Identity;
const LAN = ['127.0.0.1/32'];

// biome-ignore lint/suspicious/noExplicitAny: raw rows
async function q(sql: string, params: unknown[] = []): Promise<any[]> {
  const { queryRaw } = await import('@/db/postgres');
  return (await queryRaw(sql, params)).rows;
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-fed-link-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { initializeStorage } = await import('@/db/storage');
  initializeStorage({ mode: 'embedded' });

  m = {
    identity: await import('./identity'),
    host: await import('./host-server'),
    dialer: await import('./dialer'),
    seal: await import('./seal'),
    link: await import('./link'),
    protocol: await import('./protocol'),
    visitor: await import('./visitor-client'),
    mode: await import('./mode'),
    config: await import('@/config'),
  };
  const cfg = m.config.getConfig();
  cfg.federation.mode = 'both';
  cfg.federation.lanCidrs = LAN;

  hostId = m.identity.identityFromPrivateKeyPem(m.identity.generateIdentityPem());
  visitorId = m.identity.identityFromPrivateKeyPem(m.identity.generateIdentityPem());

  const app = new App();
  // biome-ignore lint/suspicious/noExplicitAny: the route builder type the server passes
  m.host.setupFederationWebSocket(app as any, { identity: async () => hostId });
  server = listen(app, { hostname: '127.0.0.1', port: 0 });
  await until(() => server.port !== 0);
  url =`ws://127.0.0.1:${server.port}/federation`;
});

beforeEach(() => {
  const cfg = m.config.getConfig();
  cfg.federation.mode = 'both';
  cfg.federation.lanCidrs = LAN;
  cfg.federation.heartbeatSeconds = 15;
  cfg.security.trustedProxies = [];
  m.host._resetFederationHostForTests();
});

afterAll(async () => {
  m.host._resetFederationHostForTests();
  server.stop();
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

function dial(target = url, pin = hostId.instanceId, extra: Partial<import('./dialer').DialPeerOptions> = {}) {
  return m.dialer.dialPeer(target, pin, { identity: visitorId, lanCidrs: LAN, onRequest: async () => ({}), ...extra });
}

async function dialRefusal(p: Promise<unknown>): Promise<import('./dialer').DialError> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(m.dialer.DialError);
  return err as import('./dialer').DialError;
}

const until = async (cond: () => boolean, ms = 3000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 10));
  }
};

interface RawClient {
  ws: WebSocket;
  hostHello: import('./protocol').HostHello;
  closed: Promise<{ code: number; reason: string }>;
  messages: string[];
}

/** Open a socket and wait for the host's hello, without answering it. */
async function rawConnect(target = url, headers: Record<string, string> = {}): Promise<RawClient> {
  const ws = new WebSocket(target, { headers });
  const messages: string[] = [];
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
  const first = new Promise<string>((resolve, reject) => {
    ws.once('message', (d) => resolve(d.toString()));
    ws.once('close', (code) => reject(new Error(`closed before hello: ${code}`)));
  });
  ws.on('message', (d) => messages.push(d.toString()));
  const frame = JSON.parse(await first);
  return { ws, hostHello: frame.body, closed, messages };
}

interface HelloOverrides {
  identity?: Identity;
  protocol?: number;
  ts?: number;
  nonceB?: string;
  /** Sign over this host ephemeral key instead of the one received. */
  signedHostEph?: string;
  /** Sign with this key instead of the identity's own (a bad signature). */
  signer?: Identity;
}

/** Answer the host hello as a visitor would, with one field bent. */
async function rawHandshake(o: HelloOverrides = {}): Promise<RawClient & { channel?: import('./seal').SealedChannel; nonceB: string }> {
  const client = await rawConnect();
  const who = o.identity ?? visitorId;
  const eph = m.seal.generateEphemeral();
  const nonceB = o.nonceB ?? randomBytes(32).toString('base64');
  const ts = o.ts ?? Date.now();
  const fields = {
    protocol: o.protocol ?? 1, nonceA: client.hostHello.nonce, nonceB, hostId: client.hostHello.instanceId, visitorId: who.instanceId,
    hostEph: o.signedHostEph ?? client.hostHello.eph, visitorEph: eph.publicRawB64, ts,
    hostAppVersion: client.hostHello.appVersion, visitorAppVersion: 'test',
  };
  const welcome = new Promise<string | null>((resolve) => {
    client.ws.once('message', (d) => resolve(d.toString()));
    client.ws.once('close', () => resolve(null));
  });
  client.ws.send(JSON.stringify({
    v: 1,
    type: 'hello',
    body: {
      protocol: o.protocol ?? 1, instanceId: who.instanceId, publicKey: who.publicKeySpkiB64, nonce: nonceB, ts,
      eph: eph.publicRawB64, appVersion: 'test', sig: (o.signer ?? who).sign(m.seal.handshakeTranscript('visitor', fields)).toString('base64'),
    },
  }));
  const w = await welcome;
  if (!w) return { ...client, nonceB };
  const sig = Buffer.from(JSON.parse(w).body.sig, 'base64');
  expect(m.identity.verifyEd25519(client.hostHello.publicKey, m.seal.handshakeTranscript('host', fields), sig)).toBe(true);
  const channel = new m.seal.SealedChannel(m.seal.deriveLinkKeys(eph.privateKey, client.hostHello.eph, fields), 'visitor');
  return { ...client, channel, nonceB };
}

/** Wait for the next sealed result on a raw client and open it. */
function nextResult(client: RawClient, channel: import('./seal').SealedChannel): Promise<{ re: string; ok: boolean; body?: unknown; error?: { code: string } }> {
  return new Promise((resolve) => {
    client.ws.once('message', (d) => resolve(JSON.parse(channel.open(JSON.parse(d.toString())).toString())));
  });
}

const sealed = (channel: import('./seal').SealedChannel, msg: unknown) => JSON.stringify(channel.seal(Buffer.from(JSON.stringify(msg))));

describe('handshake', () => {
  test('mutual authentication seals a link both ways; no instance row is written', async () => {
    const link = await dial();
    expect(link.peerInstanceId).toBe(hostId.instanceId);
    expect(await link.request('ping', {})).toEqual({});

    await until(() => m.host.inboundLink(visitorId.instanceId) !== undefined);
    const inbound = m.host.inboundLink(visitorId.instanceId)!;
    expect(inbound.peerInstanceId).toBe(visitorId.instanceId);
    expect(await inbound.request('ping', {})).toEqual({});

    // An instance that joined nothing here (no row) may only ask space.join:
    // anything else is `not_found` (FI1); a known operation with a
    // malformed body is `bad_request` before that.
    await expect(link.request('no.such.thing', {})).rejects.toMatchObject({ code: 'not_found' });
    await expect(link.request('space.info', { spaceId: randomUUID() })).rejects.toMatchObject({ code: 'not_found' });
    await expect(link.request('space.info', {})).rejects.toMatchObject({ code: 'bad_request' });
    // A malformed body of a known type: `bad_request`, link stays up.
    await expect(link.request('ping', { extra: 1 })).rejects.toMatchObject({ code: 'bad_request' });
    expect(link.closed).toBe(false);
    expect(await q('SELECT * FROM federation_instances')).toEqual([]);

    // Once a join wrote its row, the same link gets past the gate: an
    // unknown type is now `unsupported`.
    await q(`INSERT INTO federation_instances (instance_id, public_key) VALUES ($1, $2)`, [visitorId.instanceId, visitorId.publicKeySpkiB64]);
    try {
      await expect(link.request('no.such.thing', {})).rejects.toMatchObject({ code: 'unsupported' });
      expect(m.host._federationHostBudgetsForTests().unknownLinks).toBe(0);
    } finally {
      await q('DELETE FROM federation_instances');
    }
    link.close(m.protocol.CLOSE.normal, 'done');
    await until(() => m.host.inboundLink(visitorId.instanceId) === undefined);
  });

  test('a second link from the same install replaces the first', async () => {
    const first = await dial();
    const second = await dial();
    await until(() => first.closed);
    expect(first.closeInfo?.code).toBe(m.protocol.CLOSE.normal);
    expect(await second.request('ping', {})).toEqual({});
    second.close(4000, 'done');
  });

  test('a wrong pin is refused by the visitor (4401)', async () => {
    const other = m.identity.identityFromPrivateKeyPem(m.identity.generateIdentityPem());
    const err = await dialRefusal(dial(url, other.instanceId));
    expect(err.closeCode).toBe(m.protocol.CLOSE.auth);
    expect(err.message).toMatch(/fingerprint/);
  });

  test('a replayed visitor nonce is refused (4401)', async () => {
    const ok = await rawHandshake();
    expect(ok.channel).toBeDefined();
    ok.ws.close();
    const replay = await rawHandshake({ nonceB: ok.nonceB });
    expect(replay.channel).toBeUndefined();
    expect(await replay.closed).toEqual({ code: 4401, reason: 'nonce replayed' });
  });

  test('a visitor nonce is recorded only once its signature verified', async () => {
    // A hello with a bad signature does not burn its nonce...
    const nonceB = randomBytes(32).toString('base64');
    const impostor = m.identity.identityFromPrivateKeyPem(m.identity.generateIdentityPem());
    const forged = await rawHandshake({ nonceB, signer: impostor });
    expect(await forged.closed).toEqual({ code: 4401, reason: 'bad signature' });
    // ...so the real visitor can still use it, once.
    const real = await rawHandshake({ nonceB });
    expect(real.channel).toBeDefined();
    real.ws.close();
    const again = await rawHandshake({ nonceB });
    expect(await again.closed).toEqual({ code: 4401, reason: 'nonce replayed' });
  });

  test('a handshake frame over 4 KiB is refused before it is parsed (4401)', async () => {
    const c = await rawConnect();
    c.ws.send(`{"v":1,"type":"hello","body":{"pad":"${'x'.repeat(5000)}"}}`);
    expect(await c.closed).toEqual({ code: 4401, reason: 'handshake frame too large' });
  });

  test('a failure while opening the socket closes it (1011) instead of leaving it half open', async () => {
    m.config.getConfig().security.trustedProxies = ['not-an-address'];
    const ws = new WebSocket(url);
    const closed = await new Promise<{ code: number; reason: string }>((resolve) => {
      ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    expect(closed).toEqual({ code: 1011, reason: 'internal error' });
    expect(m.host._federationHostBudgetsForTests().pendingTotal).toBe(0);
  });

  test('a stale timestamp is refused (4401)', async () => {
    for (const skew of [-61_000, 61_000]) {
      const c = await rawHandshake({ ts: Date.now() + skew });
      expect(await c.closed).toEqual({ code: 4401, reason: 'stale timestamp' });
    }
  });

  test('a protocol mismatch is refused (4409), either side', async () => {
    const c = await rawHandshake({ protocol: 2 });
    expect((await c.closed).code).toBe(m.protocol.CLOSE.protocol);

    // A host speaking another version: the dialer refuses it.
    const http = createServer();
    const wss = new WebSocketServer({ server: http });
    wss.on('connection', (ws) => {
      ws.send(JSON.stringify({ v: 1, type: 'hello', body: { protocol: 2 } }));
    });
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    const err = await dialRefusal(dial(`ws://127.0.0.1:${(http.address() as AddressInfo).port}/federation`));
    expect(err.closeCode).toBe(m.protocol.CLOSE.protocol);
    wss.close();
    await new Promise((r) => http.close(r));
  });

  test('a signature by another key is refused (4401)', async () => {
    const impostor = m.identity.identityFromPrivateKeyPem(m.identity.generateIdentityPem());
    const client = await rawConnect();
    const eph = m.seal.generateEphemeral();
    const nonceB = randomBytes(32).toString('base64');
    const ts = Date.now();
    const sig = impostor.sign(m.seal.handshakeTranscript('visitor', {
      protocol: 1, nonceA: client.hostHello.nonce, nonceB, hostId: hostId.instanceId, visitorId: visitorId.instanceId,
      hostEph: client.hostHello.eph, visitorEph: eph.publicRawB64, ts, hostAppVersion: client.hostHello.appVersion, visitorAppVersion: 'test',
    }));
    client.ws.send(JSON.stringify({ v: 1, type: 'hello', body: {
      protocol: 1, instanceId: visitorId.instanceId, publicKey: visitorId.publicKeySpkiB64, nonce: nonceB, ts,
      eph: eph.publicRawB64, appVersion: 'test', sig: sig.toString('base64'),
    } }));
    expect(await client.closed).toEqual({ code: 4401, reason: 'bad signature' });
  });

  test('a blocked instance is refused (4403)', async () => {
    await q(`INSERT INTO federation_instances (instance_id, public_key, status, blocked_at) VALUES ($1, $2, 'blocked', now())`,
      [visitorId.instanceId, visitorId.publicKeySpkiB64]);
    try {
      const err = await dialRefusal(dial());
      expect(err.closeCode).toBe(m.protocol.CLOSE.forbidden);
      expect(err.message).toMatch(/blocked/);
      // An active row is no obstacle.
      await q(`UPDATE federation_instances SET status = 'active', blocked_at = NULL WHERE instance_id = $1`, [visitorId.instanceId]);
      const link = await dial();
      link.close(4000, 'done');
    } finally {
      await q('DELETE FROM federation_instances');
    }
  });

  test('mode off: refused after the upgrade, and turning it off closes open links (4403)', async () => {
    const link = await dial();
    await until(() => m.host.inboundLink(visitorId.instanceId) !== undefined);

    const cfg = m.config.getConfig();
    cfg.federation.mode = 'visit';
    m.mode.emitFederationModeChanged('visit', 'both', (err) => { throw err; });
    await until(() => link.closed);
    expect(link.closeInfo?.code).toBe(m.protocol.CLOSE.forbidden);
    expect(m.host.inboundLink(visitorId.instanceId)).toBeUndefined();

    const err = await dialRefusal(dial());
    expect(err.closeCode).toBe(m.protocol.CLOSE.forbidden);
    expect(err.message).toMatch(/federation off/);
  });

  test('the handshake must finish within 5 seconds (4401)', async () => {
    const c = await rawConnect();
    const started = Date.now();
    expect(await c.closed).toEqual({ code: 4401, reason: 'handshake timeout' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(4000);
  }, 10_000);

  test('a relay that swaps the ephemeral keys cannot complete the handshake', async () => {
    // B dials the relay believing it is A (the pin is A's real id); the relay
    // forwards to A but substitutes its own X25519 keys both ways so it could
    // read the link. Both signatures cover the ephemeral keys, so A refuses.
    let hostClose: { code: number; reason: string } | null = null;
    const http = createServer();
    const wss = new WebSocketServer({ server: http });
    wss.on('connection', (fromVisitor) => {
      const toHost = new WebSocket(url);
      const towardsVisitor = m.seal.generateEphemeral();
      const towardsHost = m.seal.generateEphemeral();
      toHost.on('message', (d) => {
        const f = JSON.parse(d.toString());
        if (f.type === 'hello') f.body.eph = towardsVisitor.publicRawB64;
        fromVisitor.send(JSON.stringify(f));
      });
      fromVisitor.on('message', (d) => {
        const f = JSON.parse(d.toString());
        if (f.type === 'hello') f.body.eph = towardsHost.publicRawB64;
        toHost.send(JSON.stringify(f));
      });
      toHost.on('close', (code, reason) => {
        hostClose = { code, reason: reason.toString() };
        fromVisitor.close(code, reason.toString());
      });
    });
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    const relayUrl = `ws://127.0.0.1:${(http.address() as AddressInfo).port}/federation`;
    const err = await dialRefusal(dial(relayUrl));
    expect(err.closeCode).toBe(m.protocol.CLOSE.auth);
    await until(() => hostClose !== null);
    expect(hostClose).toEqual({ code: 4401, reason: 'bad signature' });
    expect(m.host.inboundLink(visitorId.instanceId)).toBeUndefined();
    wss.close();
    await new Promise((r) => http.close(r));
  });
});

describe('sealed frames', () => {
  test('a sealed request is answered; tampered, replayed and reordered frames close the link (4401)', async () => {
    // Answered.
    const a = await rawHandshake();
    const ch = a.channel!;
    const answer = nextResult(a, ch);
    a.ws.send(sealed(ch, { id: 'r1', type: 'ping', body: {} }));
    expect(await answer).toMatchObject({ re: 'r1', ok: true, body: {} });

    // Tampered.
    const frame = ch.seal(Buffer.from(JSON.stringify({ id: 'r2', type: 'ping', body: {} })));
    const c = Buffer.from(frame.c, 'base64');
    c[c.length - 1] ^= 0x80;
    a.ws.send(JSON.stringify({ ...frame, c: c.toString('base64') }));
    expect(await a.closed).toEqual({ code: 4401, reason: 'sealed frame failed authentication' });

    // Replayed.
    const b = await rawHandshake();
    const wire = sealed(b.channel!, { id: 'r1', type: 'ping', body: {} });
    const first = nextResult(b, b.channel!);
    b.ws.send(wire);
    await first;
    b.ws.send(wire);
    expect(await b.closed).toEqual({ code: 4401, reason: 'out-of-order frame: expected 1, got 0' });

    // Reordered.
    const r = await rawHandshake();
    const f0 = sealed(r.channel!, { id: 'r1', type: 'ping', body: {} });
    const f1 = sealed(r.channel!, { id: 'r2', type: 'ping', body: {} });
    r.ws.send(f1);
    r.ws.send(f0);
    expect(await r.closed).toEqual({ code: 4401, reason: 'out-of-order frame: expected 0, got 1' });

    // Plain JSON after the handshake is no frame either.
    const p = await rawHandshake();
    p.ws.send(JSON.stringify({ v: 1, type: 'hello', body: {} }));
    expect((await p.closed).code).toBe(4401);
  });

  test('an event from the visitor is refused (only hosts send events)', async () => {
    const a = await rawHandshake();
    a.ws.send(sealed(a.channel!, { id: 'e1', type: 'event', as: 'x', conn: 'y', body: {} }));
    expect(await a.closed).toEqual({ code: 4401, reason: 'unexpected event' });
  });

  test('more than 60 frames in a second close the link (4429)', async () => {
    const a = await rawHandshake();
    for (let i = 0; i < 61; i++) a.ws.send(sealed(a.channel!, { id: `p${i}`, type: 'ping', body: {} }));
    expect(await a.closed).toEqual({ code: 4429, reason: 'frame rate exceeded' });
  });

  test('a visitor that stops reading is cut off once the send queue passes 4 MiB (4429)', async () => {
    const a = await rawHandshake();
    await until(() => m.host.inboundLink(visitorId.instanceId) !== undefined);
    const inbound = m.host.inboundLink(visitorId.instanceId)!;
    // Stop reading: the kernel buffers fill, then `ws`, then the link's queue.
    (a.ws as unknown as { _socket: { pause(): void } })._socket.pause();
    const chunk = 'x'.repeat(200_000);
    let maxQueued = 0;
    for (let i = 0; i < 2000 && !inbound.closed; i++) {
      inbound.sendEvent('~anna@abcd1234', 'c1', { chunk });
      maxQueued = Math.max(maxQueued, inbound.queuedBytes());
      if (i % 10 === 0) await new Promise((r) => setImmediate(r));
    }
    expect(inbound.closed).toBe(true);
    expect(inbound.closeInfo).toEqual({ code: 4429, reason: 'send queue full' });
    expect(maxQueued).toBeLessThanOrEqual(m.link.sendQueueCap(m.config.getConfig().gateway.maxFrameBytes));
    expect(m.host.inboundLink(visitorId.instanceId)).toBeUndefined();
  }, 30_000);

  test('three missed heartbeats close the link', async () => {
    m.config.getConfig().federation.heartbeatSeconds = 0.05;
    const a = await rawHandshake(); // never answers the host's pings
    await until(() => m.host.inboundLink(visitorId.instanceId) !== undefined);
    const inbound = m.host.inboundLink(visitorId.instanceId)!;
    await until(() => inbound.closed, 3000);
    expect(inbound.closeInfo).toEqual({ code: 4000, reason: 'heartbeat timeout' });
    a.ws.close();
  });

  test('an answered heartbeat keeps the link up', async () => {
    m.config.getConfig().federation.heartbeatSeconds = 0.05;
    const link = await dial(url, hostId.instanceId, { heartbeatSeconds: 0.05 });
    await new Promise((r) => setTimeout(r, 400));
    expect(link.closed).toBe(false);
    expect(m.host.inboundLink(visitorId.instanceId)?.closed).toBe(false);
    link.close(4000, 'done');
  });
});

describe('per-address bounds on the endpoint', () => {
  test('at most 10 links per address before the handshake (4429)', async () => {
    const pending: RawClient[] = [];
    for (let i = 0; i < 10; i++) pending.push(await rawConnect());
    const eleventh = new WebSocket(url);
    const closed = await new Promise<{ code: number; reason: string }>((resolve) => {
      eleventh.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    expect(closed).toEqual({ code: 4429, reason: 'too many pending handshakes' });
    for (const p of pending) p.ws.close();
  });

  test('at most 30 handshakes per address per minute (4429)', async () => {
    for (let i = 0; i < 30; i++) {
      const c = await rawConnect();
      c.ws.close();
      await c.closed;
    }
    const over = new WebSocket(url);
    const closed = await new Promise<{ code: number; reason: string }>((resolve) => {
      over.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    expect(closed).toEqual({ code: 4429, reason: 'handshake rate exceeded' });
  });

  test('plain ws:// from outside federation.lanCidrs is refused (4403)', async () => {
    m.config.getConfig().federation.lanCidrs = ['10.0.0.0/8'];
    const ws = new WebSocket(url);
    const closed = await new Promise<{ code: number; reason: string }>((resolve) => {
      ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    expect(closed).toEqual({ code: 4403, reason: 'wss required outside federation.lanCidrs' });
  });

  test('at most so many sockets before the handshake on the whole install (4429)', async () => {
    m.host._setFederationHostLimitsForTests({ pendingTotal: 2 });
    const a = await rawConnect();
    const b = await rawConnect();
    expect(await closeOf(url)).toEqual({ code: 4429, reason: 'too many pending handshakes on this install' });
    a.ws.close();
    b.ws.close();
  });

  test('sealed links are bounded per address and in all, not counting the link a reconnect replaces (4429)', async () => {
    const other = m.identity.identityFromPrivateKeyPem(m.identity.generateIdentityPem());
    for (const over of [{ openLinksPerIp: 1 }, { openLinks: 1 }]) {
      m.host._resetFederationHostForTests();
      m.host._setFederationHostLimitsForTests(over);
      const first = await dial();
      const err = await dialRefusal(dial(url, hostId.instanceId, { identity: other }));
      expect(err.closeCode, JSON.stringify(over)).toBe(4429);
      expect(err.message).toMatch(/too many federation links/);
      // The same install reconnecting replaces its link: allowed.
      const again = await dial();
      await until(() => first.closed);
      again.close(4000, 'done');
    }
  });

  test('links from instances that joined nothing here are bounded; a row lifts the bound (4429)', async () => {
    const other = m.identity.identityFromPrivateKeyPem(m.identity.generateIdentityPem());
    m.host._setFederationHostLimitsForTests({ unknownLinks: 1 });
    const first = await dial();
    const err = await dialRefusal(dial(url, hostId.instanceId, { identity: other }));
    expect(err.closeCode).toBe(4429);
    expect(err.message).toMatch(/joined nothing here/);
    await q(`INSERT INTO federation_instances (instance_id, public_key) VALUES ($1, $2)`, [other.instanceId, other.publicKeySpkiB64]);
    try {
      const known = await dial(url, hostId.instanceId, { identity: other });
      expect(await known.request('ping', {})).toEqual({});
      known.close(4000, 'done');
    } finally {
      await q('DELETE FROM federation_instances');
    }
    first.close(4000, 'done');
  });

  test('the budgets are swept: quiet addresses drop out, pending sockets are recounted', async () => {
    const done = await rawConnect();
    done.ws.close();
    await done.closed;
    const pending = await rawConnect();
    let budgets = m.host._federationHostBudgetsForTests();
    expect(budgets.handshakes.get('127.0.0.1')).toHaveLength(2);
    expect(budgets.pending.get('127.0.0.1')).toBe(1);
    m.host.sweepFederationHostBudgets(Date.now() + 61_000);
    budgets = m.host._federationHostBudgetsForTests();
    expect(budgets.handshakes.size).toBe(0);
    expect(budgets.pending.get('127.0.0.1')).toBe(1);
    expect(budgets.pendingTotal).toBe(1);
    pending.ws.close();
    await pending.closed;
    m.host.sweepFederationHostBudgets();
    expect(m.host._federationHostBudgetsForTests().pending.size).toBe(0);
  });

  test('IPv6 addresses are counted per /64', () => {
    const bucket = m.host.addressBucket;
    expect(bucket('2001:db8:1:2::5')).toBe(bucket('2001:db8:1:2:ffff:ffff:ffff:1'));
    expect(bucket('2001:db8:1:2::5')).toBe('2001:db8:1:2::/64');
    expect(bucket('2001:db8:1:3::5')).not.toBe(bucket('2001:db8:1:2::5'));
    expect(bucket('203.0.113.9')).toBe('203.0.113.9');
  });

  test('behind a trusted proxy: the rightmost X-Forwarded-Proto decides, and the proxy itself is no LAN client', async () => {
    const cfg = m.config.getConfig();
    cfg.security.trustedProxies = ['127.0.0.1'];
    cfg.federation.lanCidrs = ['10.0.0.0/8'];
    // The proxy appends its own value last; a client-written https before it counts for nothing.
    const ok = await rawConnect(url, { 'x-forwarded-proto': 'http, https' });
    ok.ws.close();
    expect(await closeOf(url, { 'x-forwarded-proto': 'https, http' })).toEqual({ code: 4403, reason: 'wss required outside federation.lanCidrs' });

    // The proxy is inside lanCidrs but names no client: no plain ws:// for it.
    cfg.federation.lanCidrs = ['127.0.0.1/32', '10.0.0.0/8'];
    expect(await closeOf(url)).toEqual({ code: 4403, reason: 'wss required outside federation.lanCidrs' });
    // A LAN client the proxy names may use plain ws://.
    const lan = await rawConnect(url, { 'x-forwarded-for': '10.1.2.3' });
    lan.ws.close();
  });

  test('an IPv4-mapped literal in federation.lanCidrs admits the IPv4 peer, both ends', async () => {
    const mapped = ['::ffff:127.0.0.1'];
    m.config.getConfig().federation.lanCidrs = mapped;
    const link = await dial(url, hostId.instanceId, { lanCidrs: mapped });
    expect(await link.request('ping', {})).toEqual({});
    link.close(4000, 'done');
  });

  test('registered while not hosting: refused with 4403, and turning hosting on applies without a restart', async () => {
    const cfg = m.config.getConfig();
    cfg.federation.mode = 'visit';
    const app = new App();
    // biome-ignore lint/suspicious/noExplicitAny: the route builder type the server passes
    m.host.setupFederationWebSocket(app as any, { identity: async () => hostId });
    const second = listen(app, { hostname: '127.0.0.1', port: 0 });
    try {
      await until(() => second.port !== 0);
      const url2 = `ws://127.0.0.1:${second.port}/federation`;
      expect(await closeOf(url2)).toEqual({ code: 4403, reason: 'federation off' });
      cfg.federation.mode = 'both';
      m.mode.emitFederationModeChanged('both', 'visit', (err) => { throw err; });
      const link = await dial(url2);
      expect(await link.request('ping', {})).toEqual({});
      link.close(4000, 'done');
    } finally {
      second.stop();
    }
  });
});

/** Connect and wait for the host to close the socket. */
function closeOf(target: string, headers: Record<string, string> = {}): Promise<{ code: number; reason: string }> {
  const ws = new WebSocket(target, { headers });
  return new Promise((resolve) => {
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

describe('the dialer against a live host', () => {
  test('the connection is pinned to the address checked once', async () => {
    let lookups = 0;
    // A resolver that would rebind to a private address on a second lookup.
    const resolve = async () => (lookups++ === 0 ? ['127.0.0.1'] : ['10.9.9.9']);
    const link = await dial(`ws://peer.invalid:${server.port}/federation`, hostId.instanceId, { resolve });
    expect(lookups).toBe(1);
    expect(await link.request('ping', {})).toEqual({});
    link.close(4000, 'done');
  });

  test('loopback without federation.lanCidrs is refused before any socket opens', async () => {
    const err = await dialRefusal(dial(url, hostId.instanceId, { lanCidrs: [] }));
    expect(err.code).toBe('address_refused');
  });
});

describe('the visitor link pool', () => {
  const host = () => ({ instanceId: hostId.instanceId, url });

  test('opens on demand, shares one link, and delivers host events to subscribers', async () => {
    const pool = new m.visitor.VisitorLinkPool({ identity: async () => visitorId, dial: { lanCidrs: LAN } });
    const [a, b] = await Promise.all([pool.request(host(), 'ping', {}), pool.request(host(), 'ping', {})]);
    expect(a).toEqual({});
    expect(b).toEqual({});
    expect(pool.state(hostId.instanceId)).toBe('up');

    const events: unknown[] = [];
    const off = pool.subscribe(hostId.instanceId, (e) => events.push(e));
    const inbound = m.host.inboundLink(visitorId.instanceId)!;
    inbound.sendEvent('~anna@abcd1234', 'conn-1', { type: 'room.message', roomId: 'r' });
    await until(() => events.length === 1);
    expect(events[0]).toMatchObject({ type: 'event', as: '~anna@abcd1234', conn: 'conn-1', body: { type: 'room.message' } });
    off();
    pool.closeAll(4000, 'done');
  });

  test('a retained host is redialled after a drop; released, it is not', async () => {
    const states: string[] = [];
    const pool = new m.visitor.VisitorLinkPool({
      identity: async () => visitorId,
      dial: { lanCidrs: LAN },
      reconnect: { baseMs: 20, maxMs: 100 },
      onLinkState: (_id, s) => states.push(s),
    });
    const release = pool.retain(host());
    await until(() => pool.state(hostId.instanceId) === 'up');
    m.host.inboundLink(visitorId.instanceId)!.close(4000, 'host restart');
    await until(() => states.length >= 3);
    expect(states.slice(0, 3)).toEqual(['up', 'down', 'up']);
    expect(await pool.request(host(), 'ping', {})).toEqual({});

    release();
    m.host.inboundLink(visitorId.instanceId)!.close(4000, 'host restart');
    await until(() => pool.state(hostId.instanceId) === 'down');
    await new Promise((r) => setTimeout(r, 200));
    expect(pool.state(hostId.instanceId)).toBe('down');
  });

  test('visiting off: requests are refused', async () => {
    m.config.getConfig().federation.mode = 'host';
    const pool = new m.visitor.VisitorLinkPool({ identity: async () => visitorId, dial: { lanCidrs: LAN } });
    await expect(pool.request(host(), 'ping', {})).rejects.toMatchObject({ code: 'federation_off' });
  });

  test('turning visiting off closes the pool\'s links (4403)', async () => {
    const pool = new m.visitor.VisitorLinkPool({ identity: async () => visitorId, dial: { lanCidrs: LAN } });
    const open = await pool.link(host());
    m.config.getConfig().federation.mode = 'host';
    m.mode.emitFederationModeChanged('host', 'both', (err) => { throw err; });
    await until(() => open.closed);
    expect(open.closeInfo?.code).toBe(4403);
    pool.dispose();
  });

  const pool = (extra: Partial<import('./visitor-client').VisitorLinkPoolOptions> = {}) =>
    new m.visitor.VisitorLinkPool({ identity: async () => visitorId, dial: { lanCidrs: LAN }, reconnect: { baseMs: 20, maxMs: 100 }, ...extra });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test('closeAll keeps the retainers counted: releasing afterwards never goes negative', async () => {
    const p = pool();
    const release = p.retain(host());
    await until(() => p.state(hostId.instanceId) === 'up');
    p.closeAll(4000, 'done');
    expect(p.retainerCount(hostId.instanceId)).toBe(1);
    release();
    release();
    expect(p.retainerCount(hostId.instanceId)).toBe(0);
    p.dispose();
  });

  test('visiting off then on: the links close, then every retained host is redialled', async () => {
    const p = pool();
    const release = p.retain(host());
    await until(() => p.state(hostId.instanceId) === 'up');
    const cfg = m.config.getConfig();
    cfg.federation.mode = 'host';
    m.mode.emitFederationModeChanged('host', 'both', (err) => { throw err; });
    await until(() => p.state(hostId.instanceId) === 'down');
    await sleep(150);
    expect(p.state(hostId.instanceId)).toBe('down');
    expect(p.retainerCount(hostId.instanceId)).toBe(1);

    cfg.federation.mode = 'both';
    m.mode.emitFederationModeChanged('both', 'host', (err) => { throw err; });
    await until(() => p.state(hostId.instanceId) === 'up');
    release();
    p.dispose();
  });

  test('a dial that completes after closeAll is closed instead of handed out', async () => {
    const p = pool();
    const pending = p.link(host());
    p.closeAll(4000, 'stop');
    await expect(pending).rejects.toMatchObject({ code: 'federation_off' });
    expect(p.state(hostId.instanceId)).toBe('down');
    await until(() => m.host.inboundLink(visitorId.instanceId) === undefined);
    // An explicit request afterwards dials again.
    expect(await p.request(host(), 'ping', {})).toEqual({});
    p.dispose();
  });

  test('a host that refuses with 4403 is not redialled until asked again', async () => {
    const states: string[] = [];
    const p = pool({ onLinkState: (_id, s) => states.push(s) });
    const release = p.retain(host());
    await until(() => p.state(hostId.instanceId) === 'up');
    // The host stops hosting (this install still visits): its links close with 4403.
    const cfg = m.config.getConfig();
    cfg.federation.mode = 'visit';
    m.mode.emitFederationModeChanged('visit', 'both', (err) => { throw err; });
    await until(() => p.state(hostId.instanceId) === 'down');
    cfg.federation.mode = 'both';
    m.mode.emitFederationModeChanged('both', 'visit', (err) => { throw err; });
    await sleep(200);
    expect(states).toEqual(['up', 'down']);
    expect(p.state(hostId.instanceId)).toBe('down');
    // The next explicit request tries again.
    expect(await p.request(host(), 'ping', {})).toEqual({});
    expect(p.state(hostId.instanceId)).toBe('up');
    release();
    p.dispose();
  });

  test('the backoff starts over only after a link stayed up long enough', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: the entry's private backoff counter
    const attempt = (p: any) => p.entries.get(hostId.instanceId).attempt as number;
    // Each drop's backoff counter, read right after the pool handled the drop
    // (the redial can bring the link back before a poll would see it down).
    const run = async (stableMs: number): Promise<number[]> => {
      const seen: number[] = [];
      let ups = 0;
      const p: import('./visitor-client').VisitorLinkPool = pool({
        reconnect: { baseMs: 10, maxMs: 40, stableMs },
        onLinkState: (_id, s) => {
          if (s === 'up') ups++;
          else queueMicrotask(() => seen.push(attempt(p)));
        },
      });
      const release = p.retain(host());
      for (let i = 1; i <= 2; i++) {
        await until(() => ups === i);
        m.host.inboundLink(visitorId.instanceId)!.close(4000, 'drop');
        await until(() => seen.length === i);
      }
      await until(() => ups === 3);
      release();
      p.dispose();
      return seen.slice(0, 2);
    };
    // Dropped right after coming up: the backoff keeps growing.
    expect(await run(60_000)).toEqual([1, 2]);
    // Up long enough (here: at once): every drop starts over.
    expect(await run(0)).toEqual([0, 0]);
  });

  test('backoff grows to the cap with jitter', () => {
    expect(m.visitor.reconnectDelay(0, () => 0)).toBe(500);
    expect(m.visitor.reconnectDelay(0, () => 1)).toBe(1000);
    expect(m.visitor.reconnectDelay(3, () => 1)).toBe(8000);
    expect(m.visitor.reconnectDelay(10, () => 1)).toBe(60_000);
    expect(m.visitor.reconnectDelay(10, () => 0)).toBe(30_000);
  });
});

describe('host request handlers', () => {
  test('a type registers once', () => {
    expect(() => m.host.registerHostHandler('ping', async () => ({}))).toThrow(/already registered/);
  });
});
