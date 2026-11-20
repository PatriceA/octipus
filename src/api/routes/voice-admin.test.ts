/**
 * The voice routes that are install configuration (src/api/routes/voice.ts):
 * voice profiles, speech engines and installs are an admin's; a member may
 * transcribe and list voices, but not pick an engine by name or read how a
 * profile was made.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from '@/api/http';
import { principalFromUser } from '@/security/principal';

type TestUser = { id: string; username: string; isAdmin: boolean };
const ADMIN: TestUser = { id: '11111111-1111-4111-8111-111111111111', username: 'owner', isAdmin: true };
const MEMBER: TestUser = { id: '22222222-2222-4222-8222-222222222222', username: 'member', isAdmin: false };

const fixture = vi.hoisted(() => ({
  user: null as { id: string; username: string; isAdmin: boolean } | null,
  rows: {} as Record<string, Record<string, any>>,
  calls: [] as string[],
}));

vi.mock('@/api/context', async () => ({
  apiContext: new (await import('@/api/http')).App().derive(() => ({
    user: fixture.user,
    principal: fixture.user ? principalFromUser(fixture.user) : { kind: 'anonymous' },
  })),
}));
vi.mock('@/models/install-access', () => ({ mayUseInstallModels: async () => true }));
vi.mock('@/models/model-registry', () => ({
  getModelRegistry: () => ({
    getModel: async (name: string) => fixture.rows[name] ?? null,
    updateModel: async (name: string, patch: Record<string, unknown>) => {
      fixture.calls.push(`update ${name}`);
      return (fixture.rows[name] = { ...fixture.rows[name], ...patch });
    },
    deleteModel: async (name: string) => { fixture.calls.push(`delete ${name}`); },
  }),
}));
vi.mock('@/voice/resolve', () => ({
  transcribeWithLane: async (_audio: Buffer, req: { override: string | null }) => {
    fixture.calls.push(`transcribe ${req.override ?? ''}`.trim());
    return { text: 'hello', model: 'turbo', language: 'en', duration: 1 };
  },
  speechVoices: async () => ({ model: 'vox', voices: ['S0'] }),
}));
vi.mock('@/voice/profiles', () => ({
  listVoiceProfiles: async () => [{
    name: 'Narrator', description: 'calm', voice: 'S3', instructions: 'a calm older man', refAudio: '0123.wav', refAudioType: 'audio/wav',
    refText: 'what the owner said', model: 'vox', speed: 1.1,
  }],
  activeVoiceProfileName: async () => 'Narrator',
  saveVoiceProfile: async (input: { name: string }) => { fixture.calls.push(`save ${input.name}`); return { name: input.name }; },
  deleteVoiceProfile: async (name: string) => { fixture.calls.push(`delete profile ${name}`); return true; },
  setActiveVoiceProfile: async (name: string) => { fixture.calls.push(`active ${name}`); },
  getVoiceProfile: async () => ({ name: 'Narrator', refAudio: '0123.wav' }),
  voiceProfileClip: async () => ({ data: Buffer.from('RIFF'), mimeType: 'audio/wav' }),
}));
vi.mock('@/voice/install-jobs', () => ({
  startSpeechInstall: (engine: string) => { fixture.calls.push(`install ${engine}`); return { engine, stage: 'running' }; },
}));
vi.mock('@/voice/overview', () => ({ speechOverview: async () => ({ engines: [] }) }));
vi.mock('@/voice/speech-rows', async (orig) => ({
  ...(await orig<typeof import('@/voice/speech-rows')>()),
  useSpeechEngine: async () => { fixture.calls.push('use engine'); return { row: { name: 'local kokoro' }, bound: 'primary', lane: 'speech' }; },
  useSpeechServer: async () => { fixture.calls.push('use server'); return { row: { name: 'mine' }, bound: 'primary', lane: 'speech' }; },
}));

const { voiceRoutes } = await import('./voice');
const app = new App().use(voiceRoutes);

async function call(method: string, path: string, body?: unknown) {
  const res = await app.handle(new Request(`http://test${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

const NEMO = {
  name: 'nemo', provider: 'custom-openai', modelId: 'nvidia/nemotron-3.5-asr-streaming-0.6b', endpoint: 'http://10.0.0.5:8080',
  metadata: { speech: { direction: 'stt', realtime: { protocol: 'nemo', url: 'ws://10.0.0.5:9000/rt' } }, dataPolicy: { hosting: 'local', retention: 'none', trainsOnInput: false } },
};

beforeEach(() => {
  fixture.user = MEMBER;
  fixture.calls = [];
  fixture.rows = { nemo: structuredClone(NEMO) };
});

const ADMIN_ONLY: Array<[string, string, unknown?]> = [
  ['PUT', '/voice/profiles/Narrator', { voice: 'S3' }],
  ['DELETE', '/voice/profiles/Narrator'],
  ['POST', '/voice/profiles/active', { name: 'Narrator' }],
  ['GET', '/voice/profiles/Narrator/clip'],
  ['GET', '/voice/engines'],
  ['POST', '/voice/engines/use', { engine: 'kokoro', direction: 'tts' }],
  ['POST', '/voice/engines/server', { direction: 'tts', endpoint: 'http://localhost:8091', modelId: 'openbmb/VoxCPM2' }],
  ['PATCH', '/voice/engines/nemo', { speech: { upload: 'wav' } }],
  ['DELETE', '/voice/engines/nemo'],
  ['POST', '/voice/engines/install', { engine: 'kokoro' }],
];

describe('voice routes that change or read install configuration', () => {
  test.each(ADMIN_ONLY)('%s %s → 403 for a member, and nothing is done', async (method, path, body) => {
    const res = await call(method, path, body);
    expect(res.status).toBe(403);
    expect(fixture.calls).toEqual([]);
  });

  test.each(ADMIN_ONLY)('%s %s → not refused for an admin', async (method, path, body) => {
    fixture.user = ADMIN;
    expect([401, 403]).not.toContain((await call(method, path, body)).status);
  });

  test.each(ADMIN_ONLY)('%s %s → 401 signed out', async (method, path, body) => {
    fixture.user = null;
    expect((await call(method, path, body)).status).toBe(401);
  });

  test('the old synchronous whisper.cpp build route is gone: installs run as jobs', async () => {
    fixture.user = ADMIN;
    expect((await call('POST', '/voice/install', {})).status).toBe(404);
  });
});

describe('what a member may do', () => {
  test('transcribe with the lane, but not pick an engine by name', async () => {
    await expect(call('POST', '/voice/transcribe', { audio: 'YWJj' })).resolves.toMatchObject({ status: 200, body: { text: 'hello' } });
    await expect(call('POST', '/voice/transcribe', { audio: 'YWJj', model: 'auto' })).resolves.toMatchObject({ status: 200 });
    await expect(call('POST', '/voice/transcribe', { audio: 'YWJj', model: 'openai gpt-4o-transcribe' })).resolves.toMatchObject({ status: 403 });
    expect(fixture.calls).toEqual(['transcribe', 'transcribe auto']);
    fixture.user = ADMIN;
    await expect(call('POST', '/voice/transcribe', { audio: 'YWJj', model: 'openai gpt-4o-transcribe' })).resolves.toMatchObject({ status: 200 });
    expect(fixture.calls.at(-1)).toBe('transcribe openai gpt-4o-transcribe');
  });

  test('list the voices by name, without how they were made', async () => {
    const member = await call('GET', '/voice/voices');
    expect(member.body.profiles).toEqual([{ name: 'Narrator', description: 'calm', voice: 'S3', hasClip: true }]);
    fixture.user = ADMIN;
    const admin = await call('GET', '/voice/voices');
    expect(admin.body.profiles[0]).toMatchObject({ instructions: 'a calm older man', refText: 'what the owner said', model: 'vox', hasClip: true });
    expect(admin.body.profiles[0].refAudio).toBeUndefined();
  });
});

describe('editing an engine', () => {
  test('a local row may not stream live audio to a public host; turning the socket off keeps its URL', async () => {
    fixture.user = ADMIN;
    const refused = await call('PATCH', '/voice/engines/nemo', { speech: { realtime: { protocol: 'nemo', url: 'wss://asr.example.com/rt' } } });
    expect(refused).toMatchObject({ status: 400, body: { error: expect.stringMatching(/public host/) } });
    expect(fixture.rows.nemo.metadata.speech.realtime.url).toBe('ws://10.0.0.5:9000/rt');

    await expect(call('PATCH', '/voice/engines/nemo', { speech: { realtime: { protocol: 'off' } } })).resolves.toMatchObject({ status: 200 });
    expect(fixture.rows.nemo.metadata.speech.realtime).toEqual({ protocol: 'off', url: 'ws://10.0.0.5:9000/rt' });
  });
});
