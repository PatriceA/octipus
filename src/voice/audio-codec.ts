/**
 * Realtime audio primitives (Phase 4a).
 *
 * The one thing every realtime voice path needs and batch mode didn't: turning a
 * live stream of PCM frames into the fixed shape whisper.cpp / Mistral consume
 * (16 kHz mono s16le), continuously, without a file round-trip.
 *
 * Pure functions + tiny stateful classes — no I/O, 100% unit-testable. Includes
 * μ-law (G.711) for telephony (Phase 4d): carriers send 8 kHz μ-law, so the
 * media-stream bridge decodes → resamples to 16 kHz for whisper, and encodes the
 * reverse for TTS playback.
 */

/** inRate/outRate ratio → samples of input consumed per output sample. */
function ratio(inRate: number, outRate: number): number {
  if (inRate <= 0 || outRate <= 0) throw new Error(`invalid sample rates: ${inRate} → ${outRate}`);
  return inRate / outRate;
}

/**
 * Stateful linear-interpolation resampler for mono s16 PCM.
 *
 * Streaming-safe: carries the fractional read position and the last sample
 * across `push()` calls, so a signal fed in N arbitrary-sized frames resamples
 * identically (bit-for-bit at frame joins) to the same signal fed in one frame.
 * That continuity is the whole reason batch `resamplePcm16` can't just be called
 * per-frame — it would restart interpolation at every frame boundary and click.
 */
export class StreamingResampler {
  private readonly step: number;
  private pos = 0; // next output position, in input-sample space of the current push
  private prev = 0; // last sample of the previous push (virtual index -1)

  constructor(inRate: number, outRate: number) {
    this.step = ratio(inRate, outRate);
  }

  push(input: Int16Array): Int16Array {
    if (input.length === 0) return new Int16Array(0);
    const n = input.length;
    let p = this.pos;
    // Preallocate exactly (one slack slot guards FP rounding of the count); the
    // count is floor((n-1-pos)/step)+1, or 0 if the frame is already behind pos.
    const est = p <= n - 1 ? Math.floor((n - 1 - p) / this.step) + 2 : 0;
    const out = new Int16Array(est);
    let j = 0;
    // Emit every output sample whose interpolation window [i0, i0+1] is covered
    // by prev (index -1) plus this frame (0..n-1).
    while (p <= n - 1) {
      const i0 = Math.floor(p);
      const frac = p - i0;
      const s0 = i0 < 0 ? this.prev : input[i0];
      const s1 = input[Math.min(i0 + 1, n - 1)];
      out[j++] = Math.round(s0 * (1 - frac) + s1 * frac);
      p += this.step;
    }
    this.pos = p - n; // remainder carries into the next frame's coordinate space
    this.prev = input[n - 1];
    return j === out.length ? out : out.subarray(0, j);
  }
}

/** One-shot resample of a whole mono s16 PCM buffer. */
export function resamplePcm16(input: Int16Array, inRate: number, outRate: number): Int16Array {
  if (inRate === outRate) return input.slice(); // copy — never alias the caller's buffer
  return new StreamingResampler(inRate, outRate).push(input);
}

/**
 * Buffers pushed byte frames and emits fixed-size windows once a byte threshold
 * is crossed — the adapter between "mic frames arrive whenever" and "whisper
 * wants a window of ~this many bytes".
 *
 * Drains fully: one push carrying several windows' worth of bytes (a buffered
 * network read, a file-backed stream) yields several windows, so the caller's
 * window size is honored regardless of how the transport chunks the audio.
 * Windows are exactly `thresholdBytes`; the remainder waits for the next push.
 */
export class FrameAccumulator {
  private pending = new Uint8Array(0);

  constructor(private readonly thresholdBytes: number) {
    if (thresholdBytes <= 0) throw new Error(`thresholdBytes must be > 0, got ${thresholdBytes}`);
  }

  /** Returns zero or more full windows released by this push. */
  push(chunk: Uint8Array): Uint8Array[] {
    if (chunk.length) {
      const merged = new Uint8Array(this.pending.length + chunk.length);
      merged.set(this.pending);
      merged.set(chunk, this.pending.length);
      this.pending = merged;
    }
    const windows: Uint8Array[] = [];
    let off = 0;
    while (this.pending.length - off >= this.thresholdBytes) {
      // subarray shares the buffer; windows are read-only downstream, so it's safe.
      windows.push(this.pending.subarray(off, off + this.thresholdBytes));
      off += this.thresholdBytes;
    }
    if (off) this.pending = this.pending.slice(off); // copy the remainder off the drained buffer
    return windows;
  }

  /** Emit whatever is buffered (the trailing partial window), or null if empty. */
  flush(): Uint8Array | null {
    if (this.pending.length === 0) return null;
    const out = this.pending;
    this.pending = new Uint8Array(0);
    return out;
  }
}

// ── μ-law (G.711) codec — telephony carries 8 kHz μ-law ────────────────────────
// Standard ITU-T G.711 μ-law. Reference: the classic Sun/CCITT implementation.
const MULAW_BIAS = 0x84; // 132
const MULAW_CLIP = 32635;

/** One 16-bit PCM sample → one μ-law byte. */
export function muLawEncodeSample(sample: number): number {
  const sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > MULAW_CLIP) sample = MULAW_CLIP;
  sample += MULAW_BIAS;
  // exp_lut: floor(log2) of (sample>>7)&0xFF, clamped 0..7 (idx 1→0, 2→1, …).
  const idx = (sample >> 7) & 0xff;
  const exponent = idx === 0 ? 0 : Math.min(7, 31 - Math.clz32(idx));
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** One μ-law byte → one 16-bit PCM sample. */
export function muLawDecodeSample(muLaw: number): number {
  muLaw = ~muLaw & 0xff;
  const sign = muLaw & 0x80;
  const exponent = (muLaw >> 4) & 0x07;
  const mantissa = muLaw & 0x0f;
  let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
  sample -= MULAW_BIAS;
  return sign ? -sample : sample;
}

/** Decode a μ-law byte buffer to 16-bit PCM samples. */
export function muLawDecode(bytes: Uint8Array): Int16Array {
  const out = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = muLawDecodeSample(bytes[i]);
  return out;
}

/** Encode 16-bit PCM samples to a μ-law byte buffer. */
export function muLawEncode(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = muLawEncodeSample(samples[i]);
  return out;
}
