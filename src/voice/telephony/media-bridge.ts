/**
 * Carrier media ↔ speech audio. A phone line carries 8 kHz μ-law (G.711) in
 * 20 ms frames; the speech pipeline hears 16 kHz mono s16le and speaks PCM at
 * whatever rate its engine generates. These are the two conversions between
 * them, both stateful: audio arrives and leaves as a stream of small pieces,
 * and a resampler restarted per piece would click at every join.
 *
 * Kept apart from the socket so they are unit-testable without a carrier.
 */
import { muLawDecode, muLawEncode, StreamingResampler } from '../audio-codec';

export const TELEPHONY_RATE = 8000;
const LISTEN_RATE = 16000;
/** One carrier frame: 20 ms of 8 kHz μ-law, one byte per sample. */
export const TELEPHONY_FRAME_BYTES = 160;
export const TELEPHONY_FRAME_MS = 20;
/** Digital silence in μ-law. */
const MULAW_SILENCE = 0xff;

/**
 * Inbound, one per call: μ-law frames → 16 kHz s16le PCM bytes for the
 * endpointer and the recogniser.
 */
export class TelephonyInboundDecoder {
  private readonly resampler = new StreamingResampler(TELEPHONY_RATE, LISTEN_RATE);

  /** A μ-law frame (raw bytes, or base64 as carriers send it) → 16 kHz s16le PCM bytes (little-endian). */
  push(payload: string | Uint8Array): Uint8Array {
    const mulaw = typeof payload === 'string' ? Uint8Array.from(Buffer.from(payload, 'base64')) : payload;
    const pcm8k = muLawDecode(mulaw);
    const pcm16k = this.resampler.push(pcm8k);
    // Int16Array → little-endian byte view. Int16Array is host-endian; every
    // platform this runs on (x64, arm64) is little-endian.
    return new Uint8Array(pcm16k.buffer, pcm16k.byteOffset, pcm16k.byteLength);
  }
}

/**
 * A phone line carries nothing above 4 kHz, and a resampler that only
 * interpolates folds what an engine generates up there (the hiss of an "s")
 * back into the voice as noise. This takes it out first: a 4th-order
 * Butterworth low-pass at 3.4 kHz (two biquads), with state, so it runs over
 * chunks as over one signal.
 */
class LowPass {
  private readonly sections: { b0: number; b1: number; b2: number; a1: number; a2: number; x1: number; x2: number; y1: number; y2: number }[];

  constructor(sampleRate: number, cutoffHz = 3400) {
    const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
    const cos = Math.cos(w0);
    // The two quality factors of a 4th-order Butterworth.
    this.sections = [0.54119610, 1.30656296].map((q) => {
      const alpha = Math.sin(w0) / (2 * q);
      const a0 = 1 + alpha;
      return { b0: (1 - cos) / 2 / a0, b1: (1 - cos) / a0, b2: (1 - cos) / 2 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
    });
  }

  run(samples: Int16Array): Int16Array {
    const out = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      let value: number = samples[i];
      for (const s of this.sections) {
        const y = s.b0 * value + s.b1 * s.x1 + s.b2 * s.x2 - s.a1 * s.y1 - s.a2 * s.y2;
        s.x2 = s.x1; s.x1 = value; s.y2 = s.y1; s.y1 = y;
        value = y;
      }
      out[i] = Math.max(-32768, Math.min(32767, Math.round(value)));
    }
    return out;
  }
}

/**
 * Outbound, one per reply: the engine's PCM (mono s16le, any chunking, any
 * rate) → whole 20 ms μ-law frames. The resampler, a sample split across two
 * chunks and the samples short of a full frame all carry over, so sentence
 * after sentence leaves as one continuous signal.
 */
export class TelephonyOutboundEncoder {
  private resampler: StreamingResampler | null = null;
  private lowPass: LowPass | null = null;
  private rate = 0;
  /** The first byte of a sample whose second byte is in the next chunk. */
  private oddByte: number | null = null;
  /** μ-law bytes short of a frame. */
  private pending = new Uint8Array(0);

  /** PCM as generated → the frames it completes. */
  push(pcm: Uint8Array, sampleRate: number): Uint8Array[] {
    if (sampleRate !== this.rate) {
      // Another engine took over mid-reply (the lane's backup): its audio starts a new signal.
      this.rate = sampleRate;
      this.resampler = sampleRate === TELEPHONY_RATE ? null : new StreamingResampler(sampleRate, TELEPHONY_RATE);
      this.lowPass = sampleRate > TELEPHONY_RATE ? new LowPass(sampleRate) : null;
      this.oddByte = null;
    }
    let bytes = pcm;
    if (this.oddByte !== null) {
      bytes = new Uint8Array(pcm.length + 1);
      bytes[0] = this.oddByte;
      bytes.set(pcm, 1);
      this.oddByte = null;
    }
    if (bytes.length % 2) {
      this.oddByte = bytes[bytes.length - 1];
      bytes = bytes.subarray(0, bytes.length - 1);
    }
    const samples = new Int16Array(bytes.length / 2);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true);
    const band = this.lowPass ? this.lowPass.run(samples) : samples;
    const mulaw = muLawEncode(this.resampler ? this.resampler.push(band) : band);

    const all = new Uint8Array(this.pending.length + mulaw.length);
    all.set(this.pending);
    all.set(mulaw, this.pending.length);
    const frames: Uint8Array[] = [];
    let at = 0;
    for (; at + TELEPHONY_FRAME_BYTES <= all.length; at += TELEPHONY_FRAME_BYTES) frames.push(all.subarray(at, at + TELEPHONY_FRAME_BYTES));
    this.pending = all.slice(at);
    return frames;
  }

  /** The reply is over: the samples short of a frame, padded with silence. Null when there are none. */
  flush(): Uint8Array | null {
    if (!this.pending.length) return null;
    const frame = new Uint8Array(TELEPHONY_FRAME_BYTES).fill(MULAW_SILENCE);
    frame.set(this.pending);
    this.pending = new Uint8Array(0);
    return frame;
  }
}
