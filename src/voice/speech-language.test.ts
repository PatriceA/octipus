/**
 * The language every engine is told (src/voice/speech-language.ts): a locale
 * in `voice.language` reaches an engine as its two-letter code.
 */
import { describe, expect, test, vi } from 'vitest';
import { speechLanguage } from './speech-language';
import { nemoEndpointingMs, nemoRealtimeProtocol, OpenAIRealtimeSTTEngine, openAiRealtimeProtocol } from './stt';

describe('speechLanguage', () => {
  test('a locale becomes its language; auto and empty let the engine detect it', () => {
    expect(speechLanguage('en')).toBe('en');
    expect(speechLanguage('en-US')).toBe('en');
    expect(speechLanguage('de_DE')).toBe('de');
    expect(speechLanguage(' PT-br ')).toBe('pt');
    expect(speechLanguage('auto')).toBeUndefined();
    expect(speechLanguage('')).toBeUndefined();
    expect(speechLanguage(undefined)).toBeUndefined();
    expect(speechLanguage('not a language')).toBeUndefined();
  });

  test('the realtime sockets are told the two-letter code', () => {
    expect(sessionOf(openAiRealtimeProtocol({ url: 'ws://x', headers: {}, name: 'x', model: 'm', language: 'en-US', sampleRate: 24000 })).audio.input.transcription)
      .toEqual({ model: 'm', language: 'en' });
    expect(sessionOf(openAiRealtimeProtocol({ url: 'ws://x', headers: {}, name: 'x', model: 'm', language: 'auto', sampleRate: 24000 })).audio.input.transcription)
      .toEqual({ model: 'm' });
    expect(sessionOf(nemoRealtimeProtocol({ url: 'ws://x', headers: {}, language: 'fr_FR' }))).toMatchObject({ language: 'fr' });
  });

  test('a batch transcription sends the two-letter code', async () => {
    const forms: FormData[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      forms.push(init?.body as FormData);
      return new Response(JSON.stringify({ text: 'hi' }), { headers: { 'content-type': 'application/json' } });
    });
    try {
      await new OpenAIRealtimeSTTEngine('gpt-realtime-whisper', { apiKey: 'k', language: 'en-GB' }).transcribe(Buffer.from('x'));
      expect(forms[0].get('language')).toBe('en');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('NeMo endpointing', () => {
  test('the server ends an utterance before the conversation ends the turn', () => {
    expect(nemoEndpointingMs()).toBe(500);
    expect(nemoEndpointingMs(700)).toBe(500);
    expect(nemoEndpointingMs(500)).toBe(300);
    expect(nemoEndpointingMs(250)).toBe(100);
    expect(nemoEndpointingMs(3000)).toBe(500);
    expect(sessionOf(nemoRealtimeProtocol({ url: 'ws://x', headers: {}, endpointingMs: nemoEndpointingMs(600) }))).toMatchObject({ endpointing_ms: 400 });
  });
});

function sessionOf(protocol: { onOpen?: (ws: WebSocket) => void }) {
  const sent: string[] = [];
  protocol.onOpen?.({ send: (m: string) => sent.push(m) } as unknown as WebSocket);
  return JSON.parse(sent[0]).session;
}
