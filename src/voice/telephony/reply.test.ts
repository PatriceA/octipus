/**
 * The phone reply — one implementation for the webhook loop and the media
 * stream: the voice topic's model, the prompt (the call's own, or the shared
 * spoken-reply directive), the history kept on the call, `[END_CALL]`.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { SPOKEN_REPLY_DIRECTIVE } from '@/shared/speech-text';

const model = vi.hoisted(() => ({
  routing: { model: 'voice-model-id', name: 'voice-row', reason: '' } as { model: string; name: string; reason: string },
  fallback: { modelId: 'default-id', name: 'default-row' } as { modelId: string; name: string } | null,
  topic: {} as { temperature?: number; maxTokens?: number },
  completions: [] as Array<Record<string, unknown>>,
  answer: 'Sure.',
  chunks: [] as string[],
  streamError: null as Error | null,
}));

vi.mock('@/core/agent/model-selector', () => ({
  ModelSelector: class { async selectForWorker(topic: string) { expect(topic).toBe('voice'); return model.routing; } },
}));
vi.mock('@/models/model-registry', () => ({ getModelRegistry: () => ({ getDefaultModel: async () => model.fallback }) }));
vi.mock('@/models/topic-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/models/topic-config')>()),
  getTopicConfig: () => ({ executorModel: null, temperature: model.topic.temperature ?? null, maxTokens: model.topic.maxTokens ?? null }),
}));
vi.mock('@/models/litellm-client', () => ({
  getLiteLLMClient: () => ({
    complete: async (options: Record<string, unknown>) => {
      model.completions.push(options);
      return { content: model.answer, usage: { totalTokens: 1 } };
    },
    async *stream(options: Record<string, unknown>) {
      model.completions.push(options);
      for (const content of model.chunks) {
        if ((options.signal as AbortSignal | undefined)?.aborted) return;
        yield { content };
      }
      if (model.streamError) throw model.streamError;
    },
  }),
}));

const {
  END_CALL_MARKER, EndCallFilter, generatePhoneReply, PHONE_HISTORY_LIMIT, phoneHistory, phoneSystemPrompt, recordAssistantTurn, recordCallerTurn, streamPhoneReply,
} = await import('./reply');

const call = (metadata: Record<string, unknown> = {}) => ({ id: 'call-1', metadata });
type Sent = { model: string; modelConfigName?: string; messages: Array<{ role: string; content: string }>; temperature?: number; maxTokens?: number; funding?: string; signal?: AbortSignal };
const sent = (index = -1) => model.completions.at(index) as unknown as Sent;

beforeEach(() => {
  model.routing = { model: 'voice-model-id', name: 'voice-row', reason: '' };
  model.fallback = { modelId: 'default-id', name: 'default-row' };
  model.topic = {};
  model.completions.length = 0;
  model.answer = 'Sure.';
  model.chunks = [];
  model.streamError = null;
});

describe('phoneSystemPrompt', () => {
  test('without a prompt of its own a call gets the shared spoken-reply directive, as a phone call, with the end-of-call rule', () => {
    const prompt = phoneSystemPrompt();
    expect(prompt).toContain(SPOKEN_REPLY_DIRECTIVE);
    expect(prompt).toContain('phone call');
    expect(prompt).toContain(END_CALL_MARKER);
  });

  test("a call's own prompt replaces the directive and keeps the end-of-call rule", () => {
    const prompt = phoneSystemPrompt('You are the front desk of Hotel Adler.');
    expect(prompt.startsWith('You are the front desk of Hotel Adler.')).toBe(true);
    expect(prompt).not.toContain(SPOKEN_REPLY_DIRECTIVE);
    expect(prompt).toContain(END_CALL_MARKER);
    // Blank is no prompt.
    expect(phoneSystemPrompt('  ')).toBe(phoneSystemPrompt());
  });
});

describe('generatePhoneReply', () => {
  test('asks the voice topic model with the prompt and the history, and records both turns on the call', async () => {
    const c = call({ conversationHistory: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello.' }] });
    const reply = await generatePhoneReply(c, 'What time is it?');
    expect(reply).toEqual({ text: 'Sure.', endCall: false });
    expect(sent().model).toBe('voice-model-id');
    expect(sent().modelConfigName).toBe('voice-row');
    expect(sent().funding).toBe('install');
    expect(sent().messages.map((m) => [m.role, m.content])).toEqual([
      ['system', phoneSystemPrompt()],
      ['user', 'Hi'], ['assistant', 'Hello.'], ['user', 'What time is it?'],
    ]);
    expect(c.metadata.conversationHistory).toEqual([
      { role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello.' },
      { role: 'user', content: 'What time is it?' }, { role: 'assistant', content: 'Sure.' },
    ]);
  });

  test("the call's expert prompt is the system prompt", async () => {
    await generatePhoneReply(call({ expertPrompt: 'You are the front desk.' }), 'Hello');
    expect(sent().messages[0].content).toBe(phoneSystemPrompt('You are the front desk.'));
  });

  test("the voice topic's temperature and max tokens override the phone defaults", async () => {
    await generatePhoneReply(call(), 'Hello');
    expect([sent().temperature, sent().maxTokens]).toEqual([0.7, 256]);
    model.topic = { temperature: 0.2, maxTokens: 90 };
    await generatePhoneReply(call(), 'Hello');
    expect([sent().temperature, sent().maxTokens]).toEqual([0.2, 90]);
  });

  test('[END_CALL] is reported and never part of what is said or remembered', async () => {
    model.answer = `Goodbye, have a nice day! ${END_CALL_MARKER}`;
    const c = call();
    expect(await generatePhoneReply(c, 'Bye')).toEqual({ text: 'Goodbye, have a nice day!', endCall: true });
    expect(phoneHistory(c).at(-1)).toEqual({ role: 'assistant', content: 'Goodbye, have a nice day!' });
  });

  test('the history is capped: the oldest turns go', async () => {
    const c = call({ conversationHistory: Array.from({ length: PHONE_HISTORY_LIMIT }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i}` })) });
    await generatePhoneReply(c, 'latest');
    const history = phoneHistory(c);
    expect(history).toHaveLength(PHONE_HISTORY_LIMIT);
    expect(history[0].content).toBe('turn 2');
    expect(history.slice(-2).map((t) => t.content)).toEqual(['latest', 'Sure.']);
  });

  test('no model on the voice topic: the default model answers; none at all fails loud', async () => {
    model.routing = { model: '', name: '', reason: 'unmapped' };
    await generatePhoneReply(call(), 'Hello');
    expect(sent().model).toBe('default-id');
    model.fallback = null;
    await expect(generatePhoneReply(call(), 'Hello')).rejects.toThrow(/voice topic/);
  });

  test("two turns of one call posted at once are answered one after the other, each with the other's history", async () => {
    const c = call();
    const [first, second] = await Promise.all([generatePhoneReply(c, 'one'), generatePhoneReply(c, 'two')]);
    expect([first.text, second.text]).toEqual(['Sure.', 'Sure.']);
    expect(phoneHistory(c).map((t) => t.content)).toEqual(['one', 'Sure.', 'two', 'Sure.']);
    expect(sent(-1).messages.map((m) => m.content).slice(1)).toEqual(['one', 'Sure.', 'two']);
  });

  test('a turn that fails does not block the next one', async () => {
    const c = call();
    model.fallback = null;
    model.routing = { model: '', name: '', reason: '' };
    await expect(generatePhoneReply(c, 'one')).rejects.toThrow();
    model.routing = { model: 'voice-model-id', name: 'voice-row', reason: '' };
    await expect(generatePhoneReply(c, 'two')).resolves.toEqual({ text: 'Sure.', endCall: false });
  });
});

describe('history', () => {
  test('what the caller says in two breaths before any reply is one turn', () => {
    const c = call();
    recordCallerTurn(c, "What's the weather");
    recordCallerTurn(c, 'in Berlin tomorrow?');
    expect(phoneHistory(c)).toEqual([{ role: 'user', content: "What's the weather in Berlin tomorrow?" }]);
    recordAssistantTurn(c, 'Sunny.');
    recordAssistantTurn(c, '');
    recordCallerTurn(c, 'Thanks');
    expect(phoneHistory(c).map((t) => t.role)).toEqual(['user', 'assistant', 'user']);
  });
});

describe('EndCallFilter', () => {
  test('removes the marker even when it arrives split across deltas', () => {
    const filter = new EndCallFilter();
    const out = ['Bye! ', '[END', '_CA', 'LL]'].map((d) => filter.push(d)).join('') + filter.flush();
    expect(out).toBe('Bye! ');
    expect(filter.endCall).toBe(true);
  });

  test('text that only looked like the start of the marker is released', () => {
    const filter = new EndCallFilter();
    const out = ['See item [', 'END of list] and [E', 'N'].map((d) => filter.push(d)).join('') + filter.flush();
    expect(out).toBe('See item [END of list] and [EN');
    expect(filter.endCall).toBe(false);
  });
});

describe('streamPhoneReply', () => {
  const read = async (stream: AsyncIterable<string>) => { let text = ''; for await (const delta of stream) text += delta; return text; };

  test('streams the reply to the history as it stands, without the marker, and reports the end of the call', async () => {
    model.chunks = ['Good', 'bye then. ', '[END_', 'CALL]'];
    const c = call({ expertPrompt: 'You are the front desk.' });
    recordCallerTurn(c, 'Bye');
    const stream = streamPhoneReply(c);
    expect(stream.endCall).toBe(false);
    expect(await read(stream)).toBe('Goodbye then. ');
    expect(stream.endCall).toBe(true);
    expect(sent().model).toBe('voice-model-id');
    expect(sent().messages.map((m) => [m.role, m.content])).toEqual([['system', phoneSystemPrompt('You are the front desk.')], ['user', 'Bye']]);
  });

  test('does not record the reply: the reader knows how much of it was heard', async () => {
    model.chunks = ['Hello there.'];
    const c = call();
    recordCallerTurn(c, 'Hi');
    await read(streamPhoneReply(c));
    expect(phoneHistory(c)).toEqual([{ role: 'user', content: 'Hi' }]);
  });

  test('the abort signal reaches the model call and stops the stream', async () => {
    model.chunks = ['one ', 'two ', 'three'];
    const c = call();
    recordCallerTurn(c, 'Hi');
    const abort = new AbortController();
    let text = '';
    for await (const delta of streamPhoneReply(c, { signal: abort.signal })) {
      text += delta;
      abort.abort();
    }
    expect(text).toBe('one ');
    expect(sent().signal).toBe(abort.signal);
  });

  test('a model failure reaches the reader', async () => {
    model.chunks = ['Hel'];
    model.streamError = new Error('upstream 500');
    const c = call();
    recordCallerTurn(c, 'Hi');
    await expect(read(streamPhoneReply(c))).rejects.toThrow('upstream 500');
  });
});
