/**
 * A voice conversation on the server (src/voice/session.ts), with fake ears
 * and a fake mouth: what is heard becomes utterances, and a reply is spoken
 * sentence by sentence while it is still being written.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { SpeechStream } from './resolve';
import { unspoken, type VoiceOut, VoiceSession, type VoiceSessionDeps, type VoiceTurnEvent } from './session';
import type { STTEngine } from './stt';

const SESSION = '11111111-2222-3333-4444-555555555555';

function audio(ms: number, level: number): Uint8Array {
  const n = Math.round((ms / 1000) * 16000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(Math.sin((2 * Math.PI * 220 * i) / 16000) * level * 32767);
  return new Uint8Array(out.buffer);
}

interface Rig {
  session: VoiceSession;
  sent: Array<{ message: VoiceOut; binary?: Buffer }>;
  emit(event: Omit<VoiceTurnEvent, 'sessionId' | 'userId'> & Partial<VoiceTurnEvent>): void;
  spokenTexts: string[];
  transcribed: Buffer[];
  types(): string[];
  audioTexts(): string[];
  wait(predicate: () => boolean): Promise<void>;
}

async function rig(opts: {
  engine?: Partial<STTEngine> & { live?: boolean };
  transcribe?: (wav: Buffer) => Promise<string>;
  speak?: (text: string) => Promise<SpeechStream>;
  speakEnabled?: boolean;
  audio?: 'pcm' | 'wav';
} = {}): Promise<Rig> {
  const sent: Rig['sent'] = [];
  const spokenTexts: string[] = [];
  const transcribed: Buffer[] = [];
  let handler: ((event: VoiceTurnEvent) => void) | null = null;
  const engine: STTEngine = {
    live: false,
    transcribe: async () => ({ text: '', segments: [], language: 'en', duration: 0 }),
    streamTranscribe: async function* () {},
    dispose: async () => {},
    ...opts.engine,
  };
  const deps: VoiceSessionDeps = {
    resolveStt: async () => ({ engine, name: 'test-engine' }),
    transcribe: async (wav) => { transcribed.push(wav); return opts.transcribe ? opts.transcribe(wav) : 'what is the weather'; },
    speak: opts.speak ?? (async (text) => {
      spokenTexts.push(text);
      return { model: 'tts', sampleRate: 16000, chunks: (async function* () { yield Buffer.alloc(3200); })() };
    }),
    subscribe: (h) => { handler = h; return () => { handler = null; }; },
  };
  const session = new VoiceSession(
    { userId: 'u1', sessionId: SESSION, speak: opts.speakEnabled ?? true, audio: opts.audio ?? 'pcm', endpointer: { silenceMs: 400 }, partials: false },
    deps,
    (message, binary) => { sent.push({ message, binary }); },
  );
  await session.start();
  const r: Rig = {
    session, sent, spokenTexts, transcribed,
    emit: (event) => handler?.({ sessionId: SESSION, userId: 'u1', ...event }),
    types: () => sent.map((s) => s.message.type),
    audioTexts: () => sent.flatMap((s) => (s.message.type === 'audio' && s.message.text ? [s.message.text] : [])),
    wait: async (predicate) => {
      for (let i = 0; i < 200 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
      if (!predicate()) throw new Error(`timed out; sent: ${JSON.stringify(sent.map((s) => s.message))}`);
    },
  };
  return r;
}

const open: VoiceSession[] = [];
afterEach(async () => { for (const s of open.splice(0)) await s.close(); vi.useRealTimers(); });
const track = (r: Rig) => { open.push(r.session); return r; };

describe('ears', () => {
  test('a batch engine transcribes each turn whole, once, when the server hears it end', async () => {
    const r = track(await rig());
    expect(r.sent[0].message).toEqual({ type: 'ready', mode: 'conversation', engine: 'test-engine', live: false, speak: true });
    r.session.pushAudio(audio(300, 0));
    r.session.pushAudio(audio(900, 0.3));
    expect(r.types()).toContain('speech_start');
    expect(r.transcribed).toHaveLength(0); // still talking
    r.session.pushAudio(audio(600, 0));
    await r.wait(() => r.types().includes('utterance'));
    expect(r.sent.find((s) => s.message.type === 'utterance')?.message).toEqual({ type: 'utterance', text: 'what is the weather' });
    expect(r.transcribed).toHaveLength(1);
    expect(r.transcribed[0].subarray(0, 4).toString()).toBe('RIFF');
  });

  test('a live engine hears continuously; its text is cut where the turn ends', async () => {
    let push: (text: string) => void = () => {};
    let ended = false;
    const engine = {
      live: true,
      streamTranscribe: async function* (stream: ReadableStream<Uint8Array>) {
        const queue: string[] = [];
        push = (text) => queue.push(text);
        const reader = stream.getReader();
        void (async () => { for (;;) { const { done } = await reader.read(); if (done) { ended = true; return; } } })();
        while (!ended) {
          while (queue.length) yield queue.shift()!;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      },
    };
    const r = track(await rig({ engine }));
    expect(r.sent[0].message).toMatchObject({ live: true });
    r.session.pushAudio(audio(300, 0));
    r.session.pushAudio(audio(700, 0.3));
    push('turn on');
    push(' the lights');
    r.session.pushAudio(audio(600, 0));
    await r.wait(() => r.types().includes('utterance'));
    expect(r.sent.find((s) => s.message.type === 'utterance')?.message).toEqual({ type: 'utterance', text: 'turn on the lights' });
    expect(r.transcribed).toHaveLength(0); // never the batch path

    // The second turn holds only what was said after the first.
    r.session.pushAudio(audio(700, 0.3));
    push(' and close the door');
    r.session.pushAudio(audio(600, 0));
    await r.wait(() => r.types().filter((t) => t === 'utterance').length === 2);
    expect(r.sent.filter((s) => s.message.type === 'utterance')[1].message).toEqual({ type: 'utterance', text: 'and close the door' });
  });

  test('silence and a turn nothing was heard in produce no utterance', async () => {
    const r = track(await rig({ transcribe: async () => '   ' }));
    r.session.pushAudio(audio(1500, 0));
    r.session.pushAudio(audio(600, 0.3));
    r.session.pushAudio(audio(600, 0));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(r.types()).not.toContain('utterance');
  });
});

describe('mouth', () => {
  const hear = async (r: Rig) => {
    r.session.pushAudio(audio(300, 0));
    r.session.pushAudio(audio(700, 0.3));
    r.session.pushAudio(audio(600, 0));
    await r.wait(() => r.types().includes('utterance'));
  };

  test('the reply is spoken sentence by sentence while it is still being written', async () => {
    const r = track(await rig());
    await hear(r);
    r.emit({ type: 'chat.delta', payload: { delta: 'It is sunny in Berlin today. The high', iteration: 1 } });
    // The first sentence is spoken before the reply is complete.
    await r.wait(() => r.audioTexts().length === 1);
    expect(r.audioTexts()).toEqual(['It is sunny in Berlin today.']);
    const first = r.sent.find((s) => s.message.type === 'audio')!;
    expect(first.message).toMatchObject({ format: 'pcm', sampleRate: 16000, ms: 100, seq: 0 });
    expect(first.binary).toHaveLength(3200);

    r.emit({ type: 'chat.delta', payload: { delta: ' is 24 degrees.', iteration: 1 } });
    r.emit({ type: 'chat.response', payload: { response: { response: 'It is sunny in Berlin today. The high is 24 degrees.\n\n_Sources: weather_' } } });
    await r.wait(() => r.audioTexts().length === 2);
    // The final answer adds nothing to what streamed: nothing is said twice, and the sources are not read.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(r.audioTexts()).toEqual(['It is sunny in Berlin today.', 'The high is 24 degrees.']);
    expect(r.types().filter((t) => t === 'speaking')).toHaveLength(1); // on once; off when played
  });

  test('a reply that did not stream is spoken from its final text', async () => {
    const r = track(await rig());
    await hear(r);
    r.emit({ type: 'chat.response', payload: { response: { response: '**Sure.** I can do that for you. Shall I start?' } } });
    await r.wait(() => r.audioTexts().length === 2);
    expect(r.audioTexts()).toEqual(['Sure. I can do that for you.', 'Shall I start?']);
  });

  test('what the model says before using a tool is spoken, then the answer; a later typed turn is not', async () => {
    const r = track(await rig());
    await hear(r);
    r.emit({ type: 'chat.delta', payload: { delta: 'Let me look that up', iteration: 1 } });
    r.emit({ type: 'chat.delta', payload: { delta: 'The train leaves at nine.', iteration: 2 } });
    r.emit({ type: 'chat.response', payload: { response: { response: 'The train leaves at nine.' } } });
    await r.wait(() => r.audioTexts().length === 2);
    expect(r.audioTexts()).toEqual(['Let me look that up', 'The train leaves at nine.']);

    // Not a reply to something said: the person typed, and reads.
    r.emit({ type: 'chat.delta', payload: { delta: 'A typed question gets a written answer. ', iteration: 1 } });
    r.emit({ type: 'chat.response', payload: { response: { response: 'A typed question gets a written answer.' } } });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(r.audioTexts()).toHaveLength(2);
  });

  test('another chat, and another user, are never spoken here', async () => {
    const r = track(await rig());
    await hear(r);
    r.emit({ type: 'chat.response', sessionId: '99999999-2222-3333-4444-555555555555', payload: { response: { response: 'Not this conversation at all.' } } });
    r.emit({ type: 'chat.response', userId: 'someone-else', payload: { response: { response: 'Not this person at all.' } } });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(r.audioTexts()).toEqual([]);
  });

  test('talking over the reply stops it: what was queued is dropped and the over-talk is the next turn', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started: string[] = [];
    const returned: string[] = [];
    const r = track(await rig({
      speak: async (text) => {
        started.push(text);
        const source = (async function* () { yield Buffer.alloc(3200); await gate; yield Buffer.alloc(3200); })();
        // As the lane's stream does: closing it releases the engine even when nobody started reading.
        const chunks: SpeechStream['chunks'] = {
          [Symbol.asyncIterator]() { return this; },
          next: () => source.next(),
          return: async () => { returned.push(text); await source.return(undefined); return { done: true, value: undefined }; },
        };
        return { model: 'tts', sampleRate: 16000, chunks };
      },
    }));
    await hear(r);
    r.emit({ type: 'chat.response', payload: { response: { response: 'This is the first sentence. This is the second sentence. This is the third sentence.' } } });
    await r.wait(() => r.audioTexts().length === 1);
    expect(started).toEqual(['This is the first sentence.', 'This is the second sentence.']); // the next one already in flight

    // Loud, sustained speech while the reply plays.
    r.session.pushAudio(audio(700, 0.5));
    expect(r.types()).toContain('barge_in');
    release();
    r.session.pushAudio(audio(600, 0));
    await r.wait(() => r.types().filter((t) => t === 'utterance').length === 2);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(r.audioTexts()).toEqual(['This is the first sentence.']); // nothing after the interruption
    expect([...new Set(returned)].sort()).toEqual(['This is the first sentence.', 'This is the second sentence.']); // both streams closed
    expect(r.sent.filter((s) => s.message.type === 'speaking').map((s) => (s.message as { on: boolean }).on)).toEqual([true, false]);
  });

  test('wav mode sends one clip per sentence; a narration line is spoken; a failed engine is an error, not silence', async () => {
    const r = track(await rig({ audio: 'wav' }));
    r.emit({ type: 'voice.speak', payload: { text: 'On it — the researcher has started.' } });
    await r.wait(() => r.audioTexts().length === 1);
    const clip = r.sent.find((s) => s.message.type === 'audio')!;
    expect(clip.message).toMatchObject({ format: 'wav', ms: 100, text: 'On it — the researcher has started.' });
    expect(clip.binary!.subarray(0, 4).toString()).toBe('RIFF');

    const failing = track(await rig({ speak: async () => { throw new Error('Speech synthesis failed: vox: 503'); } }));
    failing.session.say('Hello there, this will not work.');
    await failing.wait(() => failing.types().includes('error'));
    expect(failing.sent.find((s) => s.message.type === 'error')?.message).toEqual({ type: 'error', message: 'Speech synthesis failed: vox: 503' });
  });

  test('with speaking off the session only listens', async () => {
    const r = track(await rig({ speakEnabled: false }));
    await hear(r);
    r.emit({ type: 'chat.response', payload: { response: { response: 'This would have been spoken aloud.' } } });
    r.session.say('Nor this.');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(r.spokenTexts).toEqual([]);
  });
});

describe('what the final answer adds to what was already spoken', () => {
  test('nothing when it is what streamed; the rest when the stream stopped short; all of it when it was replaced', () => {
    expect(unspoken('The train leaves at nine.', 'The train leaves at nine.')).toEqual([]);
    expect(unspoken('The train leaves at nine.\n\n_Sources: db_', 'The train leaves at nine.')).toEqual([]);
    expect(unspoken('The train leaves at nine. It arrives at noon in Hamburg.', 'The train leaves at nine.')).toEqual(['It arrives at noon in Hamburg.']);
    expect(unspoken('I cannot help with that request.', 'Here is how you would do it step by step.')).toEqual(['I cannot help with that request.']);
    expect(unspoken('Hello there, how can I help?', '')).toEqual(['Hello there, how can I help?']);
  });
});
