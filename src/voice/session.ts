/**
 * One live voice conversation, on the server (docs/VOICE.md → One pipeline).
 *
 *   microphone PCM ─▶ endpointer ─▶ speech to text ─▶ `utterance`
 *                                                        │  (the client sends it as a chat message)
 *   speaker PCM  ◀─ text to speech ◀─ sentence chunker ◀─ the reply, as the model writes it
 *
 * The client is a transport: it sends what the microphone hears and plays
 * what comes back. Where a turn ends, what is said aloud and how it is cut
 * into sentences are decided here, the same for the web, the mobile app and
 * anything else that opens the `/voice` socket in conversation mode.
 *
 * Two kinds of ears. An engine that streams (`live`) hears continuously and
 * its text is cut where the endpointer hears the turn end. Any other engine
 * transcribes each utterance whole, once — which is how a batch model such
 * as whisper-large-v3-turbo is best used: no fixed windows cutting words in
 * half, one decode per turn.
 *
 * The reply is spoken while it is written: the root agent's text deltas go
 * through the sentence chunker, and each sentence is synthesised as it
 * completes, the next one already in flight while the current one plays.
 */
import { SentenceChunker } from '@/shared/speech-text';
import { logger } from '@/utils/logger';
import { type EndpointEvent, Endpointer, type EndpointerOptions } from './endpointer';
import type { SpeechStream } from './resolve';
import type { STTEngine } from './stt';
import { pcmToWav } from './wav';

const log = logger.child({ component: 'voice-session' });

export type VoiceOut =
  | { type: 'ready'; mode: 'conversation'; engine: string; live: boolean; speak: boolean }
  | { type: 'speech_start' }
  | { type: 'transcript'; text: string; final: false }
  | { type: 'utterance'; text: string }
  /** The next binary frame is this audio. `text` is on the first frame of a sentence. */
  | { type: 'audio'; seq: number; format: 'pcm' | 'wav'; sampleRate: number; ms: number; text?: string }
  | { type: 'speaking'; on: boolean }
  | { type: 'barge_in' }
  | { type: 'error'; message: string };

/** What reaches a voice session from the turn it is listening to. */
export interface VoiceTurnEvent {
  type: string;
  userId?: string;
  sessionId?: string;
  payload?: unknown;
}

export interface VoiceSessionDeps {
  /** The Transcription lane's engine, for a live stream. The session disposes it. */
  resolveStt(): Promise<{ engine: STTEngine; name: string }>;
  /** Transcribe one whole utterance (a 16 kHz WAV) through the lane. */
  transcribe(wav: Buffer): Promise<string>;
  /** Speak one piece of text through the Speech lane, as PCM. */
  speak(text: string): Promise<SpeechStream>;
  /** The turn's events (`chat.delta`, `chat.response`, `voice.speak`). Returns the unsubscribe. */
  subscribe(handler: (event: VoiceTurnEvent) => void): () => void;
  /** Seconds of audio a live engine heard, for accounting. */
  recordHeard?(seconds: number): Promise<void> | void;
}

export interface VoiceSessionOptions {
  userId: string;
  /** The chat session whose replies are spoken. */
  sessionId: string;
  /** Speak replies. False: the session only listens. */
  speak: boolean;
  /** `pcm`: audio as it is generated. `wav`: one clip per sentence. */
  audio: 'pcm' | 'wav';
  endpointer?: EndpointerOptions;
  /** Show what is being said before the turn ends (batch engines re-transcribe the turn so far). */
  partials?: boolean;
}

interface QueuedSpeech {
  text: string;
  stream?: Promise<SpeechStream>;
}

/** A live engine's text settles within this long of the turn's end, or is taken as it is. */
const SETTLE_QUIET_MS = 350;
const SETTLE_MIN_MS = 150;
const SETTLE_MAX_MS = 1500;
/** A batch engine looks at the turn so far this often. */
const PARTIAL_EVERY_BYTES = 32000 * 1.5;
/** PCM frames sent to the client are this long, so an interruption stops within one. */
const FRAME_MS = 200;
/** If a live engine falls this far behind, frames are shed rather than buffered without bound. */
const MAX_BUFFERED_BYTES = 32000 * 10;

export class VoiceSession {
  private readonly endpointer: Endpointer;
  private live: { engine: STTEngine; controller: ReadableStreamDefaultController<Uint8Array> | null; full: string; mark: number; lastPieceAt: number; heardBytes: number } | null = null;
  private unsubscribe: (() => void) | null = null;
  private closed = false;
  /** Serialises utterances: the second is transcribed after the first. */
  private hearing: Promise<void> = Promise.resolve();
  private partialBusy = false;
  private partialAt = 0;

  /** A reply to an utterance of this session is expected: its text is spoken. */
  private awaitingReply = false;
  private chunker = new SentenceChunker();
  /** The text of the reply's last model call, to tell what the final answer adds to what was spoken. */
  private streamed = { iteration: -1, text: '' };

  private queue: QueuedSpeech[] = [];
  private pumping = false;
  /** Bumped by an interruption: everything queued before it is dropped. */
  private epoch = 0;
  private seq = 0;
  private speakingOn = false;
  private playUntil = 0;
  private quietTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly options: VoiceSessionOptions,
    private readonly deps: VoiceSessionDeps,
    private readonly send: (message: VoiceOut, binary?: Buffer) => void,
  ) {
    this.endpointer = new Endpointer(options.endpointer);
  }

  async start(): Promise<void> {
    const { engine, name } = await this.deps.resolveStt();
    if (engine.live) {
      let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
      const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } }, new ByteLengthQueuingStrategy({ highWaterMark: MAX_BUFFERED_BYTES }));
      const live = { engine, controller: controller as ReadableStreamDefaultController<Uint8Array> | null, full: '', mark: 0, lastPieceAt: 0, heardBytes: 0 };
      this.live = live;
      void this.consume(engine, stream, live);
    } else {
      // Each utterance goes through the lane whole (primary, then backup, accounted there).
      await engine.dispose().catch(() => {});
    }
    this.unsubscribe = this.deps.subscribe((event) => this.onTurnEvent(event));
    this.send({ type: 'ready', mode: 'conversation', engine: name, live: !!engine.live, speak: this.options.speak });
  }

  private async consume(engine: STTEngine, stream: ReadableStream<Uint8Array>, live: NonNullable<VoiceSession['live']>): Promise<void> {
    try {
      for await (const piece of engine.streamTranscribe(stream)) {
        if (this.closed) break;
        live.full += piece;
        live.lastPieceAt = Date.now();
        const text = live.full.slice(live.mark).trim();
        if (text && this.options.partials !== false) this.send({ type: 'transcript', text, final: false });
      }
    } catch (err) {
      if (!this.closed) {
        log.error({ err }, 'Live transcription failed');
        this.send({ type: 'error', message: `Transcription stopped: ${(err as Error).message}` });
      }
    } finally {
      await engine.dispose().catch(() => {});
      await this.deps.recordHeard?.(Math.round(live.heardBytes / 32000));
    }
  }

  /** Microphone audio: 16 kHz mono s16le. */
  pushAudio(pcm: Uint8Array): void {
    if (this.closed) return;
    const wasSpeaking = this.speakingOn;
    const events = this.endpointer.push(pcm);
    let bargedIn = false;
    for (const event of events) {
      if (event.type === 'barge_in') bargedIn = true;
      this.onEndpoint(event);
    }
    const live = this.live;
    if (live?.controller) {
      // While the reply plays the recogniser hears nothing: what the
      // microphone picks up then is mostly the reply itself. Talking over it
      // reopens the line, starting with what was said to interrupt.
      const feed = bargedIn ? this.endpointer.current() : wasSpeaking || this.speakingOn ? null : pcm;
      if (feed?.length && (live.controller.desiredSize ?? 0) > 0) {
        live.controller.enqueue(feed);
        live.heardBytes += feed.length;
      }
    } else if (!live && this.options.partials !== false && this.endpointer.active) {
      void this.partial();
    }
  }

  private onEndpoint(event: EndpointEvent): void {
    if (event.type === 'barge_in') {
      this.interrupt();
      this.send({ type: 'barge_in' });
    } else if (event.type === 'speech_start') {
      this.partialAt = 0;
      this.send({ type: 'speech_start' });
    } else {
      const pcm = event.pcm;
      this.hearing = this.hearing.then(() => this.utterance(pcm)).catch((err: unknown) => {
        log.error({ err }, 'Utterance could not be transcribed');
        if (!this.closed) this.send({ type: 'error', message: (err as Error).message });
      });
    }
  }

  /** A batch engine's look at the turn so far. Skipped while the last look is still running. */
  private async partial(): Promise<void> {
    const pcm = this.endpointer.current();
    if (this.partialBusy || pcm.length - this.partialAt < PARTIAL_EVERY_BYTES) return;
    this.partialBusy = true;
    this.partialAt = pcm.length;
    try {
      const text = (await this.deps.transcribe(pcmToWav(pcm, 16000))).trim();
      if (text && this.endpointer.active && !this.closed) this.send({ type: 'transcript', text, final: false });
    } catch (err) {
      log.debug({ err }, 'Interim transcript failed; the turn is transcribed when it ends');
    } finally {
      this.partialBusy = false;
    }
  }

  private async utterance(pcm: Uint8Array): Promise<void> {
    let text: string;
    const live = this.live;
    if (live) {
      // The recogniser is a little behind the microphone: wait until its text stops growing.
      const started = Date.now();
      // At least a moment, then until no new text for SETTLE_QUIET_MS, at most SETTLE_MAX_MS.
      while (Date.now() - started < SETTLE_MAX_MS && Date.now() - Math.max(live.lastPieceAt, started - (SETTLE_QUIET_MS - SETTLE_MIN_MS)) < SETTLE_QUIET_MS) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      text = live.full.slice(live.mark).trim();
      live.mark = live.full.length;
    } else {
      text = (await this.deps.transcribe(pcmToWav(pcm, 16000))).trim();
    }
    if (!text || this.closed) return;
    this.expectReply();
    this.send({ type: 'utterance', text });
  }

  /** The next reply in the chat session is spoken (an utterance was sent, or the client says so). */
  expectReply(): void {
    if (!this.options.speak) return;
    this.awaitingReply = true;
    this.chunker = new SentenceChunker();
    this.streamed = { iteration: -1, text: '' };
  }

  private onTurnEvent(event: VoiceTurnEvent): void {
    if (this.closed || !this.options.speak) return;
    if (event.sessionId !== this.options.sessionId || (event.userId && event.userId !== this.options.userId)) return;
    const payload = (event.payload ?? {}) as { delta?: unknown; iteration?: unknown; text?: unknown; response?: { response?: unknown } };
    if (event.type === 'voice.speak') {
      // A narration line fills a silence ("On it — I've started the
      // researcher"). Once the answer itself is being written or spoken it
      // would only cut into it.
      if (typeof payload.text === 'string' && !this.streamed.text && !this.queue.length) this.say(payload.text);
      return;
    }
    if (!this.awaitingReply) return;
    if (event.type === 'chat.delta' && typeof payload.delta === 'string') {
      const iteration = typeof payload.iteration === 'number' ? payload.iteration : 0;
      if (iteration !== this.streamed.iteration) {
        // A new model call: what the last one said is complete (it went on to use a tool).
        this.enqueue(this.chunker.flush());
        this.chunker = new SentenceChunker();
        this.streamed = { iteration, text: '' };
      }
      this.streamed.text += payload.delta;
      this.enqueue(this.chunker.push(payload.delta));
    } else if (event.type === 'chat.response') {
      const final = typeof payload.response?.response === 'string' ? payload.response.response : '';
      this.awaitingReply = false;
      this.enqueue(this.chunker.flush());
      this.enqueue(unspoken(final, this.streamed.text));
      this.chunker = new SentenceChunker();
      this.streamed = { iteration: -1, text: '' };
    }
  }

  /** Speak a line that is not a chat reply (read this aloud, a narration). */
  say(text: string): void {
    if (this.closed || !this.options.speak) return;
    const chunker = new SentenceChunker();
    this.enqueue([...chunker.push(text), ...chunker.flush()]);
  }

  private enqueue(sentences: string[]): void {
    for (const text of sentences) if (text) this.queue.push({ text });
    if (this.queue.length) void this.pump();
  }

  /** Synthesis starts here so a failure is this item's, not an unhandled rejection of a prefetch. */
  private begin(item: QueuedSpeech): Promise<SpeechStream> {
    if (!item.stream) {
      item.stream = this.deps.speak(item.text);
      item.stream.catch(() => {});
    }
    return item.stream;
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.closed && this.queue.length) {
        const epoch = this.epoch;
        const item = this.queue[0];
        const pending = this.begin(item);
        // The next sentence is synthesised while this one is sent and played.
        if (this.queue[1]) void this.begin(this.queue[1]);
        let stream: SpeechStream;
        try {
          stream = await pending;
        } catch (err) {
          if (epoch === this.epoch) {
            log.error({ err }, 'Speech synthesis failed');
            this.send({ type: 'error', message: (err as Error).message });
            // One failure ends this reply's speech: the rest would fail the same way.
            this.drop();
          }
          continue;
        }
        if (epoch !== this.epoch) { await stream.chunks.return(undefined).catch(() => {}); continue; }
        try {
          await this.forward(stream, item.text, epoch);
        } catch (err) {
          if (epoch === this.epoch) {
            log.error({ err }, 'Speech stream failed');
            this.send({ type: 'error', message: (err as Error).message });
          }
        }
        if (epoch === this.epoch && this.queue[0] === item) this.queue.shift();
      }
    } finally {
      this.pumping = false;
      this.settle();
    }
  }

  private async forward(stream: SpeechStream, text: string, epoch: number): Promise<void> {
    const frameBytes = Math.max(2, Math.round((stream.sampleRate * 2 * FRAME_MS) / 1000) & ~1);
    let first = true;
    const whole: Buffer[] = [];
    try {
      for await (const chunk of stream.chunks) {
        if (epoch !== this.epoch || this.closed) return;
        if (this.options.audio === 'wav') { whole.push(chunk); continue; }
        for (let at = 0; at < chunk.length; at += frameBytes) {
          this.emitAudio(chunk.subarray(at, at + frameBytes), stream.sampleRate, 'pcm', first ? text : undefined);
          first = false;
        }
      }
    } finally {
      await stream.chunks.return(undefined).catch(() => {});
    }
    if (this.options.audio === 'wav' && whole.length && epoch === this.epoch && !this.closed) {
      const pcm = Buffer.concat(whole);
      this.emitAudio(pcmToWav(pcm, stream.sampleRate), stream.sampleRate, 'wav', text, pcm.length);
    }
  }

  private emitAudio(data: Buffer, sampleRate: number, format: 'pcm' | 'wav', text: string | undefined, pcmBytes = data.length): void {
    const ms = Math.round((pcmBytes / 2 / sampleRate) * 1000);
    if (!this.speakingOn) {
      this.speakingOn = true;
      this.endpointer.setSpeaking(true);
      this.send({ type: 'speaking', on: true });
    }
    if (this.quietTimer) { clearTimeout(this.quietTimer); this.quietTimer = null; }
    this.playUntil = Math.max(Date.now(), this.playUntil) + ms;
    this.send({ type: 'audio', seq: this.seq++, format, sampleRate, ms, ...(text ? { text } : {}) }, data);
  }

  /** Nothing left to send: the reply is over once the client has played what it has. */
  private settle(): void {
    if (!this.speakingOn || this.queue.length || this.quietTimer || this.closed) return;
    const wait = Math.max(0, this.playUntil - Date.now());
    this.quietTimer = setTimeout(() => { this.quietTimer = null; this.quiet(); }, wait);
    this.quietTimer.unref?.();
  }

  private quiet(): void {
    if (!this.speakingOn || this.queue.length || this.pumping) return;
    this.speakingOn = false;
    this.playUntil = 0;
    this.endpointer.setSpeaking(false);
    if (!this.closed) this.send({ type: 'speaking', on: false });
  }

  /** The client has played everything it was sent. */
  playbackEnded(): void {
    if (this.quietTimer) { clearTimeout(this.quietTimer); this.quietTimer = null; }
    this.quiet();
  }

  /** Drop what is queued and stop what is being sent, closing streams already started. */
  private drop(): void {
    this.epoch += 1;
    const dropped = this.queue;
    this.queue = [];
    for (const item of dropped) item.stream?.then((s) => s.chunks.return(undefined)).catch(() => {});
  }

  /** Stop speaking now: the person talked over the reply, or tapped stop. */
  interrupt(): void {
    this.drop();
    this.awaitingReply = false;
    if (this.quietTimer) { clearTimeout(this.quietTimer); this.quietTimer = null; }
    if (this.speakingOn) {
      this.speakingOn = false;
      this.playUntil = 0;
      this.endpointer.setSpeaking(false);
      if (!this.closed) this.send({ type: 'speaking', on: false });
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe?.();
    this.drop();
    if (this.quietTimer) clearTimeout(this.quietTimer);
    try { this.live?.controller?.close(); } catch { /* already closed */ }
    await this.hearing.catch(() => {});
  }
}

/**
 * What of the final answer has not been spoken yet, as sentences. The reply
 * was spoken from its stream; the final text is usually the same and adds
 * nothing. It differs when nothing streamed (a model that does not stream, a
 * planning turn), when the stream stopped short, or when the answer was
 * replaced after the fact — then the difference is spoken.
 */
export function unspoken(final: string, streamedText: string): string[] {
  const all = (text: string) => { const c = new SentenceChunker(); return [...c.push(text), ...c.flush()]; };
  const want = all(final);
  if (!streamedText.trim()) return want;
  const norm = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const said = norm(all(streamedText).join(' '));
  const whole = norm(want.join(' '));
  if (!whole || whole === said || said.startsWith(whole)) return [];
  // Sentences the stream did not contain, from the first one that is new.
  const firstNew = want.findIndex((sentence) => !said.includes(norm(sentence)));
  return firstNew < 0 ? [] : want.slice(firstNew);
}
