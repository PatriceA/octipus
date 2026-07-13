import { describe, test, expect } from 'bun:test';
import { mintMediaStreamToken, consumeMediaStreamToken } from './voice-media-ws';

describe('media stream token store', () => {
  test('a minted token validates exactly once (single-use)', () => {
    const tok = mintMediaStreamToken('CA_abc');
    expect(consumeMediaStreamToken(tok)).toBe(true);
    expect(consumeMediaStreamToken(tok)).toBe(false); // replay rejected
  });

  test('unknown / null tokens are rejected', () => {
    expect(consumeMediaStreamToken('never-minted')).toBe(false);
    expect(consumeMediaStreamToken(null)).toBe(false);
    expect(consumeMediaStreamToken('')).toBe(false);
  });

  test('distinct calls mint distinct tokens', () => {
    const a = mintMediaStreamToken('CA_1');
    const b = mintMediaStreamToken('CA_2');
    expect(a).not.toBe(b);
    expect(consumeMediaStreamToken(a)).toBe(true);
    expect(consumeMediaStreamToken(b)).toBe(true);
  });
});
