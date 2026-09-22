import { describe, expect, test, vi } from 'vitest';
import { Elysia } from '@/api/http';

vi.mock('@/voice/whisper', () => ({ getVoiceAvailability: async () => ({ stt: { available: false, reason: 'Not configured', local: false, external: false }, tts: { available: false, reason: 'Not configured' } }) }));
vi.mock('@/models/providers/mistral-provider', () => ({ getMistralApiKey: async () => null }));
vi.mock('@/models/providers/openai-provider', () => ({ getOpenAIApiKey: async () => null }));
import { voiceRoutes } from './voice';

describe('native mobile voice capability contract', () => {
  test('native speech is supported without a server STT/TTS engine', async () => {
    const app = new Elysia().derive(() => ({ user: { id: 'user', username: 'test', isAdmin: false } })).use(voiceRoutes);
    const result = await app.handle(new Request('http://test/voice/status'));
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ mobileVoice: true, sttAvailable: false, ttsAvailable: false });
  });
  test('capability request still requires authentication', async () => {
    const app = new Elysia().use(voiceRoutes);
    const result = await app.handle(new Request('http://test/voice/status'));
    expect(await result.json()).toEqual({ error: 'Not authenticated' });
  });
});
