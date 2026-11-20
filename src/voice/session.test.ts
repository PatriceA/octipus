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

/** A spoken turn's streamed text and result, as the gateway publishes them (agent `a1` unless said). */
const delta = (text: string, iteration = 1, agentId = 'a1', spoken = true) =>
  ({ type: 'chat.delta', payload: { agentId, delta: text, iteration, ...(spoken ? { spoken: true } : {}) } });
const result = (text: string, agentId: string | undefined = 'a1', spoken = true) =>
  ({ type: 'chat.response', payload: { response: { response: text, ...(agentId ? { agentId } : {}), ...(spoken ? { spoken: true } : {}) } } });

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

  test('an engine that transcribes whole turns is warmed when the conversation opens, before anyone speaks', async () => {
    const warm = vi.fn(async () => {});
    const session = new VoiceSession(
      { userId: 'u1', sessionId: SESSION, speak: false, audio: 'pcm', partials: false },
      {
        resolveStt: async () => ({ engine: { live: false, transcribe: async () => ({ text: '', segments: [], language: 'en', duration: 0 }), streamTranscribe: async function* () {}, dispose: async () => {} }, name: 'batch' }),
        transcribe: async () => '', speak: async () => { throw new Error('unused'); }, subscribe: () => () => {}, warmUp: warm,
      },
      () => {},
    );
    open.push(session);
    await session.start();
    expect(warm).toHaveBeenCalledTimes(1);
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
    r.emit(delta('It is sunny in Berlin today. The high', 1));
    // The first sentence is spoken before the reply is complete.
    await r.wait(() => r.audioTexts().length === 1);
    expect(r.audioTexts()).toEqual(['It is sunny in Berlin today.']);
    const first = r.sent.find((s) => s.message.type === 'audio')!;
    expect(first.message).toMatchObject({ format: 'pcm', sampleRate: 16000, ms: 100, seq: 0 });
    expect(first.binary).toHaveLength(3200);

    r.emit(delta(' is 24 degrees.', 1));
    r.emit(result('It is sunny in Berlin today. The high is 24 degrees.\n\n_Sources: weather_'));
    await r.wait(() => r.audioTexts().length === 2);
    // The final answer adds nothing to what streamed: nothing is said twice, and the sources are not read.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(r.audioTexts()).toEqual(['It is sunny in Berlin today.', 'The high is 24 degrees.']);
    expect(r.types().filter((t) => t === 'speaking')).toHaveLength(1); // on once; off when played
  });

  test('a reply that did not stream is spoken from its final text', async () => {
    const r = track(await rig());
    await hear(r);
    r.emit(result('**Sure.** I can do that for you. Shall I start?'));
    await r.wait(() => r.audioTexts().length === 2);
    expect(r.audioTexts()).toEqual(['Sure. I can do that for you.', 'Shall I start?']);
  });

  test('what the model says before using a tool is spoken, then the answer; a later typed turn is not', async () => {
    const r = track(await rig());
    await hear(r);
    r.emit(delta('Let me look that up', 1));
    r.emit(delta('The train leaves at nine.', 2));
    r.emit(result('The train leaves at nine.'));
    await r.wait(() => r.audioTexts().length === 2);
    expect(r.audioTexts()).toEqual(['Let me look that up', 'The train leaves at nine.']);

    // Not a reply to something said: the person typed, and reads.
    r.emit(delta('A typed question gets a written answer. ', 1, 'a2', false));
    r.emit(result('A typed question gets a written answer.', 'a2', false));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(r.audioTexts()).toHaveLength(2);
  });

  test('another chat, and another user, are never spoken here', async () => {
    const r = track(await rig());
    await hear(r);
    r.emit({ type: 'chat.response', sessionId: '99999999-2222-3333-4444-555555555555', payload: { response: { response: 'Not this conversation at all.', spoken: true } } });
    r.emit({ type: 'chat.response', userId: 'someone-else', payload: { response: { response: 'Not this person at all.', spoken: true } } });
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
    r.emit(result('This is the first sentence. This is the second sentence. This is the third sentence.'));
    await r.wait(() => r.audioTexts().length === 1);
    expect(started).toEqual(['This is the first sentence.', 'This is the second sentence.']); // the next one already in flight

    // Loud, sustained speech while the reply plays.
    r.session.pushAudio(audio(700, 0.5));
    expect(r.types().filter((t) => t === 'barge_in')).toHaveLength(1); // one interruption, said once
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

  test('a narration line fills a silence; once the answer is being written it does not cut in', async () => {
    const r = track(await rig());
    await hear(r);
    r.emit({ type: 'voice.speak', payload: { text: 'On it — the researcher has started.' } });
    await r.wait(() => r.audioTexts().length === 1);
    r.emit(delta('The report is ready and has three sections. ', 1));
    r.emit({ type: 'voice.speak', payload: { text: 'The researcher just finished.' } });
    r.emit(result('The report is ready and has three sections.'));
    await r.wait(() => r.audioTexts().length === 2);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(r.audioTexts()).toEqual(['On it — the researcher has started.', 'The report is ready and has three sections.']);
  });

  test('with speaking off the session only listens', async () => {
    const r = track(await rig({ speakEnabled: false }));
    await hear(r);
    r.emit(result('This would have been spoken aloud.'));
    r.session.say('Nor this.');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(r.spokenTexts).toEqual([]);
  });
});

describe('which reply is heard', () => {
  /** A speech engine whose sentences each take a moment, so a reply is still playing when the person talks. */
  const slow = (spokenTexts: string[], returned: string[] = []) => async (text: string): Promise<SpeechStream> => {
    spokenTexts.push(text);
    const source = (async function* () { yield Buffer.alloc(3200); await new Promise((resolve) => setTimeout(resolve, 40)); yield Buffer.alloc(3200); })();
    const chunks: SpeechStream['chunks'] = {
      [Symbol.asyncIterator]() { return this; },
      next: () => source.next(),
      return: async () => { returned.push(text); await source.return(undefined); return { done: true, value: undefined }; },
    };
    return { model: 'tts', sampleRate: 16000, chunks };
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 120));

  test('two spoken turns in a row: each reply is heard once, in order', async () => {
    const r = track(await rig());
    r.emit(delta('Reply one. More of', 1, 'a1'));
    r.emit(delta(' one.', 1, 'a1'));
    r.emit(result('Reply one. More of one.', 'a1'));
    r.emit(delta('Reply two.', 1, 'a2'));
    r.emit(result('Reply two.', 'a2'));
    await r.wait(() => r.audioTexts().length === 3);
    await settle();
    expect(r.audioTexts()).toEqual(['Reply one.', 'More of one.', 'Reply two.']);
  });

  test('talking over a reply, then the next turn: the rest of the old reply is never heard, the new one is', async () => {
    const spokenTexts: string[] = [];
    const r = track(await rig({ speak: slow(spokenTexts) }));
    r.emit(delta('The weather is sunny today. It will be warm. ', 1, 'a1'));
    await r.wait(() => r.audioTexts().length === 1);
    r.session.pushAudio(audio(700, 0.5)); // over-talk
    expect(r.types()).toContain('barge_in');
    // The old turn goes on writing (its message was queued, not steered) and ends.
    r.emit(delta('Tomorrow brings rain.', 1, 'a1'));
    r.emit(result('The weather is sunny today. It will be warm. Tomorrow brings rain.', 'a1'));
    // The turn for what was said over it.
    r.emit(delta('Sure, here is the forecast for Monday.', 1, 'a2'));
    r.emit(result('Sure, here is the forecast for Monday.', 'a2'));
    r.session.pushAudio(audio(600, 0));
    await r.wait(() => r.audioTexts().includes('Sure, here is the forecast for Monday.'));
    await settle();
    expect(r.audioTexts()).toEqual(['The weather is sunny today.', 'Sure, here is the forecast for Monday.']);
  });

  test('what was said over a reply is steered into the running turn: its next model call, which heard it, is spoken', async () => {
    const spokenTexts: string[] = [];
    const r = track(await rig({ speak: slow(spokenTexts) }));
    r.emit(delta('The weather is sunny today. It will be warm. ', 1, 'a1'));
    await r.wait(() => r.audioTexts().length === 1);
    r.session.pushAudio(audio(700, 0.5));
    r.session.pushAudio(audio(600, 0));
    r.emit({ type: 'chat.message', payload: { role: 'user', content: 'what about Monday', injected: true, spoken: true } });
    r.emit(delta('Tomorrow brings rain.', 1, 'a1')); // still the call that did not hear it
    r.emit(delta('On Monday it clears up.', 2, 'a1'));
    r.emit(result('On Monday it clears up.', 'a1'));
    await r.wait(() => r.audioTexts().includes('On Monday it clears up.'));
    await settle();
    expect(r.audioTexts()).toEqual(['The weather is sunny today.', 'On Monday it clears up.']);
  });

  test('a spoken message steered into a typed turn makes the turn spoken from its next model call', async () => {
    const r = track(await rig());
    r.emit(delta('Here is a long written answer. ', 1, 'a1', false));
    r.emit({ type: 'chat.message', payload: { role: 'user', content: 'read me the gist', injected: true, spoken: true } });
    r.emit(delta('The gist is simple.', 2, 'a1', true));
    r.emit(result('The gist is simple.', 'a1', true));
    await r.wait(() => r.audioTexts().length === 1);
    await settle();
    expect(r.audioTexts()).toEqual(['The gist is simple.']);
  });

  test('a failed turn ends there: the next typed reply in the chat is not read aloud', async () => {
    const r = track(await rig());
    r.emit(delta('Let me check the calendar', 1, 'a1'));
    r.emit({ type: 'chat.error', payload: { error: 'model unavailable' } });
    r.emit(delta('A typed reply. ', 1, 'a2', false));
    r.emit(result('A typed reply.', 'a2', false));
    // A background reply nobody asked to hear is not read either.
    r.emit(result('Your reminder fired.', undefined, false));
    await r.wait(() => r.audioTexts().length === 1);
    await settle();
    expect(r.audioTexts()).toEqual(['Let me check the calendar']);
  });

  test('expect_reply speaks the next turn although it was typed, and only that one', async () => {
    const r = track(await rig());
    r.session.expectReply();
    r.emit(delta('Read this one. ', 1, 'a1', false));
    r.emit(result('Read this one.', 'a1', false));
    r.emit(delta('Not this one. ', 1, 'a2', false));
    r.emit(result('Not this one.', 'a2', false));
    await r.wait(() => r.audioTexts().length === 1);
    await settle();
    expect(r.audioTexts()).toEqual(['Read this one.']);
  });

  test('the person starting to talk before a reply is heard drops it; a reply waits while they talk', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started: string[] = [];
    const r = track(await rig({ speak: async (text) => { started.push(text); await gate; return { model: 'tts', sampleRate: 16000, chunks: (async function* () { yield Buffer.alloc(3200); })() }; } }));
    r.emit(delta('A reply still being synthesised. And more', 1, 'a1'));
    await r.wait(() => started.length === 1);
    r.session.pushAudio(audio(300, 0));
    r.session.pushAudio(audio(300, 0.3)); // speech starts while the sentence is synthesised
    expect(r.types()).toContain('barge_in');
    release();
    await settle();
    expect(r.audioTexts()).toEqual([]);

    // A new reply that is ready while the person still talks waits for them.
    r.emit(delta('Spoken once you are done.', 1, 'a2'));
    r.emit(result('Spoken once you are done.', 'a2'));
    await settle();
    expect(r.audioTexts()).toEqual([]);
    r.session.pushAudio(audio(600, 0));
    await r.wait(() => r.audioTexts().length === 1);
    expect(r.audioTexts()).toEqual(['Spoken once you are done.']);
  });

  test('one failed sentence ends that reply: the rest is not tried again and again', async () => {
    const tried: string[] = [];
    const r = track(await rig({ speak: async (text) => { tried.push(text); throw new Error('vox: 503'); } }));
    r.emit(delta('First sentence here. Second sentence here. ', 1, 'a1'));
    await r.wait(() => r.types().includes('error'));
    r.emit(delta('Third sentence here.', 1, 'a1'));
    r.emit(result('First sentence here. Second sentence here. Third sentence here.', 'a1'));
    await settle();
    // The sentence that failed (and at most the one already in flight), never what came after.
    expect(tried[0]).toBe('First sentence here.');
    expect(tried).not.toContain('Third sentence here.');
    expect(r.types().filter((t) => t === 'error')).toHaveLength(1);
  });
});

describe('looks before the turn ends', () => {
  const look = async (local: boolean) => {
    const calls: Array<{ interim?: boolean } | undefined> = [];
    const session = new VoiceSession(
      { userId: 'u1', sessionId: SESSION, speak: false, audio: 'pcm', partials: true },
      {
        resolveStt: async () => ({ engine: { live: false, transcribe: async () => ({ text: '', segments: [], language: 'en', duration: 0 }), streamTranscribe: async function* () {}, dispose: async () => {} }, name: 'batch', local }),
        transcribe: async (_wav, options) => { calls.push(options); return 'hello'; }, speak: async () => { throw new Error('unused'); }, subscribe: () => () => {},
      },
      () => {},
    );
    open.push(session);
    await session.start();
    session.pushAudio(audio(300, 0));
    session.pushAudio(audio(2500, 0.3));
    await new Promise((resolve) => setTimeout(resolve, 30));
    return calls;
  };

  test('a local batch engine looks at the turn so far, uncounted; a hosted one is not asked until the turn ends', async () => {
    const local = await look(true);
    expect(local.length).toBeGreaterThan(0);
    expect(local.every((options) => options?.interim === true)).toBe(true);
    expect(await look(false)).toEqual([]);
  });
});

describe('a live engine the chat no longer allows', () => {
  test('is closed at the end of a turn, and later turns go through the lane', async () => {
    let push: (text: string) => void = () => {};
    let ended = false;
    let allowed = true;
    const transcribed: Buffer[] = [];
    const sent: VoiceOut[] = [];
    const engine: STTEngine = {
      live: true,
      transcribe: async () => ({ text: '', segments: [], language: 'en', duration: 0 }),
      dispose: async () => {},
      streamTranscribe: async function* (stream: ReadableStream<Uint8Array>) {
        const queue: string[] = [];
        push = (text) => queue.push(text);
        const reader = stream.getReader();
        void (async () => { for (;;) { const { done } = await reader.read(); if (done) { ended = true; return; } } })();
        while (!ended) { while (queue.length) yield queue.shift()!; await new Promise((resolve) => setTimeout(resolve, 5)); }
      },
    };
    const session = new VoiceSession(
      { userId: 'u1', sessionId: SESSION, speak: false, audio: 'pcm', endpointer: { silenceMs: 400 }, partials: false },
      {
        resolveStt: async () => ({ engine, name: 'cloud-live' }),
        transcribe: async (wav) => { transcribed.push(wav); return 'second turn'; },
        speak: async () => { throw new Error('unused'); }, subscribe: () => () => {},
        mayKeepListening: async () => allowed,
      },
      (message) => { sent.push(message); },
    );
    open.push(session);
    await session.start();
    allowed = false; // the chat's level was raised
    session.pushAudio(audio(300, 0));
    session.pushAudio(audio(700, 0.3));
    push('first turn');
    session.pushAudio(audio(600, 0));
    for (let i = 0; i < 200 && !sent.some((m) => m.type === 'error'); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sent.find((m) => m.type === 'error')).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(ended).toBe(true);

    session.pushAudio(audio(700, 0.3));
    session.pushAudio(audio(600, 0));
    for (let i = 0; i < 200 && transcribed.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(transcribed).toHaveLength(1);
    expect(sent.filter((m) => m.type === 'utterance').map((m) => (m as { text: string }).text)).toEqual(['first turn', 'second turn']);
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
