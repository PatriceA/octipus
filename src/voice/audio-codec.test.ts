import { describe, test, expect } from 'bun:test';
import {
  resamplePcm16,
  StreamingResampler,
  FrameAccumulator,
  muLawEncode,
  muLawDecode,
  muLawEncodeSample,
  muLawDecodeSample,
} from './audio-codec';

function sine(samples: number, freq: number, rate: number): Int16Array {
  const out = new Int16Array(samples);
  for (let i = 0; i < samples; i++) out[i] = Math.round(16000 * Math.sin((2 * Math.PI * freq * i) / rate));
  return out;
}

describe('resamplePcm16', () => {
  test('downsample 48k→16k yields ~1/3 the samples', () => {
    const input = sine(3000, 440, 48000);
    const out = resamplePcm16(input, 48000, 16000);
    expect(out.length).toBeGreaterThanOrEqual(999);
    expect(out.length).toBeLessThanOrEqual(1001);
  });

  test('identical rates return an equal but independent copy (no aliasing)', () => {
    const input = sine(100, 200, 16000);
    const out = resamplePcm16(input, 16000, 16000);
    expect(out).not.toBe(input); // must not alias the caller's buffer
    expect(Array.from(out)).toEqual(Array.from(input));
    out[0] = 999; // mutating the result must not touch the source
    expect(input[0]).not.toBe(999);
  });

  test('resampling a constant signal preserves the value (no drift)', () => {
    const input = new Int16Array(600).fill(1234);
    const out = resamplePcm16(input, 48000, 16000);
    for (const v of out) expect(v).toBe(1234);
  });

  test('rejects invalid rates', () => {
    expect(() => resamplePcm16(sine(10, 1, 16000), 0, 16000)).toThrow();
  });
});

describe('StreamingResampler continuity', () => {
  test('streamed in arbitrary frames ≈ one-shot resample', () => {
    const input = sine(4800, 300, 48000);
    const oneShot = resamplePcm16(input, 48000, 16000);

    const rs = new StreamingResampler(48000, 16000);
    const pieces: number[] = [];
    // Feed in uneven frames (7, 13, 101, …) to prove frame size doesn't matter.
    let i = 0;
    for (const len of [7, 13, 101, 512, 900, 1000, 2267]) {
      const frame = input.subarray(i, i + len);
      i += len;
      for (const s of rs.push(frame)) pieces.push(s);
    }

    // Same length within one sample, and interior samples match closely (linear
    // interp at frame joins is continuous, so no clicks/offsets).
    expect(Math.abs(pieces.length - oneShot.length)).toBeLessThanOrEqual(1);
    const n = Math.min(pieces.length, oneShot.length);
    let maxDiff = 0;
    for (let k = 0; k < n; k++) maxDiff = Math.max(maxDiff, Math.abs(pieces[k] - oneShot[k]));
    expect(maxDiff).toBeLessThanOrEqual(1); // rounding only
  });
});

describe('FrameAccumulator', () => {
  test('emits no window until the threshold, then a full one', () => {
    const acc = new FrameAccumulator(100);
    expect(acc.push(new Uint8Array(40))).toEqual([]);
    expect(acc.push(new Uint8Array(40))).toEqual([]);
    const wins = acc.push(new Uint8Array(40)); // 120 ≥ 100
    expect(wins.length).toBe(1);
    expect(wins[0].length).toBe(100); // fixed-size window
    // 20 bytes remainder retained → not yet another window.
    expect(acc.push(new Uint8Array(10))).toEqual([]);
  });

  test('drains multiple windows from one oversized push (honors window size)', () => {
    const acc = new FrameAccumulator(100);
    const wins = acc.push(new Uint8Array(250)); // 2 full windows + 50 remainder
    expect(wins.map((w) => w.length)).toEqual([100, 100]);
    expect(acc.flush()!.length).toBe(50);
  });

  test('preserves byte order across frames', () => {
    const acc = new FrameAccumulator(4);
    acc.push(Uint8Array.from([1, 2]));
    const wins = acc.push(Uint8Array.from([3, 4]));
    expect(wins.length).toBe(1);
    expect(Array.from(wins[0])).toEqual([1, 2, 3, 4]);
  });

  test('flush() drains the trailing partial window', () => {
    const acc = new FrameAccumulator(1000);
    acc.push(new Uint8Array(30));
    expect(acc.flush()!.length).toBe(30);
    expect(acc.flush()).toBeNull();
  });
});

describe('μ-law codec (G.711)', () => {
  test('decode∘encode is exact for every byte except the −0 codeword', () => {
    // G.711 μ-law has two zero codewords: 0xFF (+0) and 0x7F (−0). Both decode to
    // 0 and encode normalizes to +0 (0xFF), so 0x7F is the one legitimate
    // non-round-trip. Every other byte is a fixed point — this pins the codec.
    for (let b = 0; b < 256; b++) {
      const expected = b === 0x7f ? 0xff : b;
      expect(muLawEncodeSample(muLawDecodeSample(b))).toBe(expected);
    }
  });

  test('encodes silence and full-scale to the canonical codewords', () => {
    expect(muLawEncodeSample(0)).toBe(0xff); // +0 → 0xFF
    expect(muLawDecodeSample(0xff)).toBe(0); // and back to ~0
    // Sign bit distinguishes +/−.
    expect(muLawEncodeSample(1000) & 0x80).toBe(0x80);
    expect(muLawEncodeSample(-1000) & 0x80).toBe(0);
  });

  test('round-trips PCM within μ-law quantization error', () => {
    const pcm = sine(400, 300, 8000);
    const back = muLawDecode(muLawEncode(pcm));
    expect(back.length).toBe(pcm.length);
    // μ-law is lossy but bounded; near-silence stays small, loud stays loud sign.
    for (let i = 0; i < pcm.length; i++) {
      // Same sign (or both ~zero) and magnitude in the right ballpark.
      if (Math.abs(pcm[i]) > 2000) {
        expect(Math.sign(back[i])).toBe(Math.sign(pcm[i]));
        expect(Math.abs(back[i] - pcm[i])).toBeLessThan(Math.abs(pcm[i]) * 0.15 + 256);
      }
    }
  });

  test('buffer helpers preserve length', () => {
    const pcm = sine(160, 440, 8000); // 20 ms @ 8 kHz
    const encoded = muLawEncode(pcm);
    expect(encoded.length).toBe(160);
    expect(muLawDecode(encoded).length).toBe(160);
  });
});
