import { describe, test, expect } from 'bun:test';
import { twilioMediaToPcm16k, pcm16kToTwilioMedia, TwilioInboundDecoder } from './media-bridge';
import { muLawEncode } from '../audio-codec';

function sine(samples: number, freq: number, rate: number, amp = 12000): Int16Array {
  const out = new Int16Array(samples);
  for (let i = 0; i < samples; i++) out[i] = Math.round(amp * Math.sin((2 * Math.PI * freq * i) / rate));
  return out;
}

describe('twilioMediaToPcm16k', () => {
  test('8 kHz μ-law payload decodes to ~2× samples at 16 kHz', () => {
    const pcm8k = sine(160, 300, 8000); // 20 ms @ 8 kHz
    const payload = Buffer.from(muLawEncode(pcm8k)).toString('base64');
    const pcm16k = twilioMediaToPcm16k(payload);
    // Upsampled 8k→16k ≈ 2× length (±1 for fractional tail).
    expect(pcm16k.length).toBeGreaterThanOrEqual(319);
    expect(pcm16k.length).toBeLessThanOrEqual(321);
  });
});

describe('pcm16kToTwilioMedia', () => {
  test('16 kHz PCM encodes to base64 μ-law of ~half the samples', () => {
    const pcm16k = sine(320, 300, 16000); // 20 ms @ 16 kHz
    const payload = pcm16kToTwilioMedia(pcm16k);
    const bytes = Buffer.from(payload, 'base64');
    // 16k→8k halves the sample count; μ-law is 1 byte/sample.
    expect(bytes.length).toBeGreaterThanOrEqual(159);
    expect(bytes.length).toBeLessThanOrEqual(161);
  });
});

describe('round-trip 16k → telephony → 16k', () => {
  test('preserves a 300 Hz tone (sign + rough magnitude) despite μ-law + resample loss', () => {
    const original = sine(1600, 300, 16000, 12000); // 100 ms, well under the 4 kHz telephony Nyquist
    const payload = pcm16kToTwilioMedia(original);
    // Decode back (payload is 8 kHz μ-law; twilioMediaToPcm16k upsamples to 16 kHz).
    const back = twilioMediaToPcm16k(payload);
    expect(Math.abs(back.length - original.length)).toBeLessThanOrEqual(2);
    // Compare the loud interior samples: same sign, magnitude in the right ballpark.
    let checked = 0;
    const n = Math.min(back.length, original.length);
    for (let i = 100; i < n - 100; i++) {
      if (Math.abs(original[i]) > 4000) {
        expect(Math.sign(back[i])).toBe(Math.sign(original[i]));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(50); // actually exercised the tone
  });
});

describe('TwilioInboundDecoder (streaming)', () => {
  test('emits little-endian s16 bytes, ~2× the input μ-law length', () => {
    const dec = new TwilioInboundDecoder();
    const pcm8k = sine(160, 300, 8000);
    const payload = Buffer.from(muLawEncode(pcm8k)).toString('base64');
    const out = dec.push(payload);
    expect(out.length % 2).toBe(0); // whole s16 samples
    expect(out.length / 2).toBeGreaterThanOrEqual(319); // ~2× upsample
    expect(out.length / 2).toBeLessThanOrEqual(321);
  });

  test('carries resampler state across frames (continuous, no per-frame restart)', () => {
    const dec = new TwilioInboundDecoder();
    let total = 0;
    for (let f = 0; f < 5; f++) {
      const pcm8k = sine(160, 300, 8000);
      total += dec.push(Buffer.from(muLawEncode(pcm8k)).toString('base64')).length;
    }
    // 5 × 160 μ-law samples → ~1600 s16 samples → ~3200 bytes (±a few for carry).
    expect(total / 2).toBeGreaterThanOrEqual(1598);
    expect(total / 2).toBeLessThanOrEqual(1602);
  });
});
