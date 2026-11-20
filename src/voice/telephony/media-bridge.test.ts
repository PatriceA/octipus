import { describe, expect, test } from 'vitest';
import { muLawDecode, muLawEncode } from '../audio-codec';
import { TELEPHONY_FRAME_BYTES, TelephonyOutboundEncoder, TelephonyInboundDecoder } from './media-bridge';

function sine(samples: number, freq: number, rate: number, amp = 12000): Int16Array {
  const out = new Int16Array(samples);
  for (let i = 0; i < samples; i++) out[i] = Math.round(amp * Math.sin((2 * Math.PI * freq * i) / rate));
  return out;
}

const bytesOf = (pcm: Int16Array) => new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);

function concat(frames: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
  let at = 0;
  for (const f of frames) { out.set(f, at); at += f.length; }
  return out;
}

function rms(samples: Int16Array): number {
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / samples.length);
}

describe('TelephonyInboundDecoder (streaming)', () => {
  test('emits little-endian s16 bytes, ~2× the input μ-law length', () => {
    const dec = new TelephonyInboundDecoder();
    const pcm8k = sine(160, 300, 8000);
    const payload = Buffer.from(muLawEncode(pcm8k)).toString('base64');
    const out = dec.push(payload);
    expect(out.length % 2).toBe(0); // whole s16 samples
    expect(out.length / 2).toBeGreaterThanOrEqual(319); // ~2× upsample
    expect(out.length / 2).toBeLessThanOrEqual(321);
  });

  test('carries resampler state across frames (continuous, no per-frame restart)', () => {
    const dec = new TelephonyInboundDecoder();
    let total = 0;
    for (let f = 0; f < 5; f++) {
      const pcm8k = sine(160, 300, 8000);
      total += dec.push(Buffer.from(muLawEncode(pcm8k)).toString('base64')).length;
    }
    // 5 × 160 μ-law samples → ~1600 s16 samples → ~3200 bytes (±a few for carry).
    expect(total / 2).toBeGreaterThanOrEqual(1598);
    expect(total / 2).toBeLessThanOrEqual(1602);
  });

  test('raw μ-law bytes and base64 decode the same', () => {
    const mulaw = muLawEncode(sine(160, 300, 8000));
    const fromBytes = new TelephonyInboundDecoder().push(mulaw);
    const fromBase64 = new TelephonyInboundDecoder().push(Buffer.from(mulaw).toString('base64'));
    expect(Buffer.from(fromBytes).equals(Buffer.from(fromBase64))).toBe(true);
  });
});

describe('TelephonyOutboundEncoder', () => {
  // A second of a 440 Hz tone at 24 kHz, as a speech engine would generate it.
  const tone = bytesOf(sine(24000, 440, 24000));

  test('audio fed in arbitrary chunks encodes exactly as the same audio fed at once (no discontinuity at joins)', () => {
    const whole = new TelephonyOutboundEncoder();
    const oneShot = concat([...whole.push(tone, 24000), whole.flush() ?? new Uint8Array(0)]);

    const chunked = new TelephonyOutboundEncoder();
    const frames: Uint8Array[] = [];
    // Odd sizes: chunks end mid-sample, mid-frame and off the 3:1 resampling grid.
    const sizes = [1, 333, 4096, 7, 1001, 2048, 5];
    for (let at = 0, i = 0; at < tone.length; i++) {
      const size = sizes[i % sizes.length];
      frames.push(...chunked.push(tone.subarray(at, at + size), 24000));
      at += size;
    }
    const tail = chunked.flush();
    if (tail) frames.push(tail);
    const streamed = concat(frames);

    expect(streamed.length).toBe(oneShot.length);
    expect(Buffer.from(streamed).equals(Buffer.from(oneShot))).toBe(true);
  });

  test('a fresh resampler per chunk would not: the join is where it differs', () => {
    // The old path encoded every 20 ms chunk on its own. Against the stateful
    // encoder, the samples differ — which is the click this replaces.
    const stateful = new TelephonyOutboundEncoder();
    const good = concat(stateful.push(tone.subarray(0, 9600), 24000));
    const restarted = concat([0, 960 * 2, 960 * 4, 960 * 6, 960 * 8].flatMap((at) => new TelephonyOutboundEncoder().push(tone.subarray(at, at + 960 * 2), 24000)));
    expect(restarted.length).toBe(good.length);
    expect(Buffer.from(restarted).equals(Buffer.from(good))).toBe(false);
  });

  test('every frame is 20 ms of 8 kHz μ-law; a second of audio is 50 frames', () => {
    const encoder = new TelephonyOutboundEncoder();
    const frames = encoder.push(tone, 24000);
    const tail = encoder.flush();
    for (const frame of frames) expect(frame.length).toBe(TELEPHONY_FRAME_BYTES);
    expect(frames.length + (tail ? 1 : 0)).toBe(50);
  });

  test('the tail is padded with silence to a whole frame, and flush is empty afterwards', () => {
    const encoder = new TelephonyOutboundEncoder();
    // 30 ms at 8 kHz: one whole frame and half of the next.
    const frames = encoder.push(bytesOf(sine(240, 300, 8000)), 8000);
    expect(frames).toHaveLength(1);
    const tail = encoder.flush();
    expect(tail).toHaveLength(TELEPHONY_FRAME_BYTES);
    expect([...(tail as Uint8Array).subarray(80)].every((b) => b === 0xff)).toBe(true);
    expect(encoder.flush()).toBeNull();
  });

  test('a tone the line can carry survives; what lies above 4 kHz is taken out instead of folding back', () => {
    const through = (freq: number) => {
      const encoder = new TelephonyOutboundEncoder();
      const mulaw = concat(encoder.push(bytesOf(sine(24000, freq, 24000)), 24000));
      return rms(muLawDecode(mulaw).subarray(800)); // past the filter's settling
    };
    const voice = through(1000);
    const hiss = through(6000); // would alias to 2 kHz at 8 kHz
    expect(voice).toBeGreaterThan(7000); // a 12000-peak sine has an RMS of ~8485
    expect(hiss).toBeLessThan(voice / 5);
  });

  test('8 kHz audio passes through without resampling', () => {
    const encoder = new TelephonyOutboundEncoder();
    const pcm = sine(160, 300, 8000);
    const [frame] = encoder.push(bytesOf(pcm), 8000);
    expect(Buffer.from(frame).equals(Buffer.from(muLawEncode(pcm)))).toBe(true);
  });
});
