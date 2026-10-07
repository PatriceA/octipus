/**
 * Link sealing primitives (docs/plans/federation-spec.md §5.3): the
 * transcript encoding and the per-direction AEAD with sequence numbers.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { deriveLinkKeys, generateEphemeral, SealError, SealedChannel, transcript } from './seal';

function pair() {
  const host = generateEphemeral();
  const visitor = generateEphemeral();
  const nA = randomBytes(32).toString('base64');
  const nB = randomBytes(32).toString('base64');
  return {
    host: new SealedChannel(deriveLinkKeys(host.privateKey, visitor.publicRawB64, nA, nB), 'host'),
    visitor: new SealedChannel(deriveLinkKeys(visitor.privateKey, host.publicRawB64, nA, nB), 'visitor'),
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
    const host = generateEphemeral();
    const visitor = generateEphemeral();
    const nA = randomBytes(32).toString('base64');
    const a = new SealedChannel(deriveLinkKeys(host.privateKey, visitor.publicRawB64, nA, randomBytes(32).toString('base64')), 'host');
    const b = new SealedChannel(deriveLinkKeys(visitor.privateKey, host.publicRawB64, nA, randomBytes(32).toString('base64')), 'visitor');
    expect(() => a.open(b.seal(Buffer.from('x')))).toThrow(SealError);
  });

  test('refuses a degenerate peer key', () => {
    const own = generateEphemeral();
    expect(() => deriveLinkKeys(own.privateKey, Buffer.alloc(32).toString('base64'), 'AA==', 'AA==')).toThrow();
  });
});
