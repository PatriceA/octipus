/**
 * The one-time move of the retired voice settings onto the lanes
 * (src/voice/migrate-to-lanes.ts), for each kind of install: what worked
 * keeps working, a bound lane is never touched, it runs once.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  voice: {} as Record<string, unknown>,
  rows: {} as Record<string, { name: string; provider: string; modelId: string; topicRoles: Record<string, string>; metadata?: Record<string, unknown> }>,
  bound: {} as Record<string, string>,
  runs: new Set<string>(),
  store: new Map<string, string>(),
}));

vi.mock('@/config', () => ({ getConfig: () => ({ voice: state.voice }) }));
vi.mock('@/db/cache', () => ({
  rawStore: () => ({ get: async (k: string) => state.store.get(k) ?? null, set: async (k: string, v: string) => { state.store.set(k, v); } }),
}));
vi.mock('@/models/model-registry', () => ({
  getModelRegistry: () => ({
    getModelForTopic: async (lane: string) => (state.bound[lane] ? state.rows[state.bound[lane]] : null),
    getModel: async (name: string) => state.rows[name] ?? null,
    registerModel: async (row: { name: string; provider: string; modelId: string; metadata?: Record<string, unknown> }) => {
      state.rows[row.name] = { ...row, topicRoles: {} };
      return state.rows[row.name];
    },
    updateModel: async (name: string, patch: { topicRoles?: Record<string, string> }) => {
      state.rows[name] = { ...state.rows[name], ...patch } as never;
      for (const [lane, role] of Object.entries(patch.topicRoles ?? {})) if (role === 'primary') state.bound[lane] = name;
      return state.rows[name];
    },
  }),
}));
vi.mock('./speech-rows', async (orig) => {
  const real = await orig<typeof import('./speech-rows')>();
  return { ...real, speechRowAvailable: async (row: { modelId: string }) => (state.runs.has(row.modelId) ? { ok: true } : { ok: false, reason: 'no' }) };
});

const { migrateVoiceSettingsToLanes } = await import('./migrate-to-lanes');

const roles = (name: string) => state.rows[name]?.topicRoles;

beforeEach(() => {
  state.voice = { sttProvider: 'auto', fasterWhisperModel: 'small', ttsProvider: 'mistral' };
  state.rows = {}; state.bound = {}; state.runs = new Set(); state.store = new Map();
});

describe('moving voice settings onto the lanes', () => {
  test('auto with local whisper and a Mistral key: local first for speech in (backup the cloud), Mistral keeps speaking (backup Kokoro)', async () => {
    state.runs = new Set(['whisper.cpp:base', 'voxtral-mini-latest', 'voxtral-mini-tts-2603', 'kokoro:af_sarah']);
    await migrateVoiceSettingsToLanes();
    expect(roles('local whisper.cpp base')).toEqual({ transcription: 'primary' });
    expect(roles('mistral voxtral transcribe')).toEqual({ transcription: 'backup' });
    expect(roles('mistral voxtral speech')).toEqual({ speech: 'primary' });
    expect(roles('local kokoro')).toEqual({ speech: 'backup' });
  });

  test('an explicit choice is kept even when it cannot run yet; faster-whisper keeps its size', async () => {
    state.voice = { sttProvider: 'fasterwhisper', fasterWhisperModel: 'medium', ttsProvider: 'openai' };
    await migrateVoiceSettingsToLanes();
    expect(roles('local faster-whisper medium')).toEqual({ transcription: 'primary' });
    expect(state.rows['local faster-whisper medium'].modelId).toBe('faster-whisper:medium');
    expect(roles('openai gpt-4o-mini-tts')).toEqual({ speech: 'primary' });
  });

  test('nothing configured anywhere: both lanes stay unbound (voice is simply off)', async () => {
    const result = await migrateVoiceSettingsToLanes();
    expect(result).toEqual(['transcription: nothing configured, left unbound', 'speech: nothing configured, left unbound']);
    expect(state.bound).toEqual({});
  });

  test('the default "mistral" is not a choice: without a key, a local voice that runs is used', async () => {
    state.runs = new Set(['kokoro:af_sarah']);
    await migrateVoiceSettingsToLanes();
    expect(roles('local kokoro')).toEqual({ speech: 'primary' });
    expect(state.rows['mistral voxtral speech']).toBeUndefined();
  });

  test('a bound lane is left as it is, and the migration runs once', async () => {
    state.rows.mine = { name: 'mine', provider: 'openai', modelId: 'gpt-4o-transcribe', topicRoles: { transcription: 'primary' } };
    state.bound.transcription = 'mine';
    state.runs = new Set(['whisper.cpp:base']);
    const first = await migrateVoiceSettingsToLanes();
    expect(first?.[0]).toBe('transcription: already bound, left as is');
    expect(state.rows['local whisper.cpp base']).toBeUndefined();
    await expect(migrateVoiceSettingsToLanes()).resolves.toBeNull();
  });
});
