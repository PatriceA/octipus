/**
 * Who is talking, and when did they stop — decided on the server, once, for
 * every surface that streams a microphone (the web conversation, the mobile
 * app, a phone line). It used to be re-implemented per client with different
 * constants: 1.5 s of silence in the browser, 0.8 s on a phone call, whatever
 * the phone's recogniser felt like on mobile.
 *
 * Pure: 16 kHz mono s16le PCM in, events out. No I/O, no timers — time is
 * counted in samples, so it behaves the same in a test as on a live line.
 *
 *   speech_start   someone started talking
 *   speech_end     they stopped: `pcm` is the utterance, with a short lead-in
 *   barge_in       they talked over the reply being spoken (then speech_start)
 *
 * The level that counts as speech follows the room: it is a multiple of the
 * background level heard while nobody talks, never below `speechRms`.
 */

const RATE = 16000;
const FRAME_SAMPLES = 320; // 20 ms
const FRAME_BYTES = FRAME_SAMPLES * 2;
const FRAME_MS = 20;

export interface EndpointerOptions {
  /** A pause this long ends the turn. */
  silenceMs?: number;
  /** Less speech than this is a click or a cough, not a turn. */
  minSpeechMs?: number;
  /** The lowest level (RMS, 0–1) that counts as speech. */
  speechRms?: number;
  /** Talking over a spoken reply must be this loud … */
  bargeRms?: number;
  /** … for this long, so the reply's own echo does not interrupt it. */
  bargeMs?: number;
  /** False: the microphone is ignored while a reply is spoken. */
  bargeIn?: boolean;
  /** Audio kept from before speech was detected, so the first syllable is not lost. */
  prerollMs?: number;
  /** A turn is cut here even without a pause. */
  maxUtteranceMs?: number;
}

export type EndpointEvent =
  | { type: 'speech_start' }
  | { type: 'speech_end'; pcm: Uint8Array; ms: number }
  | { type: 'barge_in' };

/** Root mean square of s16le samples, 0–1. */
export function pcmRms(pcm: Uint8Array): number {
  const n = pcm.length >> 1;
  if (n === 0) return 0;
  const view = new DataView(pcm.buffer, pcm.byteOffset, n * 2);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = view.getInt16(i * 2, true) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

export class Endpointer {
  private readonly silenceMs: number;
  private readonly minSpeechMs: number;
  private readonly speechRms: number;
  private readonly bargeRms: number;
  private readonly bargeMs: number;
  private readonly bargeIn: boolean;
  private readonly prerollFrames: number;
  private readonly maxUtteranceMs: number;

  private carry = new Uint8Array(0);
  private preroll: Uint8Array[] = [];
  private utterance: Uint8Array[] = [];
  private inSpeech = false;
  private speaking = false;
  /** Consecutive loud frames while idle (onset), and loud frames in the utterance. */
  private onset = 0;
  private voicedMs = 0;
  private trailingSilenceMs = 0;
  /** The level of the room while nobody talks. */
  private noise = 0;

  constructor(options: EndpointerOptions = {}) {
    this.silenceMs = options.silenceMs ?? 700;
    this.minSpeechMs = options.minSpeechMs ?? 200;
    this.speechRms = options.speechRms ?? 0.012;
    this.bargeRms = options.bargeRms ?? 0.04;
    this.bargeMs = options.bargeMs ?? 300;
    this.bargeIn = options.bargeIn ?? true;
    this.prerollFrames = Math.ceil((options.prerollMs ?? 300) / FRAME_MS);
    this.maxUtteranceMs = options.maxUtteranceMs ?? 60_000;
  }

  /** A reply is being played to the person: only clear over-talk counts as speech. */
  setSpeaking(on: boolean): void {
    this.speaking = on;
    if (!this.inSpeech) this.onset = 0;
  }

  /** True between `speech_start` and `speech_end`. */
  get active(): boolean {
    return this.inSpeech;
  }

  /** How much of an utterance has been heard so far, in bytes, without copying it. */
  get currentBytes(): number {
    return this.inSpeech ? this.utterance.length * FRAME_BYTES : 0;
  }

  /** The utterance so far, for a look at what is being said before it ends. */
  current(): Uint8Array {
    return concat(this.utterance);
  }

  /** Forget the utterance in progress (the line was muted, the turn was taken another way). */
  reset(): void {
    this.inSpeech = false;
    this.utterance = [];
    this.preroll = [];
    this.onset = 0;
    this.voicedMs = 0;
    this.trailingSilenceMs = 0;
  }

  push(pcm: Uint8Array): EndpointEvent[] {
    const events: EndpointEvent[] = [];
    let data = pcm;
    if (this.carry.length) {
      data = new Uint8Array(this.carry.length + pcm.length);
      data.set(this.carry);
      data.set(pcm, this.carry.length);
    }
    let offset = 0;
    for (; offset + FRAME_BYTES <= data.length; offset += FRAME_BYTES) {
      this.frame(data.slice(offset, offset + FRAME_BYTES), events);
    }
    this.carry = data.slice(offset);
    return events;
  }

  private frame(frame: Uint8Array, events: EndpointEvent[]): void {
    const level = pcmRms(frame);
    const floor = Math.max(this.speechRms, this.noise * 3);

    if (!this.inSpeech) {
      const threshold = this.speaking ? Math.max(this.bargeRms, floor) : floor;
      const loud = level >= threshold;
      // The room's level is learned from the quiet frames only, and never while a reply plays.
      if (!loud && !this.speaking) this.noise = this.noise === 0 ? level : this.noise * 0.95 + level * 0.05;
      this.preroll.push(frame);
      // The lead-in, plus the frames it takes to decide that speech has started.
      const onsetFrames = this.speaking ? Math.ceil(this.bargeMs / FRAME_MS) : 3;
      while (this.preroll.length > this.prerollFrames + onsetFrames) this.preroll.shift();
      if (this.speaking && !this.bargeIn) { this.onset = 0; return; }
      // Speech is not one unbroken loud stretch: a gap between syllables takes
      // a little back instead of starting the count again.
      this.onset = loud ? this.onset + 1 : Math.max(0, this.onset - (this.speaking ? 0.5 : 1));
      if (this.onset < onsetFrames) return; // 60 ms of speech starts a turn; over-talk needs `bargeMs`
      if (this.speaking) {
        events.push({ type: 'barge_in' });
        this.speaking = false;
      }
      events.push({ type: 'speech_start' });
      this.inSpeech = true;
      this.utterance = this.preroll;
      this.preroll = [];
      this.voicedMs = Math.round(this.onset) * FRAME_MS;
      this.trailingSilenceMs = 0;
      this.onset = 0;
      return;
    }

    this.utterance.push(frame);
    if (level >= floor) {
      this.voicedMs += FRAME_MS;
      this.trailingSilenceMs = 0;
    } else {
      this.trailingSilenceMs += FRAME_MS;
    }
    const lengthMs = this.utterance.length * FRAME_MS;
    if (this.trailingSilenceMs < this.silenceMs && lengthMs < this.maxUtteranceMs) return;

    const frames = this.utterance;
    const voiced = this.voicedMs;
    const trailing = this.trailingSilenceMs;
    this.reset();
    if (voiced < this.minSpeechMs) return; // a click, not a turn
    // Keep a short tail of the pause: recognisers do better with a clean ending.
    const keep = Math.max(1, frames.length - Math.max(0, Math.floor((trailing - 200) / FRAME_MS)));
    events.push({ type: 'speech_end', pcm: concat(frames.slice(0, keep)), ms: keep * FRAME_MS });
  }
}

function concat(frames: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
  let at = 0;
  for (const f of frames) { out.set(f, at); at += f.length; }
  return out;
}

export const ENDPOINTER_FRAME_MS = FRAME_MS;
export const ENDPOINTER_SAMPLE_RATE = RATE;
