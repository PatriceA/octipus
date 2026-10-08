/**
 * PeerLink bounds that need no network (docs/plans/federation-spec.md §5.2,
 * §5.4): the send-queue cap scales with the frame cap, and a peer's
 * requests in flight are bounded (the excess is answered `busy`).
 *
 * Two links joined by an in-memory socket pair under real sealing keys.
 */
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, test } from 'vitest';
import { LinkRequestError, type LinkSocket, MAX_IN_FLIGHT_REQUESTS, PeerLink, SEND_QUEUE_CAP_BYTES, sealedWireLimit, sendQueueCap } from './link';
import { CLOSE, closeReason } from './protocol';
import { deriveLinkKeys, generateEphemeral, type HandshakeFields, SealedChannel } from './seal';

function channels(): { host: SealedChannel; visitor: SealedChannel } {
  const h = generateEphemeral();
  const v = generateEphemeral();
  const f: HandshakeFields = {
    protocol: 1, nonceA: randomBytes(32).toString('base64'), nonceB: randomBytes(32).toString('base64'),
    hostId: 'a'.repeat(26), visitorId: 'b'.repeat(26), hostEph: h.publicRawB64, visitorEph: v.publicRawB64,
    ts: Date.now(), hostAppVersion: 't', visitorAppVersion: 't',
  };
  return {
    host: new SealedChannel(deriveLinkKeys(h.privateKey, v.publicRawB64, f), 'host'),
    visitor: new SealedChannel(deriveLinkKeys(v.privateKey, h.publicRawB64, f), 'visitor'),
  };
}

/** A socket that hands every frame to `deliver` on the next tick; `bufferedAmount` is settable. */
class MemorySocket implements LinkSocket {
  bufferedAmount = 0;
  closed: { code?: number; reason?: string } | null = null;
  deliver: (raw: string) => void = () => {};
  send(data: string, cb?: (err?: Error) => void): void {
    setImmediate(() => {
      this.deliver(data);
      cb?.();
    });
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
}

const links: PeerLink[] = [];
afterEach(() => {
  for (const l of links.splice(0)) l.close(CLOSE.normal, 'done');
});

function pair(opts: { maxFrameBytes?: number; onHostRequest?: (type: string) => Promise<unknown> } = {}) {
  const { host: hc, visitor: vc } = channels();
  const hs = new MemorySocket();
  const vs = new MemorySocket();
  const maxFrameBytes = opts.maxFrameBytes ?? 64 * 1024;
  const host = new PeerLink({
    socket: hs, channel: hc, role: 'host', peerInstanceId: 'b'.repeat(26), maxFrameBytes, heartbeatSeconds: 3600,
    onRequest: async (r) => (opts.onHostRequest ? opts.onHostRequest(r.type) : {}),
  });
  const visitor = new PeerLink({
    socket: vs, channel: vc, role: 'visitor', peerInstanceId: 'a'.repeat(26), maxFrameBytes, heartbeatSeconds: 3600,
    onRequest: async () => ({}), onEvent: () => {},
  });
  hs.deliver = (raw) => visitor.receive(raw);
  vs.deliver = (raw) => host.receive(raw);
  links.push(host, visitor);
  return { host, visitor, hs, vs };
}

describe('send-queue cap', () => {
  test('is 4 MiB, or two of the largest sealed frames when that is more', () => {
    expect(sendQueueCap(64 * 1024)).toBe(SEND_QUEUE_CAP_BYTES);
    const big = 4 * 1024 * 1024;
    expect(sendQueueCap(big)).toBe(2 * sealedWireLimit(big));
    expect(sendQueueCap(big)).toBeGreaterThan(SEND_QUEUE_CAP_BYTES);
  });

  test('one frame at a frame cap over 3 MiB is sent, not taken for a full queue', async () => {
    const maxFrameBytes = 4 * 1024 * 1024;
    const { host, visitor, hs } = pair({ maxFrameBytes });
    let got = 0;
    // biome-ignore lint/suspicious/noExplicitAny: reach the event hook for the count
    (visitor as any).opts.onEvent = () => { got++; };
    // A first frame goes straight to the socket, which then reports 2 MiB
    // still buffered: the big frame waits in the link's queue behind it.
    expect(host.sendEvent('~a@b', 'c', {})).toBe(true);
    hs.bufferedAmount = 2 * 1024 * 1024;
    expect(host.sendEvent('~a@b', 'c', { chunk: 'x'.repeat(maxFrameBytes - 200) })).toBe(true);
    expect(host.closed).toBe(false);
    expect(host.queuedBytes()).toBeGreaterThan(SEND_QUEUE_CAP_BYTES);
    // The socket drains; the first frame's write callback moves the queued one on.
    hs.bufferedAmount = 0;
    await new Promise((r) => setTimeout(r, 300));
    expect(host.closed).toBe(false);
    expect(got).toBe(2);
  });
});

describe('requests in flight', () => {
  test(`at most ${MAX_IN_FLIGHT_REQUESTS} are answered at once; the excess gets busy`, async () => {
    const gates: (() => void)[] = [];
    let running = 0;
    let maxRunning = 0;
    const { visitor } = pair({
      onHostRequest: () => new Promise((resolve) => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        gates.push(() => { running--; resolve({}); });
      }),
    });
    const n = MAX_IN_FLIGHT_REQUESTS + 5;
    const results = Array.from({ length: n }, () => visitor.request('ping', {}).then(() => 'ok', (e: LinkRequestError) => e.code));
    // Wait until the host holds the first batch, then release them.
    while (gates.length < MAX_IN_FLIGHT_REQUESTS) await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 20));
    expect(maxRunning).toBe(MAX_IN_FLIGHT_REQUESTS);
    for (const open of gates.splice(0)) open();
    const settled = await Promise.all(results);
    expect(settled.filter((r) => r === 'ok')).toHaveLength(MAX_IN_FLIGHT_REQUESTS);
    expect(settled.filter((r) => r === 'busy')).toHaveLength(5);
    // Room again once they finished.
    const later = visitor.request('ping', {});
    while (gates.length < 1) await new Promise((r) => setImmediate(r));
    gates.splice(0).forEach((open) => open());
    expect(await later).toEqual({});
  });
});

describe('close reasons', () => {
  test('are cut to 123 bytes of UTF-8 without splitting a character', () => {
    expect(closeReason('short')).toBe('short');
    const long = 'é'.repeat(100); // 200 bytes
    const cut = closeReason(long);
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(123);
    expect(cut).toBe('é'.repeat(61));
    expect(Buffer.byteLength(closeReason('x'.repeat(500)))).toBe(123);
  });

  test('a link closed with a long reason still closes its socket', () => {
    const { host, hs } = pair();
    host.close(CLOSE.auth, `bad: ${'é'.repeat(200)}`);
    expect(hs.closed?.code).toBe(CLOSE.auth);
    expect(Buffer.byteLength(hs.closed?.reason ?? '')).toBeLessThanOrEqual(123);
  });
});
