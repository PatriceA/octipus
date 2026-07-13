/**
 * Twilio Media Streams ↔ whisper audio bridge (Phase 4d).
 *
 * Carriers send 8 kHz μ-law (G.711) base64 frames; whisper wants 16 kHz mono
 * s16le. These are the two pure conversions between them, built on the Phase 4a
 * codec (muLaw*, resamplePcm16). Kept separate from the WS handler so they're
 * unit-testable without a socket or a carrier.
 */
import { muLawDecode, muLawEncode, resamplePcm16, StreamingResampler } from '../audio-codec';

const TELEPHONY_RATE = 8000;
const WHISPER_RATE = 16000;

/** One inbound Twilio media payload (base64 μ-law 8 kHz) → 16 kHz mono s16le PCM. */
export function twilioMediaToPcm16k(base64Payload: string): Int16Array {
  const mulaw = Uint8Array.from(Buffer.from(base64Payload, 'base64'));
  const pcm8k = muLawDecode(mulaw);
  return resamplePcm16(pcm8k, TELEPHONY_RATE, WHISPER_RATE);
}

/** 16 kHz mono s16le PCM → one outbound Twilio media payload (base64 μ-law 8 kHz). */
export function pcm16kToTwilioMedia(pcm16k: Int16Array): string {
  const pcm8k = resamplePcm16(pcm16k, WHISPER_RATE, TELEPHONY_RATE);
  const mulaw = muLawEncode(pcm8k);
  return Buffer.from(mulaw).toString('base64');
}

/**
 * Stateful inbound decoder for a live call: μ-law bytes arrive in a stream of
 * small frames, so the 8 kHz→16 kHz resample must carry state across frames
 * (a fresh resampler per frame would click at every join). Returns raw s16le
 * PCM bytes ready to push into a whisper stream.
 */
export class TwilioInboundDecoder {
  private readonly resampler = new StreamingResampler(TELEPHONY_RATE, WHISPER_RATE);

  /** base64 μ-law frame → 16 kHz s16le PCM bytes (little-endian). */
  push(base64Payload: string): Uint8Array {
    const mulaw = Uint8Array.from(Buffer.from(base64Payload, 'base64'));
    const pcm8k = muLawDecode(mulaw);
    const pcm16k = this.resampler.push(pcm8k);
    // Int16Array → little-endian byte view. Int16Array is already host-endian;
    // assume LE (whisper/x64/arm are all LE) — matches pcm16kMonoToWav in stt.ts.
    return new Uint8Array(pcm16k.buffer, pcm16k.byteOffset, pcm16k.byteLength);
  }
}
