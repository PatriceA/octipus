/**
 * Who does media work (src/models/media-resolver.ts), as a table: the agent's
 * own model when it reads images, else the lanes in order, else the default
 * model if it reads images, else nobody — with the reason.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ModelConfigEntry } from '@/db/schema/models';

const state = vi.hoisted(() => ({
  lanes: {} as Record<string, unknown>,
  def: null as unknown,
}));
vi.mock('./model-registry', () => ({
  getModelRegistry: () => ({
    getModelForTopic: async (t: string) => state.lanes[t] ?? null,
    getDefaultModel: async () => state.def,
  }),
}));

const { resolveMedia } = await import('./media-resolver');

const row = (name: string, extra: Partial<ModelConfigEntry> = {}) =>
  ({ id: name, name, modelId: name, provider: 'ollama', supportsVision: false, topics: [], topicRoles: {}, ...extra }) as unknown as ModelConfigEntry;
const bound = (name: string, lane: string, extra: Partial<ModelConfigEntry> = {}) => row(name, { topicRoles: { [lane]: 'primary' }, ...extra });

beforeEach(() => { state.lanes = {}; state.def = null; });

describe('resolveMedia', () => {
  test('see: an agent whose model reads images sees natively, whatever is bound', async () => {
    state.lanes.vision = bound('ocr-model', 'vision');
    const agent = row('qwen3.8', { supportsVision: true });
    expect(await resolveMedia('see', { agentRow: agent })).toEqual({ mode: 'native', row: agent });
  });

  test('see: a blind agent gets the Vision lane, else the default model if it reads images, else nobody', async () => {
    const blind = row('deepseek-chat');
    state.def = row('gemma4', { supportsVision: true });
    expect(await resolveMedia('see', { agentRow: blind })).toMatchObject({ mode: 'lane', lane: 'default', row: { name: 'gemma4' } });
    state.lanes.vision = bound('qwen-vl', 'vision');
    expect(await resolveMedia('see', { agentRow: blind })).toMatchObject({ mode: 'lane', lane: 'vision', row: { name: 'qwen-vl' } });
    state.lanes = {};
    state.def = blind;
    const none = await resolveMedia('see', { agentRow: blind });
    expect(none.mode).toBe('none');
    expect(none.mode === 'none' && none.reason).toMatch(/read images/);
  });

  test('ocr: OCR lane, then Vision lane, then the default model if it reads images', async () => {
    state.def = row('gpt', { supportsVision: true });
    expect(await resolveMedia('ocr')).toMatchObject({ lane: 'default' });
    state.lanes.vision = bound('vl', 'vision');
    expect(await resolveMedia('ocr')).toMatchObject({ lane: 'vision' });
    state.lanes.ocr = bound('deepseek-ocr', 'ocr');
    expect(await resolveMedia('ocr')).toMatchObject({ lane: 'ocr', row: { name: 'deepseek-ocr' } });
  });

  test('a row that merely comes back for a topic it does not carry is not a binding', async () => {
    state.lanes.vision = row('stray'); // no topics, no topicRoles
    expect((await resolveMedia('see')).mode).toBe('none');
  });

  test('draw / hear / speak: only their own lane', async () => {
    for (const [need, lane] of [['draw', 'image_generation'], ['hear', 'transcription'], ['speak', 'speech']] as const) {
      expect((await resolveMedia(need)).mode).toBe('none');
      state.lanes[lane] = bound(`${lane}-model`, lane);
      expect(await resolveMedia(need)).toMatchObject({ mode: 'lane', lane, row: { name: `${lane}-model` } });
    }
  });
});
