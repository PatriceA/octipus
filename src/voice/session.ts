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
 *
 * Which replies: a turn sent as spoken (`chat.send` `spoken`) marks its
 * streamed text and its result, and only those are read — a typed message
 * in the same chat is not, unless the client asked (`expect_reply`). The
 * session follows one root turn at a time, by its agent id, so a second
 * utterance, an interruption or a failed turn never mixes one reply into
 * another: talking over a reply silences the rest of what that model call
 * writes; if what was said is steered into the running turn, its next model
 * call — the one that heard it — is spoken.
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
  /**
   * The Transcription lane's engine, for a live stream. The session disposes it.
   * `local`: what it hears stays on this machine (a look before the turn ends costs nothing).
   */
  resolveStt(): Promise<{ engine: STTEngine; name: string; local?: boolean }>;
  /**
   * May a live engine go on hearing this chat? Asked at the end of each turn:
   * the chat's protection level can be raised while the conversation is open.
   */
  mayKeepListening?(): Promise<boolean>;
  /** Transcribe one whole utterance (a 16 kHz WAV) through the lane. `interim`: a look before the turn ends, not counted. */
  transcribe(wav: Buffer, options?: { interim?: boolean }): Promise<string>;
  /** Speak one piece of text through the Speech lane, as PCM. */
  speak(text: string): Promise<SpeechStream>;
  /** The chat's events (`chat.delta`, `chat.response`, `chat.error`, `chat.message`, `voice.speak`). Returns the unsubscribe. */
  subscribe(handler: (event: VoiceTurnEvent) => void): () => void;
  /** Load the engines' models ahead of the first turn (local engines load on first use). */
  warmUp?(): Promise<void>;
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
  /**
   * Show what is being said before the turn ends. A batch engine re-transcribes
   * the turn so far for it, so the caller turns this on only for an engine on
   * this machine (a hosted one would bill each look).
   */
  partials?: boolean;
}

/** The root turn whose reply is being followed. */
interface ReplyRun {
  agentId: string;
  /** Its text is read aloud (a spoken turn, or one the client asked for). */
  spoken: boolean;
  chunker: SentenceChunker;
  /** The text of its current model call, to tell what the final answer adds to what was spoken. */
  streamed: { iteration: number; text: string };
  /** Model calls up to this one are not spoken: the person talked over them. */
  mutedThrough: number;
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
  /** Show what is being said before the turn ends: a live engine's text, or a local batch engine's look. */
  private partials = false;

  /** The root turn being followed; one runs at a time in a chat session. */
  private run: ReplyRun | null = null;
  /** `expect_reply`: speak the next turn even though it was not sent as spoken. */
  private expectNext = false;
  /** A spoken message was steered into the running turn before its text was seen. */
  private adoptNext = false;

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
    const { engine, name, local } = await this.deps.resolveStt();
    this.partials = this.options.partials !== false && (!!engine.live || local === true);
    if (engine.live) {
      let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
      const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } }, new ByteLengthQueuingStrategy({ highWaterMark: MAX_BUFFERED_BYTES }));
      const live = { engine, controller: controller as ReadableStreamDefaultController<Uint8Array> | null, full: '', mark: 0, lastPieceAt: 0, heardBytes: 0 };
      this.live = live;
      void this.consume(engine, stream, live);
    } else {
      // Each utterance goes through the lane whole (primary, then backup, accounted there).
      await engine.dispose().catch(() => {});
      // A local engine loads its model on first use, which would otherwise land
      // on the person's first sentence: start it while they are still drawing breath.
      if (this.deps.warmUp) void this.deps.warmUp().catch((err: unknown) => log.debug({ err }, 'Speech warm-up failed; the first turn pays the load'));
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
        if (text && this.partials) this.send({ type: 'transcript', text, final: false });
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

  /**
   * The live engine may no longer hear this chat (its protection level was
   * raised): it is closed, and each turn from here on goes through the lane,
   * which picks an engine the level allows or refuses.
   */
  private stopLive(): void {
    const live = this.live;
    if (!live) return;
    this.live = null;
    this.partials = false;
    try { live.controller?.close(); } catch { /* already closed */ }
    this.send({ type: 'error', message: 'This chat\'s protection level no longer lets the streaming speech engine hear it; turns are transcribed by an engine it allows.' });
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
    } else if (!live && this.partials && this.endpointer.active) {
      void this.partial();
    }
  }

  private onEndpoint(event: EndpointEvent): void {
    if (event.type === 'barge_in') {
      this.interrupt();
      this.send({ type: 'barge_in' });
    } else if (event.type === 'speech_start') {
      this.partialAt = 0;
      // A reply on its way but not yet heard (being synthesised): the person
      // spoke first, so it is dropped as if they had talked over it.
      // (The sentence being synthesised stays first in the queue until it is sent;
      // a barge-in just now emptied it, so this is never said twice.)
      if (!this.speakingOn && this.queue.length && this.options.endpointer?.bargeIn !== false) {
        this.interrupt();
        this.send({ type: 'barge_in' });
      }
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
    if (this.partialBusy || this.endpointer.currentBytes - this.partialAt < PARTIAL_EVERY_BYTES) return;
    const pcm = this.endpointer.current();
    this.partialBusy = true;
    this.partialAt = pcm.length;
    try {
      const text = (await this.deps.transcribe(pcmToWav(pcm, 16000), { interim: true })).trim();
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
      // An engine that only reports a finished segment (NeMo's realtime
      // server) may not have said anything yet: it gets until SETTLE_MAX_MS.
      while (Date.now() - started < SETTLE_MAX_MS
        && (Date.now() - Math.max(live.lastPieceAt, started - (SETTLE_QUIET_MS - SETTLE_MIN_MS)) < SETTLE_QUIET_MS || !live.full.slice(live.mark).trim())) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      text = live.full.slice(live.mark).trim();
      live.mark = live.full.length;
      if (this.deps.mayKeepListening && !(await this.deps.mayKeepListening().catch(() => false))) this.stopLive();
    } else {
      text = (await this.deps.transcribe(pcmToWav(pcm, 16000))).trim();
    }
    if (!text || this.closed) return;
    // The client sends it as a spoken chat message; that turn's reply is
    // marked spoken, which is what makes it heard here.
    this.send({ type: 'utterance', text });
  }

  /** Speak the next turn of this chat although it was not sent as spoken (a typed message, "read that again"). */
  expectReply(): void {
    if (!this.options.speak) return;
    this.expectNext = true;
  }

  private onTurnEvent(event: VoiceTurnEvent): void {
    if (this.closed || !this.options.speak) return;
    if (event.sessionId !== this.options.sessionId || (event.userId && event.userId !== this.options.userId)) return;
    const payload = (event.payload ?? {}) as {
      agentId?: unknown; delta?: unknown; iteration?: unknown; spoken?: unknown; injected?: unknown; text?: unknown;
      response?: { response?: unknown; agentId?: unknown; spoken?: unknown };
    };
    switch (event.type) {
      case 'voice.speak':
        // A narration line fills a silence ("On it — I've started the
        // researcher"). Once the answer itself is being written or spoken it
        // would only cut into it.
        if (typeof payload.text === 'string' && !this.run?.streamed.text && !this.queue.length) this.say(payload.text);
        return;
      case 'chat.message':
        // A spoken message steered into the running turn: the turn's next model
        // call answers it, so from there on it is spoken.
        if (payload.injected === true && payload.spoken === true) this.adopt();
        return;
      case 'chat.delta':
        if (typeof payload.delta === 'string' && typeof payload.agentId === 'string') {
          this.onDelta(payload.agentId, payload.delta, typeof payload.iteration === 'number' ? payload.iteration : 0, payload.spoken === true);
        }
        return;
      case 'chat.response': {
        const response = payload.response ?? {};
        const final = typeof response.response === 'string' ? response.response : '';
        this.onResponse(typeof response.agentId === 'string' ? response.agentId : null, final, response.spoken === true);
        return;
      }
      case 'chat.error':
        // The turn failed or was stopped: what it said so far ends here.
        if (this.run) this.finishRun(this.run, '');
        this.run = null;
        this.expectNext = false;
        return;
    }
  }

  /** The turn this text belongs to, starting to follow it when it is new. */
  private runFor(agentId: string, spoken: boolean): ReplyRun {
    if (this.run?.agentId === agentId) return this.run;
    // A new root turn: the last one ended (its result came first, or never will).
    if (this.run) this.finishRun(this.run, '');
    const run: ReplyRun = {
      agentId, spoken: spoken || this.expectNext || this.adoptNext,
      chunker: new SentenceChunker(), streamed: { iteration: -1, text: '' }, mutedThrough: -1,
    };
    this.expectNext = false;
    this.adoptNext = false;
    this.run = run;
    return run;
  }

  private onDelta(agentId: string, delta: string, iteration: number, spoken: boolean): void {
    const run = this.runFor(agentId, spoken);
    if (spoken && !run.spoken) {
      // The turn became a spoken one mid-way (steered): from this model call on.
      run.spoken = true;
      run.mutedThrough = Math.max(run.mutedThrough, iteration - 1);
    }
    if (iteration !== run.streamed.iteration) {
      // A new model call: what the last one said is complete (it went on to use a tool).
      this.flushRun(run);
      run.streamed = { iteration, text: '' };
    }
    run.streamed.text += delta;
    const sentences = run.chunker.push(delta);
    if (this.audible(run)) this.enqueue(sentences);
  }

  private onResponse(agentId: string | null, final: string, spoken: boolean): void {
    const run = this.run;
    if (run && (agentId === null || agentId === run.agentId)) {
      this.run = null;
      if (spoken && !run.spoken && run.mutedThrough < 0) {
        // Its text was not followed (a planning call, a turn marked spoken late): the answer is read whole.
        run.spoken = true;
        run.streamed.text = '';
      }
      this.finishRun(run, final);
      return;
    }
    // An answer nothing streamed for (a command, an approval, a direct reply).
    if (run) { this.finishRun(run, ''); this.run = null; }
    if (spoken || this.expectNext) this.enqueue(sentencesOf(final));
    this.expectNext = false;
  }

  /** A spoken message was steered into the running turn. */
  private adopt(): void {
    const run = this.run;
    if (!run) { this.adoptNext = true; return; }
    if (run.spoken) return;
    run.spoken = true;
    // The model call writing now did not hear the message yet.
    run.mutedThrough = Math.max(run.mutedThrough, run.streamed.iteration);
  }

  /** Is what this turn writes now heard? */
  private audible(run: ReplyRun): boolean {
    return run.spoken && run.streamed.iteration > run.mutedThrough;
  }

  /** The end of a model call: the rest of its last sentence. */
  private flushRun(run: ReplyRun): void {
    const rest = run.chunker.flush();
    if (this.audible(run)) this.enqueue(rest);
    run.chunker = new SentenceChunker();
  }

  /** The turn is over: its last words, and what the final answer adds to what was streamed. */
  private finishRun(run: ReplyRun, final: string): void {
    const audible = this.audible(run);
    this.flushRun(run);
    if (audible && final) this.enqueue(unspoken(final, run.streamed.text));
  }

  /** Speak a line that is not a chat reply (read this aloud, a narration). */
  say(text: string): void {
    if (this.closed || !this.options.speak) return;
    this.enqueue(sentencesOf(text));
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
            if (this.run) this.run.mutedThrough = Number.POSITIVE_INFINITY;
          }
          continue;
        }
        if (epoch !== this.epoch) { await stream.chunks.return(undefined).catch(() => {}); continue; }
        // Not over the person: a reply waits while they are talking.
        while (this.endpointer.active && epoch === this.epoch && !this.closed) await new Promise((resolve) => setTimeout(resolve, 50));
        if (epoch !== this.epoch || this.closed) { await stream.chunks.return(undefined).catch(() => {}); continue; }
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
    // The rest of what the model is writing now goes unsaid; a model call
    // after this one may still be heard (it answers what was said over it).
    if (this.run) this.run.mutedThrough = Math.max(this.run.mutedThrough, this.run.streamed.iteration);
    this.expectNext = false;
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
function sentencesOf(text: string): string[] {
  const chunker = new SentenceChunker();
  return [...chunker.push(text), ...chunker.flush()];
}

export function unspoken(final: string, streamedText: string): string[] {
  const all = sentencesOf;
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
