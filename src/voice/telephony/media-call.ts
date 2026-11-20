/**
 * One phone call on a carrier's media stream — the phone's counterpart of the
 * web and mobile conversation (`src/voice/session.ts`), built from the same
 * pieces:
 *
 *   caller μ-law 8 kHz ─▶ PCM 16 kHz ─▶ endpointer ─▶ speech to text ─▶ the caller's turn
 *                                                                           │
 *   caller ◀─ 20 ms μ-law frames, in real time ◀─ 8 kHz ◀─ text to speech ◀─ sentence chunker ◀─ the phone reply, as it is written
 *
 * Ears: the Transcription lane's engine is resolved once per call. One that
 * streams hears continuously and its text is cut where the endpointer hears
 * the turn end; any other transcribes each utterance whole.
 *
 * Turns: utterances are transcribed one after the other. The caller is never
 * ignored: what they say while a reply is being prepared cancels that reply,
 * and the next one answers everything said since the last reply they heard.
 * Talking over a reply being spoken (barge-in) stops it at once.
 *
 * Mouth: the reply is spoken while it is written — each sentence synthesised
 * as it completes, the next one already in flight — and leaves as 20 ms
 * frames paced to real time, so the carrier never holds more than a moment of
 * audio that an interruption would have to take back.
 *
 * No socket, no carrier, no model in here: everything outside is injected
 * (`PhoneMediaDeps`, `PhoneMediaTransport`), as in `VoiceSession`.
 */
import { SentenceChunker } from '@/shared/speech-text';
import { logger } from '@/utils/logger';
import { type EndpointEvent, Endpointer, type EndpointerOptions } from '../endpointer';
import type { SpeechStream } from '../resolve';
import type { STTEngine } from '../stt';
import { pcmToWav } from '../wav';
import { TELEPHONY_FRAME_MS, TelephonyOutboundEncoder, TelephonyInboundDecoder } from './media-bridge';
import type { PhoneReplyStream } from './reply';

const log = logger.child({ component: 'phone-media-call' });

/** What the call sends to the carrier. */
export interface PhoneMediaTransport {
  /** One 20 ms frame of 8 kHz μ-law for the caller. */
  audio(frame: Uint8Array): void;
  /** Drop what the carrier holds but has not played yet. */
  clear(): void;
  /** Ask the carrier to report (`markReached`) when everything sent so far has been played. */
  mark(name: string): void;
}

export interface PhoneMediaDeps {
  /** The Transcription lane's engine. Resolved once per call; the call disposes it. */
  resolveStt(): Promise<{ engine: STTEngine; name: string }>;
  /** Transcribe one whole utterance (a 16 kHz WAV) through the lane. */
  transcribe(wav: Buffer): Promise<string>;
  /** Record what the caller said on the call's history. */
  heard(text: string): void;
  /** The reply to the conversation as it stands, as it is written. */
  reply(signal: AbortSignal): PhoneReplyStream;
  /** Record what the caller was told: a whole reply, or as much of one as left before it was interrupted. */
  said(text: string): void;
  /** Speak one piece of text through the Speech lane, as PCM. */
  speak(text: string): Promise<SpeechStream>;
  /** End the call at the carrier (the farewell has been spoken). */
  hangup(): Promise<void>;
  /** Seconds of audio a live engine heard, for accounting. */
  recordHeard?(seconds: number): Promise<void> | void;
  /** Time, for pacing. Injected by tests. */
  clock?: { now(): number; sleep(ms: number): Promise<void> };
}

export interface PhoneMediaOptions {
  callId: string;
  endpointer?: EndpointerOptions;
  /** Said when a turn could not be transcribed or answered. */
  troubleLine?: string;
}

interface QueuedSpeech {
  text: string;
  stream?: Promise<SpeechStream>;
}

interface ReplyTurn {
  abort: AbortController;
  chunker: SentenceChunker;
  encoder: TelephonyOutboundEncoder;
  queue: QueuedSpeech[];
  pumping: boolean;
  /** The reply's text is complete (or its writing failed): nothing more is queued. */
  written: boolean;
  /** Everything has been handed to the carrier. */
  finished: boolean;
  /** A frame of this reply has left: the caller may have heard some of it. */
  sentAudio: boolean;
  /** The sentences sent, the one being sent included. */
  spoken: string[];
  /** What was said is on the call's history — or is a stock line that does not belong there. */
  recorded: boolean;
  endCall: boolean;
  mark: string;
}

/** A live engine's text settles within this long of the turn's end, or is taken as it is. */
const SETTLE_QUIET_MS = 350;
const SETTLE_MIN_MS = 150;
const SETTLE_MAX_MS = 1500;
/** If a live engine falls this far behind, frames are shed rather than buffered without bound. */
const MAX_BUFFERED_BYTES = 32000 * 10;
/** Audio is sent this far ahead of real time: enough to ride out a late timer, little to take back. */
const LEAD_MS = 100;
/** After the last frame's play time, the line is taken as quiet this much later (the carrier's own buffer). */
const PLAYOUT_MARGIN_MS = 120;

const realClock = { now: () => Date.now(), sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) };

export class PhoneMediaCall {
  private readonly endpointer: Endpointer;
  private readonly decoder = new TelephonyInboundDecoder();
  private readonly clock: NonNullable<PhoneMediaDeps['clock']>;
  private live: { engine: STTEngine; controller: ReadableStreamDefaultController<Uint8Array> | null; full: string; mark: number; lastPieceAt: number; heardBytes: number } | null = null;
  /** Audio heard before the engine was ready; fed to a live engine when it is. Null once it is. */
  private backlog: Uint8Array[] | null = [];
  private backlogBytes = 0;
  private started: Promise<void> | null = null;
  private closed = false;
  /** The farewell was spoken: the call is being hung up. */
  private ending = false;

  /** Serialises utterances: the second is transcribed after the first. */
  private hearing: Promise<void> = Promise.resolve();
  /** Utterances heard but not yet transcribed. */
  private pendingUtterances = 0;
  /** The caller has said something that no reply they heard has answered yet. */
  private unanswered = false;

  private turn: ReplyTurn | null = null;
  private turnSeq = 0;
  private speakingOn = false;
  /** When the carrier will have played everything sent so far. */
  private playCursor = 0;
  private quietTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly options: PhoneMediaOptions,
    private readonly deps: PhoneMediaDeps,
    private readonly transport: PhoneMediaTransport,
  ) {
    this.endpointer = new Endpointer(options.endpointer);
    this.clock = deps.clock ?? realClock;
  }

  /**
   * Resolve the ears. The call may be fed audio before this resolves: turns
   * are endpointed from the first frame and transcribed once the engine is
   * known. Rejects when no transcription engine can run.
   */
  start(): Promise<void> {
    this.started ??= this.open();
    return this.started;
  }

  private async open(): Promise<void> {
    const { engine, name } = await this.deps.resolveStt();
    const backlog = this.backlog ?? [];
    this.backlog = null;
    if (this.closed) {
      await this.dispose(engine);
      return;
    }
    if (engine.live) {
      let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
      const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } }, new ByteLengthQueuingStrategy({ highWaterMark: MAX_BUFFERED_BYTES }));
      const live = { engine, controller: controller as ReadableStreamDefaultController<Uint8Array> | null, full: '', mark: 0, lastPieceAt: 0, heardBytes: 0 };
      this.live = live;
      for (const pcm of backlog) this.feed(pcm);
      void this.consume(engine, stream, live);
    } else {
      // Each utterance goes through the lane whole (primary, then backup, accounted there).
      await this.dispose(engine);
    }
    log.info({ callId: this.options.callId, engine: name, live: !!engine.live }, 'Phone media call listening');
  }

  private async dispose(engine: STTEngine): Promise<void> {
    await engine.dispose().catch((err: unknown) => log.debug({ err }, 'Transcription engine did not dispose cleanly'));
  }

  private async consume(engine: STTEngine, stream: ReadableStream<Uint8Array>, live: NonNullable<PhoneMediaCall['live']>): Promise<void> {
    try {
      for await (const piece of engine.streamTranscribe(stream)) {
        if (this.closed) break;
        live.full += piece;
        live.lastPieceAt = Date.now();
      }
    } catch (err) {
      if (!this.closed) {
        // The stream is gone; the rest of the call is transcribed turn by turn.
        log.error({ err, callId: this.options.callId }, 'Live transcription failed; transcribing each turn whole from here on');
        if (this.live === live) this.live = null;
      }
    } finally {
      await this.dispose(engine);
      await this.deps.recordHeard?.(Math.round(live.heardBytes / 32000));
    }
  }

  private feed(pcm: Uint8Array): void {
    const live = this.live;
    if (!live?.controller || !pcm.length || (live.controller.desiredSize ?? 0) <= 0) return;
    live.controller.enqueue(pcm);
    live.heardBytes += pcm.length;
  }

  /** One media frame from the caller: 8 kHz μ-law, raw or base64. */
  pushMedia(payload: string | Uint8Array): void {
    if (this.closed) return;
    const pcm = this.decoder.push(payload);
    const wasSpeaking = this.speakingOn;
    const wasActive = this.endpointer.active;
    const events = this.endpointer.push(pcm);
    let bargedIn = false;
    let ended = false;
    for (const event of events) {
      if (event.type === 'barge_in') bargedIn = true;
      if (event.type === 'speech_end') ended = true;
      this.onEndpoint(event);
    }
    // While the reply plays the recogniser hears nothing: what the line
    // carries then is mostly the reply's own echo. Talking over it reopens
    // the line, starting with what was said to interrupt.
    const heard = bargedIn ? this.endpointer.current() : wasSpeaking || this.speakingOn ? null : pcm;
    if (heard?.length) {
      if (this.backlog) {
        if (this.backlogBytes + heard.length <= MAX_BUFFERED_BYTES) {
          this.backlog.push(heard.slice());
          this.backlogBytes += heard.length;
        }
      } else {
        this.feed(heard);
      }
    }
    // A sound too short to be a turn (a click, a cough) ended without one:
    // if it cancelled a reply, that reply is owed again.
    if (wasActive && !this.endpointer.active && !ended) this.answer();
  }

  private onEndpoint(event: EndpointEvent): void {
    if (event.type === 'barge_in') {
      this.cancelReply();
    } else if (event.type === 'speech_start') {
      // The caller goes on before hearing the reply: it would answer half of what they mean.
      this.cancelReply();
    } else {
      const pcm = event.pcm;
      this.pendingUtterances += 1;
      this.hearing = this.hearing.then(() => this.utterance(pcm)).catch((err: unknown) => {
        log.error({ err, callId: this.options.callId }, 'Utterance could not be transcribed');
        this.apologise();
      }).finally(() => {
        this.pendingUtterances -= 1;
        this.answer();
      });
    }
  }

  private async utterance(pcm: Uint8Array): Promise<void> {
    await this.start();
    let text: string;
    const live = this.live;
    if (live) {
      // The recogniser is a little behind the line: wait until its text stops growing.
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
    log.info({ callId: this.options.callId, heard: text.slice(0, 200) }, 'Phone turn heard');
    this.deps.heard(text);
    this.unanswered = true;
  }

  /** Reply to what is unanswered — unless the caller is still talking or still being transcribed. */
  private answer(): void {
    if (this.closed || this.ending || !this.unanswered || this.turn) return;
    if (this.endpointer.active || this.pendingUtterances > 0) return;
    const turn = this.newTurn();
    void this.write(turn);
  }

  private newTurn(): ReplyTurn {
    const turn: ReplyTurn = {
      abort: new AbortController(), chunker: new SentenceChunker(), encoder: new TelephonyOutboundEncoder(), queue: [], pumping: false,
      written: false, finished: false, sentAudio: false, spoken: [], recorded: false, endCall: false, mark: `reply-${++this.turnSeq}`,
    };
    this.turn = turn;
    return turn;
  }

  /** Read the reply as the model writes it, queueing each sentence as it completes. */
  private async write(turn: ReplyTurn): Promise<void> {
    const reply = this.deps.reply(turn.abort.signal);
    try {
      for await (const delta of reply) {
        if (turn !== this.turn) return;
        this.enqueue(turn, turn.chunker.push(delta));
      }
      if (turn !== this.turn) return;
      turn.endCall = reply.endCall;
      this.enqueue(turn, turn.chunker.flush());
    } catch (err) {
      if (turn !== this.turn) return;
      log.error({ err, callId: this.options.callId }, 'Phone reply failed');
      // Nothing said yet: tell the caller, rather than leave them in silence.
      if (!turn.queue.length && !turn.sentAudio && this.options.troubleLine) {
        turn.recorded = true;
        turn.queue.push({ text: this.options.troubleLine });
      }
    } finally {
      turn.written = true;
      if (turn === this.turn) void this.pump(turn);
    }
  }

  /** Say the stock apology (a turn could not be transcribed). */
  private apologise(): void {
    if (this.closed || this.ending || this.turn || !this.options.troubleLine) return;
    const turn = this.newTurn();
    turn.written = true;
    turn.recorded = true;
    turn.queue.push({ text: this.options.troubleLine });
    void this.pump(turn);
  }

  private enqueue(turn: ReplyTurn, sentences: string[]): void {
    for (const text of sentences) if (text) turn.queue.push({ text });
    // A sentence that completes while the one before it is being spoken is synthesised right away.
    if (turn.pumping && turn.queue[1]) void this.begin(turn.queue[1]);
    if (turn.queue.length) void this.pump(turn);
  }

  /** Synthesis starts here so a failure is this item's, not an unhandled rejection of a prefetch. */
  private begin(item: QueuedSpeech): Promise<SpeechStream> {
    if (!item.stream) {
      item.stream = this.deps.speak(item.text);
      // The rejection is handled where the stream is awaited (pump).
      item.stream.catch(() => undefined);
    }
    return item.stream;
  }

  private async release(stream: SpeechStream): Promise<void> {
    await stream.chunks.return(undefined).catch((err: unknown) => log.debug({ err }, 'Speech stream did not close cleanly'));
  }

  private async pump(turn: ReplyTurn): Promise<void> {
    if (turn.pumping || turn.finished) return;
    turn.pumping = true;
    try {
      while (turn === this.turn && !this.closed && turn.queue.length) {
        const item = turn.queue[0];
        const pending = this.begin(item);
        // The next sentence is synthesised while this one is sent and played.
        if (turn.queue[1]) void this.begin(turn.queue[1]);
        let stream: SpeechStream;
        try {
          stream = await pending;
        } catch (err) {
          if (turn === this.turn) {
            log.error({ err, callId: this.options.callId }, 'Phone speech synthesis failed');
            // One failure ends this reply's speech: the rest would fail the same way.
            this.dropQueue(turn);
          }
          break;
        }
        if (turn !== this.turn || this.closed) {
          await this.release(stream);
          break;
        }
        turn.spoken.push(item.text);
        try {
          await this.forward(turn, stream);
        } catch (err) {
          if (turn === this.turn) log.error({ err, callId: this.options.callId }, 'Phone speech stream failed');
        }
        if (turn.queue[0] === item) turn.queue.shift();
      }
    } finally {
      turn.pumping = false;
    }
    if (turn === this.turn && !this.closed && turn.written && !turn.queue.length) await this.finish(turn);
  }

  /** One sentence's PCM → frames, paced. */
  private async forward(turn: ReplyTurn, stream: SpeechStream): Promise<void> {
    try {
      for await (const chunk of stream.chunks) {
        for (const frame of turn.encoder.push(chunk, stream.sampleRate)) {
          if (turn !== this.turn || this.closed) return;
          await this.emit(turn, frame);
        }
        if (turn !== this.turn || this.closed) return;
      }
    } finally {
      await this.release(stream);
    }
  }

  private async emit(turn: ReplyTurn, frame: Uint8Array): Promise<void> {
    if (!this.speakingOn) {
      this.speakingOn = true;
      this.endpointer.setSpeaking(true);
    }
    if (this.quietTimer) { clearTimeout(this.quietTimer); this.quietTimer = null; }
    turn.sentAudio = true;
    const now = this.clock.now();
    if (this.playCursor < now) this.playCursor = now;
    this.transport.audio(frame);
    this.playCursor += TELEPHONY_FRAME_MS;
    const ahead = this.playCursor - now - LEAD_MS;
    if (ahead > 0) await this.clock.sleep(ahead);
  }

  /** The whole reply has been handed over: it is over once the carrier has played it. */
  private async finish(turn: ReplyTurn): Promise<void> {
    if (turn.finished) return;
    turn.finished = true;
    const tail = turn.encoder.flush();
    if (tail) await this.emit(turn, tail);
    if (turn !== this.turn || this.closed) return;
    this.unanswered = false;
    this.record(turn);
    if (!turn.sentAudio) {
      // Nothing could be said (the model wrote nothing, or synthesis failed).
      this.quiet(turn);
      return;
    }
    this.transport.mark(turn.mark);
    // The carrier reports the mark when it gets there; this is for one that does not.
    const wait = Math.max(0, this.playCursor - this.clock.now()) + PLAYOUT_MARGIN_MS;
    this.quietTimer = setTimeout(() => { this.quietTimer = null; this.quiet(turn); }, wait);
    this.quietTimer.unref?.();
  }

  /** The carrier has played everything up to the mark `name`. */
  markReached(name: string): void {
    const turn = this.turn;
    if (turn?.finished && turn.mark === name) this.quiet(turn);
  }

  /** The reply has been played to its end: the line is the caller's again. */
  private quiet(turn: ReplyTurn): void {
    if (turn !== this.turn || this.closed) return;
    if (this.quietTimer) { clearTimeout(this.quietTimer); this.quietTimer = null; }
    this.turn = null;
    this.speakingOn = false;
    this.playCursor = 0;
    this.endpointer.setSpeaking(false);
    if (turn.endCall) {
      this.ending = true;
      this.deps.hangup().catch((err: unknown) => log.error({ err, callId: this.options.callId }, 'Phone call could not be hung up after the farewell'));
      return;
    }
    // Something heard while the last frames played, too quiet to be a barge-in but a turn all the same.
    this.answer();
  }

  /** Put what the caller was told on the call's history, once. */
  private record(turn: ReplyTurn): void {
    if (turn.recorded) return;
    turn.recorded = true;
    const text = turn.spoken.join(' ').trim();
    if (text && turn.sentAudio) this.deps.said(text);
  }

  private dropQueue(turn: ReplyTurn): void {
    const dropped = turn.queue;
    turn.queue = [];
    for (const item of dropped) {
      item.stream?.then((stream) => this.release(stream)).catch(() => undefined); // its failure was the item's; nothing left to release
    }
  }

  /**
   * Stop the reply in flight: the caller talked over it, or went on talking
   * before it began. What they heard of it stays on the record; a reply they
   * heard nothing of is owed again, with what they say now.
   */
  private cancelReply(): void {
    const turn = this.turn;
    if (!turn) return;
    this.turn = null;
    turn.abort.abort();
    this.dropQueue(turn);
    if (this.quietTimer) { clearTimeout(this.quietTimer); this.quietTimer = null; }
    if (this.speakingOn) {
      this.speakingOn = false;
      this.endpointer.setSpeaking(false);
    }
    if (turn.sentAudio) {
      this.transport.clear();
      this.playCursor = 0;
      this.unanswered = false;
      this.record(turn);
      log.info({ callId: this.options.callId }, 'Phone reply interrupted by the caller');
    }
    // Else not a word of it was heard: what the caller said stays unanswered,
    // and is answered together with what they say now.
  }

  /** The call is over (the carrier stopped the stream, or the socket closed). */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const turn = this.turn;
    this.turn = null;
    if (turn) {
      turn.abort.abort();
      this.dropQueue(turn);
    }
    if (this.quietTimer) clearTimeout(this.quietTimer);
    try {
      this.live?.controller?.close();
    } catch (err) {
      log.debug({ err }, 'Live transcription stream was already closed');
    }
    await this.hearing;
  }
}
