/**
 * Link sealing primitives (docs/plans/federation-spec.md §5.3): the
 * transcript encoding and the per-direction AEAD with sequence numbers.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { deriveLinkKeys, generateEphemeral, type HandshakeFields, handshakeTranscript, SealError, SealedChannel, transcript } from './seal';

function fieldsFor(hostEph: string, visitorEph: string, over: Partial<HandshakeFields> = {}): HandshakeFields {
  return {
    protocol: 1,
    nonceA: randomBytes(32).toString('base64'),
    nonceB: randomBytes(32).toString('base64'),
    hostId: 'a'.repeat(26),
    visitorId: 'b'.repeat(26),
    hostEph,
    visitorEph,
    ts: 1_790_000_000_000,
    hostAppVersion: '1.0.0',
    visitorAppVersion: '1.0.0',
    ...over,
  };
}

/** Both ends of one link; `visitorView` changes what the visitor believes the handshake was. */
function pair(visitorView: Partial<HandshakeFields> = {}) {
  const host = generateEphemeral();
  const visitor = generateEphemeral();
  const f = fieldsFor(host.publicRawB64, visitor.publicRawB64);
  return {
    host: new SealedChannel(deriveLinkKeys(host.privateKey, visitor.publicRawB64, f), 'host'),
    visitor: new SealedChannel(deriveLinkKeys(visitor.privateKey, host.publicRawB64, { ...f, ...visitorView }), 'visitor'),
  };
}

describe('transcript', () => {
  test('is length-prefixed, so shifting a boundary changes the bytes', () => {
    expect(transcript(['ab', 'c']).equals(transcript(['a', 'bc']))).toBe(false);
    expect(transcript(['a|b']).equals(transcript(['a', 'b']))).toBe(false);
    expect(transcript(['x', 1]).toString('hex')).toBe('0000000178' + '0000000131');
  });
});

describe('SealedChannel', () => {
  test('both ends derive the same keys and open each other in order', () => {
    const { host, visitor } = pair();
    for (let i = 0; i < 3; i++) {
      const frame = visitor.seal(Buffer.from(`v${i}`));
      expect(frame.s).toBe(i);
      expect(host.open(frame).toString()).toBe(`v${i}`);
      expect(visitor.open(host.seal(Buffer.from(`h${i}`))).toString()).toBe(`h${i}`);
    }
  });

  test('a tampered, replayed, reordered or reflected frame fails', () => {
    const { host, visitor } = pair();
    const f0 = visitor.seal(Buffer.from('zero'));
    const f1 = visitor.seal(Buffer.from('one'));

    const bytes = Buffer.from(f0.c, 'base64');
    bytes[0] ^= 1;
    expect(() => host.open({ ...f0, c: bytes.toString('base64') })).toThrow(SealError);
    // Relabelling the sequence number breaks the tag too (it is in the AAD).
    expect(() => host.open({ ...f1, s: 0 })).toThrow(SealError);
    expect(() => host.open(f1)).toThrow(/out-of-order/);
    expect(host.open(f0).toString()).toBe('zero');
    expect(() => host.open(f0)).toThrow(/out-of-order/);
    expect(host.open(f1).toString()).toBe('one');

    // A frame the visitor sealed, bounced back at it, does not open: the
    // directions use different keys.
    const f2 = visitor.seal(Buffer.from('two'));
    const fresh = pair();
    expect(() => fresh.visitor.open({ ...f2, s: 0 })).toThrow(SealError);
  });

  test('a different nonce pair derives different keys', () => {
    const { host, visitor } = pair({ nonceB: randomBytes(32).toString('base64') });
    expect(() => host.open(visitor.seal(Buffer.from('x')))).toThrow(SealError);
  });

  test('the keys are bound to the whole transcript: protocol, ids, ts and app versions', () => {
    for (const view of [{ protocol: 2 }, { hostId: 'c'.repeat(26) }, { ts: 1 }, { hostAppVersion: '0.9.0' }, { visitorAppVersion: '9' }]) {
      const { host, visitor } = pair(view);
      expect(() => host.open(visitor.seal(Buffer.from('x'))), JSON.stringify(view)).toThrow(SealError);
    }
  });

  test('the signed transcript covers the protocol and both app versions', () => {
    const f = fieldsFor('x', 'y');
    for (const over of [{ protocol: 2 }, { hostAppVersion: '2' }, { visitorAppVersion: '2' }]) {
      expect(handshakeTranscript('visitor', f).equals(handshakeTranscript('visitor', { ...f, ...over }))).toBe(false);
    }
    expect(handshakeTranscript('visitor', f).equals(handshakeTranscript('host', f))).toBe(false);
  });

  test('the AEAD nonce is the sequence number: no nonce on the wire, distinct ciphertexts per frame', () => {
    const { host, visitor } = pair();
    const f0 = visitor.seal(Buffer.from('same'));
    const f1 = visitor.seal(Buffer.from('same'));
    expect(Object.keys(f0).sort()).toEqual(['c', 's', 'v']);
    expect(f0.c).not.toBe(f1.c);
    expect(host.open(f0).toString()).toBe('same');
    expect(host.open(f1).toString()).toBe('same');
  });

  test('refuses a degenerate peer key', () => {
    const own = generateEphemeral();
    expect(() => deriveLinkKeys(own.privateKey, Buffer.alloc(32).toString('base64'), fieldsFor('x', 'y'))).toThrow();
  });
});
