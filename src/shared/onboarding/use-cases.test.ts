import { describe, expect, test } from 'vitest';
import { initialAnswers, keyAvailable, optionsOf, SECTIONS, storableAnswers, visibleQuestions } from './use-cases';
import type { Answers, OnboardingState } from './types';

const state = (over: Partial<OnboardingState['models']> = {}, isAdmin = true): OnboardingState => ({
  isAdmin,
  setupComplete: false,
  models: { textReady: true, embeddingReady: false, verifySeparate: false, names: [], providersWithKey: [], byTopic: {}, ...over },
  cliTools: [],
  ollama: { url: 'http://localhost:11434', reachable: false },
  workspaces: [],
  mailbox: null,
  oauthClients: { google: false, microsoft: false },
  channels: { configured: [], linked: [] },
  heartbeat: { serverEnabled: false, enabled: false, watchEmail: false, intervalMinutes: null, timezone: 'UTC' },
  permissions: { tasksWrite: 'ASK', messagingSend: 'ASK' },
  standingInstructions: false,
  roleAgents: [],
  pipelineTemplates: [],
  mcpServers: [],
  workspaceRoot: null,
  modules: { enabled: [], byUseCase: {} },
  progress: {},
});

const media = SECTIONS.find((s) => s.id === 'media')!;
const asked = (a: Answers, s = state()) => visibleQuestions(media, a, s).map((q) => q.id);

describe('Images & audio questions', () => {
  test('an admin-only section, asked of every use case', () => {
    expect(media).toMatchObject({ title: 'Images & audio', useCases: 'all', adminOnly: true });
    expect(asked({}, state({}, false))).toEqual([]);
  });

  test('skipped until chosen: one yes/no for images, one choice for voice', () => {
    const a = initialAnswers([], state());
    expect(a).toMatchObject({ 'media.images': false, 'media.voice': 'skip' });
    expect(asked(a)).toEqual(['media.images', 'media.voice']);
  });

  test('"Generate images?" leads to a provider, and a key only when none is available', () => {
    expect(asked({ 'media.images': true, 'media.imageProvider': 'openai' })).toEqual(['media.images', 'media.imageProvider', 'media.imageKey', 'media.voice']);
    expect(asked({ 'media.images': true, 'media.imageProvider': 'openai' }, state({ providersWithKey: ['openai'] }))).not.toContain('media.imageKey');
    const q = media.questions.find((x) => x.id === 'media.imageProvider')!;
    expect(optionsOf(q, state({ providersWithKey: ['gemini'] }), {}).map((o) => [o.value, o.hint])).toEqual([['openai', 'needs its API key'], ['gemini', 'key available']]);
    expect(q.initial?.(state({ providersWithKey: ['gemini'] }), {})).toBe('gemini');
  });

  test('"Voice?" leads to local or cloud; cloud to a provider', () => {
    const voice = media.questions.find((x) => x.id === 'media.voice')!;
    expect(optionsOf(voice, state(), {}).map((o) => o.value)).toEqual(['skip', 'local', 'cloud']);
    expect(asked({ 'media.voice': 'local' })).toEqual(['media.images', 'media.voice']);
    expect(asked({ 'media.voice': 'cloud', 'media.voiceProvider': 'mistral' }, state({ providersWithKey: ['mistral'] }))).toEqual(['media.images', 'media.voice', 'media.voiceProvider']);
    // The same provider's key typed for images is not asked again.
    expect(asked({ 'media.images': true, 'media.imageProvider': 'openai', 'media.imageKey': 'sk', 'media.voice': 'cloud', 'media.voiceProvider': 'openai' })).not.toContain('media.voiceKey');
  });

  test('a key from the model step or document search counts', () => {
    expect(keyAvailable({ 'models.source': 'key', 'models.provider': 'openai', 'models.key': 'sk' }, state(), 'openai')).toBe(true);
    expect(keyAvailable({ 'models.embedding': 'openai', 'models.embeddingKey': 'sk' }, state(), 'openai')).toBe(true);
    expect(keyAvailable({}, state(), 'openai')).toBe(false);
  });

  test('what is already bound is said', () => {
    const s = state({ byTopic: { image_generation: 'openai gpt-image-1', speech: 'local kokoro' } });
    expect(media.questions.find((x) => x.id === 'media.images')!.alreadyDone?.(s, {})).toContain('openai gpt-image-1');
    expect(media.questions.find((x) => x.id === 'media.voice')!.alreadyDone?.(s, {})).toContain('local kokoro');
  });

  test('media keys are never kept with the saved answers', () => {
    expect(storableAnswers({ 'media.imageKey': 'a', 'media.voiceKey': 'b', 'media.voice': 'cloud' })).toEqual({ 'media.voice': 'cloud' });
  });
});
