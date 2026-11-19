/**
 * Lines of a call in the install's own voice: held briefly for the carrier
 * to fetch, and the choice between the install's voice (`audioUrl` → <Play>)
 * and the carrier's (text → <Say>).
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

const speech = vi.hoisted(() => ({
  available: true,
  format: 'mp3' as string,
  fail: null as Error | null,
  spoken: [] as Array<{ text: string; format?: string }>,
}));

vi.mock('../resolve', () => ({
  speechStatus: async () => ({ available: speech.available, model: 'tts', engine: 'kokoro', local: true, reason: null }),
  synthesizeWithLane: async (text: string, req: { format?: string }) => {
    speech.spoken.push({ text, format: req.format });
    if (speech.fail) throw speech.fail;
    return { audio: Buffer.from(`audio:${text}`), format: speech.format, contentType: speech.format === 'mp3' ? 'audio/mpeg' : `audio/${speech.format}`, model: 'tts' };
  },
}));

const { CallAudioStore, getCallAudioStore, prepareSpokenLine } = await import('./audio-store');

const BASE = 'https://voice.example.org/api/voice/webhook/audio';

beforeEach(() => {
  speech.available = true;
  speech.format = 'mp3';
  speech.fail = null;
  speech.spoken.length = 0;
});

describe('CallAudioStore', () => {
  test('a clip is served under a 128-bit random id until it expires', () => {
    let now = 0;
    const store = new CallAudioStore(() => now, 1000);
    const id = store.put(Buffer.from('abc'), 'audio/mpeg');
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(store.put(Buffer.from('abc'), 'audio/mpeg')).not.toBe(id);
    expect(store.get(id)).toEqual({ audio: Buffer.from('abc'), contentType: 'audio/mpeg' });
    now = 999;
    expect(store.get(id)).not.toBeNull();
    now = 1000;
    expect(store.get(id)).toBeNull();
    expect(store.get('unknown')).toBeNull();
  });

  test('the store is bounded: the oldest clips make room, and a clip larger than all of it is refused', () => {
    const store = new CallAudioStore(() => 0, 60_000, 10);
    const first = store.put(Buffer.alloc(4), 'audio/wav');
    const second = store.put(Buffer.alloc(4), 'audio/wav');
    const third = store.put(Buffer.alloc(4), 'audio/wav');
    expect(store.get(first)).toBeNull();
    expect(store.get(second)).not.toBeNull();
    expect(store.get(third)).not.toBeNull();
    expect(() => store.put(Buffer.alloc(11), 'audio/wav')).toThrow(/larger than/);
  });
});

describe('prepareSpokenLine', () => {
  test("with a Speech engine and a public URL the line is the install's voice, played from a URL that serves it", async () => {
    const line = await prepareSpokenLine('**Hello** there', BASE);
    expect(line.text).toBe('Hello there');
    expect(speech.spoken).toEqual([{ text: 'Hello there', format: 'mp3' }]);
    expect(line.audioUrl?.startsWith(`${BASE}/`)).toBe(true);
    const id = line.audioUrl?.split('/').pop() ?? '';
    expect(getCallAudioStore().get(id)?.audio.toString()).toBe('audio:Hello there');
  });

  test('no public URL, or no Speech engine: the carrier says the text', async () => {
    expect(await prepareSpokenLine('Hello', null)).toEqual({ text: 'Hello' });
    speech.available = false;
    expect(await prepareSpokenLine('Hello', BASE)).toEqual({ text: 'Hello' });
    expect(speech.spoken).toEqual([]);
  });

  test('synthesis that fails, or audio no carrier plays, falls back to the carrier voice', async () => {
    speech.fail = new Error('engine down');
    expect(await prepareSpokenLine('Hello', BASE)).toEqual({ text: 'Hello' });
    speech.fail = null;
    speech.format = 'pcm';
    expect(await prepareSpokenLine('Hello', BASE)).toEqual({ text: 'Hello' });
  });

  test('a stock line is synthesised once and its clip reused', async () => {
    const first = await prepareSpokenLine('Are you still there?', `${BASE}/`, true);
    const again = await prepareSpokenLine('Are you still there?', BASE, true);
    expect(again.audioUrl).toBe(first.audioUrl);
    expect(speech.spoken).toHaveLength(1);
    // A line of the conversation is never reused.
    await prepareSpokenLine('Are you still there?', BASE);
    expect(speech.spoken).toHaveLength(2);
  });
});
