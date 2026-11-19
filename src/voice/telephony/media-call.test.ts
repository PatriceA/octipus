/**
 * One phone call on the media stream, without a socket, a carrier or a
 * model: caller audio goes in as μ-law frames, and what the call sends to the
 * carrier (frames, clear, mark) and asks of its dependencies is observed.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { muLawEncode } from '../audio-codec';
import type { SpeechStream } from '../resolve';
import type { STTEngine } from '../stt';
import { PhoneMediaCall, type PhoneMediaDeps } from './media-call';
import { TELEPHONY_FRAME_BYTES } from './media-bridge';
import type { PhoneReplyStream } from './reply';

/** One 20 ms carrier frame: a loud tone (someone talking) or silence. */
function frame(loud: boolean): Uint8Array {
  const pcm = new Int16Array(160);
  if (loud) for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(9000 * Math.sin((2 * Math.PI * 300 * i) / 8000));
  return muLawEncode(pcm);
}
const LOUD = frame(true);
const QUIET = frame(false);

/** PCM a speech engine would generate: `ms` of tone at 16 kHz, in 100 ms chunks. */
function speech(ms: number, log: string[], label: string): SpeechStream & { released: () => boolean } {
  const pcm = new Int16Array((16000 * ms) / 1000);
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(6000 * Math.sin((2 * Math.PI * 220 * i) / 16000));
  const bytes = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let at = 0;
  let released = false;
  return {
    model: 'fake-tts',
    sampleRate: 16000,
    released: () => released,
    chunks: {
      [Symbol.asyncIterator]() { return this; },
      async next() {
        if (released || at >= bytes.length) { released = true; return { done: true, value: undefined }; }
        const chunk = bytes.subarray(at, at + 3200);
        at += 3200;
        return { done: false, value: chunk };
      },
      async return() {
        if (!released) log.push(`release:${label}`);
        released = true;
        return { done: true, value: undefined };
      },
    },
  };
}

function replyOf(deltas: string[], options: { endCall?: boolean; gate?: Promise<void>; fail?: Error; signal?: AbortSignal } = {}): PhoneReplyStream {
  let ended = false;
  return {
    get endCall() { return ended && !!options.endCall; },
    async *[Symbol.asyncIterator]() {
      await options.gate;
      for (const delta of deltas) {
        if (options.signal?.aborted) return;
        yield delta;
      }
      if (options.fail) throw options.fail;
      ended = true;
    },
  };
}

const batchEngine = (): STTEngine => ({
  transcribe: async () => { throw new Error('not used: utterances go through the lane'); },
  // biome-ignore lint/correctness/useYield: a batch engine's stream is never read
  async *streamTranscribe() { throw new Error('a batch engine is not streamed'); },
  dispose: async () => {},
});

interface Harness {
  call: PhoneMediaCall;
  log: string[];
  frames: Uint8Array[];
  heard: string[];
  said: string[];
  wavs: Buffer[];
  signals: AbortSignal[];
  streams: Array<ReturnType<typeof speech>>;
  hangups: number;
  /** Push caller audio: `ms` of talking or of silence. */
  caller(loud: boolean, ms: number): void;
  until(condition: () => boolean, what: string): Promise<void>;
}

const open: PhoneMediaCall[] = [];
afterEach(async () => { for (const call of open.splice(0)) await call.close(); });

function harness(over: Partial<PhoneMediaDeps> & { transcripts?: string[]; replies?: Array<(signal: AbortSignal) => PhoneReplyStream>; speechMs?: number } = {}): Harness {
  const log: string[] = [];
  const h = { log, frames: [], heard: [], said: [], wavs: [], signals: [], streams: [], hangups: 0 } as unknown as Harness;
  const transcripts = over.transcripts ?? ['What time is it?'];
  const replies = over.replies ?? [() => replyOf(['It is ', 'three o\'clock. ', 'Anything else I can do?'])];
  let now = 0;
  let turn = 0;
  const deps: PhoneMediaDeps = {
    resolveStt: async () => ({ engine: batchEngine(), name: 'fake-batch' }),
    transcribe: async (wav) => { h.wavs.push(wav); return transcripts[h.wavs.length - 1] ?? ''; },
    heard: (text) => { h.heard.push(text); log.push(`heard:${text}`); },
    reply: (signal) => { h.signals.push(signal); log.push('reply'); return (replies[turn++] ?? replies[replies.length - 1])(signal); },
    said: (text) => { h.said.push(text); },
    speak: async (text) => { log.push(`speak:${text}`); const stream = speech(over.speechMs ?? 400, log, text); h.streams.push(stream); return stream; },
    hangup: async () => { h.hangups += 1; },
    // Virtual time for pacing; every wait yields to the event loop so the test can talk meanwhile.
    clock: { now: () => now, sleep: async (ms) => { now += ms; await new Promise((resolve) => setImmediate(resolve)); } },
    ...over,
  };
  h.call = new PhoneMediaCall({ callId: 'call-1', endpointer: { silenceMs: 500 }, troubleLine: 'Sorry, could you repeat that?' }, deps, {
    audio: (f) => { h.frames.push(f); log.push('frame'); },
    clear: () => log.push('clear'),
    mark: (name) => log.push(`mark:${name}`),
  });
  open.push(h.call);
  h.caller = (loud, ms) => { for (let i = 0; i < ms / 20; i++) h.call.pushMedia(loud ? LOUD : QUIET); };
  h.until = async (condition, what) => {
    const deadline = Date.now() + 4000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; log: ${log.filter((l) => l !== 'frame').join(' | ')}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  return h;
}

describe('PhoneMediaCall', () => {
  test('a turn is heard whole and the reply is spoken sentence by sentence as 20 ms μ-law frames', async () => {
    const h = harness();
    await h.call.start();
    h.caller(true, 600);
    h.caller(false, 600);
    await h.until(() => h.log.some((l) => l.startsWith('mark:')), 'the reply to be handed over');

    // Ears: one transcription of the whole utterance, as a 16 kHz WAV.
    expect(h.wavs).toHaveLength(1);
    expect(h.wavs[0].toString('latin1', 0, 4)).toBe('RIFF');
    expect(h.wavs[0].readUInt32LE(24)).toBe(16000);
    expect(h.heard).toEqual(['What time is it?']);

    // Mouth: one synthesis per sentence, in order.
    const spoken = h.log.filter((l) => l.startsWith('speak:'));
    expect(spoken).toEqual(["speak:It is three o'clock.", 'speak:Anything else I can do?']);
    // 2 × 400 ms of speech → 40 frames of 20 ms, every one a whole frame.
    expect(h.frames).toHaveLength(40);
    for (const f of h.frames) expect(f.length).toBe(TELEPHONY_FRAME_BYTES);
    // The second sentence was being synthesised while the first was still playing.
    expect(h.log.indexOf('speak:Anything else I can do?')).toBeLessThan(h.log.lastIndexOf('frame') - 20);
    // Both engine streams were released, and what was said is on the record.
    expect(h.streams.every((s) => s.released())).toBe(true);
    expect(h.said).toEqual(["It is three o'clock. Anything else I can do?"]);
    expect(h.hangups).toBe(0);
  });

  test('talking over the reply stops it: no more frames, the carrier buffer is cleared, the model and the speech are cancelled', async () => {
    // Playback is held after a dozen frames, so the interruption lands mid-sentence
    // however fast or loaded the machine is (virtual time would otherwise let
    // the whole 4 s sentence out before the test gets to talk).
    let now = 0;
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const h = harness({
      speechMs: 4000, transcripts: ['What time is it?', 'Wait, stop.'],
      clock: {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
          // `h` is only read once the call plays, long after it is assigned.
          if (h.frames.length >= 12) await held;
          else await new Promise((resolve) => setImmediate(resolve));
        },
      },
    });
    await h.call.start();
    h.caller(true, 600);
    h.caller(false, 600);
    await h.until(() => h.frames.length >= 12, 'the reply to start playing');

    h.caller(true, 400); // over the reply, loud and long enough to be an interruption
    release();
    expect(h.log).toContain('clear');
    const sentAtBarge = h.frames.length;
    expect(h.signals[0].aborted).toBe(true);
    await h.until(() => h.streams.every((s) => s.released()), 'the speech streams to be released');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.frames.length).toBe(sentAtBarge);
    expect(sentAtBarge).toBeLessThan(200); // 4 s would be 200 frames
    expect(h.log.some((l) => l.startsWith('mark:'))).toBe(false);
    // The caller heard the start of the first sentence: that is what the record says was said.
    expect(h.said).toEqual(["It is three o'clock."]);

    // What they said to interrupt is their next turn, answered like any other.
    h.caller(false, 600);
    await h.until(() => h.heard.length === 2, 'the interrupting turn to be heard');
    expect(h.heard[1]).toBe('Wait, stop.');
    // The utterance starts with what was said to interrupt, not after it: 400 ms of speech and its lead-in.
    expect(h.wavs[1].length).toBeGreaterThan(44 + 32000 * 0.4);
    await h.until(() => h.log.filter((l) => l === 'reply').length === 2, 'the next reply');
  });

  test('the caller going on before the reply is heard cancels it; the next reply answers both', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = harness({
      transcripts: ["What's the weather", 'in Berlin tomorrow?'],
      replies: [(signal) => replyOf(['Where?'], { gate, signal }), () => replyOf(['Sunny in Berlin.'])],
    });
    await h.call.start();
    h.caller(true, 600);
    h.caller(false, 600);
    await h.until(() => h.log.includes('reply'), 'the first reply to be requested');

    h.caller(true, 600); // still thinking aloud: the first reply is not wanted any more
    expect(h.signals[0].aborted).toBe(true);
    release();
    h.caller(false, 600);
    await h.until(() => h.log.some((l) => l.startsWith('mark:')), 'the second reply');

    expect(h.heard).toEqual(["What's the weather", 'in Berlin tomorrow?']);
    expect(h.log.filter((l) => l.startsWith('speak:'))).toEqual(['speak:Sunny in Berlin.']);
    expect(h.said).toEqual(['Sunny in Berlin.']);
    expect(h.log).not.toContain('clear'); // nothing had been sent that could be taken back
  });

  test('a click while the reply is being written does not lose the reply: it is asked for again', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = harness({ replies: [(signal) => replyOf(['Never said.'], { gate, signal }), () => replyOf(['Three o\'clock.'])] });
    await h.call.start();
    h.caller(true, 600);
    h.caller(false, 600);
    await h.until(() => h.log.includes('reply'), 'the first reply to be requested');

    h.caller(true, 80); // a cough: starts a turn, too short to be one
    h.caller(false, 600);
    release();
    await h.until(() => h.log.some((l) => l.startsWith('mark:')), 'the reply');
    expect(h.heard).toEqual(['What time is it?']); // nothing new was said
    expect(h.wavs).toHaveLength(1);
    expect(h.log.filter((l) => l === 'reply')).toHaveLength(2);
    expect(h.log.filter((l) => l.startsWith('speak:'))).toEqual(["speak:Three o'clock."]);
  });

  test('a farewell is spoken to its end, then the call is hung up', async () => {
    const h = harness({ transcripts: ['Thanks, bye!'], replies: [() => replyOf(['Goodbye, take care!'], { endCall: true })] });
    await h.call.start();
    h.caller(true, 600);
    h.caller(false, 600);
    await h.until(() => h.log.some((l) => l.startsWith('mark:')), 'the farewell to be handed over');
    expect(h.hangups).toBe(0); // not before the carrier has played it
    expect(h.frames).toHaveLength(20);
    const mark = h.log.find((l) => l.startsWith('mark:'))?.slice(5) ?? '';
    h.call.markReached(mark);
    expect(h.hangups).toBe(1);

    // The line is closing: nothing said now starts another turn.
    h.caller(true, 600);
    h.caller(false, 600);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.log.filter((l) => l === 'reply')).toHaveLength(1);
  });

  test('without a mark from the carrier the reply still ends, by the clock', async () => {
    const h = harness({ transcripts: ['Bye'], replies: [() => replyOf(['Goodbye!'], { endCall: true })] });
    await h.call.start();
    h.caller(true, 600);
    h.caller(false, 600);
    await h.until(() => h.hangups === 1, 'the hangup after the play-out time');
  });

  test('a live engine hears continuously: its text is the turn, nothing is transcribed whole, and what it heard is accounted', async () => {
    let fed = 0;
    let disposed = false;
    const heardSeconds: number[] = [];
    const live: STTEngine = {
      live: true,
      transcribe: async () => { throw new Error('not used'); },
      async *streamTranscribe(stream) {
        let said = false;
        for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
          fed += chunk.length;
          // Text arrives while the caller is still talking.
          if (!said && fed > 16000) { said = true; yield ' Is the shop'; yield ' open today?'; }
        }
      },
      dispose: async () => { disposed = true; },
    };
    const h = harness({
      resolveStt: async () => ({ engine: live, name: 'fake-live' }),
      recordHeard: (seconds) => { heardSeconds.push(seconds); },
      replies: [() => replyOf(['Yes, until six.'])],
    });
    await h.call.start();
    h.caller(true, 1000);
    h.caller(false, 600);
    await h.until(() => h.heard.length === 1, 'the live turn');
    expect(h.heard).toEqual(['Is the shop open today?']);
    expect(h.wavs).toHaveLength(0);
    await h.until(() => h.log.some((l) => l.startsWith('mark:')), 'the reply');

    const fedBeforeReply = fed;
    expect(fedBeforeReply).toBeGreaterThan(32000); // the stream got the audio as it came
    await h.call.close();
    await h.until(() => heardSeconds.length === 1, 'the accounting');
    expect(disposed).toBe(true);
    expect(heardSeconds[0]).toBeGreaterThanOrEqual(1);
  });

  test('audio that arrives before the engine is resolved is not lost', async () => {
    let release = (_: { engine: STTEngine; name: string }) => {};
    const resolving = new Promise<{ engine: STTEngine; name: string }>((resolve) => { release = resolve; });
    const h = harness({ resolveStt: () => resolving, replies: [() => replyOf(['Hello.'])] });
    const started = h.call.start();
    h.caller(true, 600);
    h.caller(false, 600);
    expect(h.heard).toEqual([]);
    release({ engine: batchEngine(), name: 'fake-batch' });
    await started;
    await h.until(() => h.heard.length === 1, 'the early turn');
    // The whole utterance reached the transcriber: about 600 ms of speech at 16 kHz, 16-bit.
    expect(h.wavs[0].length).toBeGreaterThan(44 + 32000 * 0.6);
  });

  test('a reply that fails is not silence: the caller is told, and that line is not put on the record', async () => {
    const h = harness({ replies: [() => replyOf([], { fail: new Error('model down') })] });
    await h.call.start();
    h.caller(true, 600);
    h.caller(false, 600);
    await h.until(() => h.log.some((l) => l.startsWith('mark:')), 'the apology');
    expect(h.log.filter((l) => l.startsWith('speak:'))).toEqual(['speak:Sorry, could you repeat that?']);
    expect(h.said).toEqual([]);
  });

  test('a turn that cannot be transcribed is apologised for', async () => {
    const h = harness({ transcribe: async () => { throw new Error('engine crashed'); } });
    await h.call.start();
    h.caller(true, 600);
    h.caller(false, 600);
    await h.until(() => h.log.some((l) => l.startsWith('mark:')), 'the apology');
    expect(h.log.filter((l) => l.startsWith('speak:'))).toEqual(['speak:Sorry, could you repeat that?']);
    expect(h.log).not.toContain('reply');
  });

  test('silence and noise that is no speech start nothing', async () => {
    const h = harness({ transcripts: [''] });
    await h.call.start();
    h.caller(false, 2000);
    h.caller(true, 600); // heard, but the transcriber finds no words in it
    h.caller(false, 600);
    await h.until(() => h.wavs.length === 1, 'the transcription');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.heard).toEqual([]);
    expect(h.log).not.toContain('reply');
    expect(h.frames).toHaveLength(0);
  });

  test('no transcription engine: start fails loud', async () => {
    const h = harness({ resolveStt: async () => { throw new Error('No transcription engine can run'); } });
    await expect(h.call.start()).rejects.toThrow('No transcription engine can run');
  });

  test('closing the call cancels the reply in flight and releases its speech', async () => {
    const h = harness({ speechMs: 4000 });
    await h.call.start();
    h.caller(true, 600);
    h.caller(false, 600);
    await h.until(() => h.frames.length > 5, 'the reply to start playing');
    await h.call.close();
    const sent = h.frames.length;
    await h.until(() => h.streams.every((s) => s.released()), 'the speech streams to be released');
    expect(h.signals[0].aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.frames.length).toBe(sent);
    h.caller(true, 600); // a closed call hears nothing
    expect(h.wavs).toHaveLength(1);
  });
});
