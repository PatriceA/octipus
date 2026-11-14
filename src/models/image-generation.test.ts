/**
 * Image generation through the lane (src/models/image-generation.ts) and the
 * provider wire formats (openai-images.ts, gemini-images.ts).
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ModelConfigEntry } from '@/db/schema/models';

const state = vi.hoisted(() => ({
  primary: null as unknown,
  backup: null as unknown,
  providers: {} as Record<string, { generateImage?: (req: Record<string, unknown>) => Promise<unknown> }>,
  usage: vi.fn(async () => {}),
  localOnly: undefined as number | undefined,
  local: new Set<string>(),
}));

vi.mock('./model-registry', () => ({
  getModelRegistry: () => ({ getModelForTopic: async () => state.primary, getBackupModelForTopic: async () => state.backup }),
}));
vi.mock('./providers', () => ({ getProviderRouter: () => ({ getProviderByName: (n: string) => state.providers[n] }) }));
vi.mock('./model-key', () => ({ resolveModelKey: async (row: { name: string }) => `key-${row.name}` }));
vi.mock('./providers/instrumented', () => ({ recordProviderUsage: state.usage }));
vi.mock('@/core/protection/routing', () => ({
  localOnlyLevel: async () => state.localOnly,
  runsLocally: async (row: { name: string }) => state.local.has(row.name),
}));

const { generateImageWithLane, imageGenerationTakesReferences } = await import('./image-generation');
const { openAiImageSize, openAiImages, chatModalityImages } = await import('./providers/openai-images');
const { geminiImages } = await import('./providers/gemini-images');

const row = (name: string, provider: string, modelId: string, role = 'primary') =>
  ({ name, provider, modelId, topicRoles: { image_generation: role }, metadata: {} }) as unknown as ModelConfigEntry;
const png = { data: Buffer.from('png'), mimeType: 'image/png' };

beforeEach(() => {
  state.primary = null; state.backup = null; state.providers = {}; state.localOnly = undefined; state.local = new Set();
  vi.clearAllMocks();
});

describe('the Image generation lane', () => {
  test('nothing bound: not configured (draw)', async () => {
    await expect(generateImageWithLane('a cat', {})).rejects.toMatchObject({ code: 'capability_not_configured', capability: 'draw' });
  });

  test('the primary draws with its row key; usage recorded per image; n is capped at 4', async () => {
    const generate = vi.fn(async () => ({ images: [png, png] }));
    state.primary = row('gpt image', 'openai', 'gpt-image-1');
    state.providers.openai = { generateImage: generate };
    const out = await generateImageWithLane('a cat', { n: 9, aspect: 'landscape' }, { userId: 'u1', sessionId: 's1' });
    expect(out).toMatchObject({ model: 'gpt image', images: [png, png] });
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-image-1', modelConfigName: 'gpt image', n: 4, aspect: 'landscape', apiKey: 'key-gpt image' }));
    // No price on the row: the list price, labelled as such.
    expect(state.usage).toHaveBeenCalledWith(
      expect.objectContaining({ requestType: 'image_generation', accountingMetadata: { images: 2, imageCostSource: 'list price' }, userId: 'u1', sessionId: 's1' }),
      'openai', expect.objectContaining({ usage: expect.objectContaining({ reportedCost: 0.084 }) }), false);
  });

  test('a failing primary falls to the backup; a confidential conversation only reaches a local model', async () => {
    state.primary = row('cloud', 'openai', 'gpt-image-1');
    state.backup = row('local sd', 'custom-openai', 'sdxl', 'backup');
    state.providers.openai = { generateImage: async () => { throw new Error('quota'); } };
    state.providers['custom-openai'] = { generateImage: async () => ({ images: [png] }) };
    await expect(generateImageWithLane('a cat', {})).resolves.toMatchObject({ model: 'local sd' });
    state.providers.openai = { generateImage: vi.fn(async () => ({ images: [png] })) };
    state.localOnly = 4;
    state.local = new Set(['local sd']);
    await expect(generateImageWithLane('a cat', {}, { sessionId: 's' })).resolves.toMatchObject({ model: 'local sd' });
    expect(state.providers.openai.generateImage).not.toHaveBeenCalled();
    state.local = new Set();
    await expect(generateImageWithLane('a cat', {}, { sessionId: 's' })).rejects.toThrow(/protection level 4/);
  });

  test('an account without the install models: only a local row or one of its own draws', async () => {
    state.primary = row('cloud', 'openai', 'gpt-image-1');
    state.backup = row('local sd', 'custom-openai', 'sdxl', 'backup');
    state.providers.openai = { generateImage: vi.fn(async () => ({ images: [png] })) };
    state.providers['custom-openai'] = { generateImage: async () => ({ images: [png] }) };
    state.local = new Set(['local sd']);
    await expect(generateImageWithLane('a cat', {}, { allowHosted: false })).resolves.toMatchObject({ model: 'local sd' });
    expect(state.providers.openai.generateImage).not.toHaveBeenCalled();
    state.backup = null;
    await expect(generateImageWithLane('a cat', {}, { allowHosted: false })).rejects.toMatchObject({ name: 'InstallModelsDeniedError' });
    state.primary = { ...row('mine', 'openai', 'gpt-image-1'), ownerUserId: 'u1' };
    await expect(generateImageWithLane('a cat', {}, { allowHosted: false })).resolves.toMatchObject({ model: 'mine' });
  });

  test('references: from the row, else from the model id', async () => {
    state.primary = row('gpt image', 'openai', 'gpt-image-1');
    await expect(imageGenerationTakesReferences()).resolves.toBe(true);
    state.primary = row('dalle', 'openai', 'dall-e-3');
    await expect(imageGenerationTakesReferences()).resolves.toBe(false);
    state.primary = { ...row('sd', 'custom-openai', 'sdxl'), metadata: { imageGeneration: { references: true } } };
    await expect(imageGenerationTakesReferences()).resolves.toBe(true);
  });
});

describe('wire formats', () => {
  test('OpenAI Images: sizes per model; base64 asked of DALL·E only; references go to edits', async () => {
    expect(openAiImageSize('gpt-image-1', 'landscape')).toBe('1536x1024');
    expect(openAiImageSize('dall-e-3', 'portrait')).toBe('1024x1792');
    const generate = vi.fn(async () => ({ data: [{ b64_json: Buffer.from('img').toString('base64'), revised_prompt: 'a red cat' }] }));
    const edit = vi.fn(async () => ({ data: [{ b64_json: Buffer.from('edited').toString('base64') }] }));
    const client = { images: { generate, edit } } as never;
    const out = await openAiImages(client, { model: 'dall-e-3', modelConfigName: 'd', prompt: 'cat', n: 3, aspect: 'square' });
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ n: 1, size: '1024x1024', response_format: 'b64_json' }), undefined);
    expect(out).toEqual({ images: [{ data: Buffer.from('img'), mimeType: 'image/png' }], revisedPrompt: 'a red cat' });
    await openAiImages(client, { model: 'gpt-image-1', modelConfigName: 'g', prompt: 'cat', n: 1, aspect: 'square', references: [png] });
    expect(edit).toHaveBeenCalledWith(expect.not.objectContaining({ response_format: expect.anything() }), undefined);
  });

  test('a URL answer is fetched (from the server called, even a local one) and checked to be an image', async () => {
    const sharp = (await import('sharp')).default;
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#000' } }).png().toBuffer();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array(png), { headers: { 'content-length': String(png.length) } }));
    const generate = vi.fn(async () => ({ data: [{ url: 'http://127.0.0.1:8080/files/out.png' }] }));
    const client = { images: { generate }, baseURL: 'http://127.0.0.1:8080/v1' } as never;
    const out = await openAiImages(client, { model: 'sdxl', modelConfigName: 's', prompt: 'cat', n: 1, aspect: 'square' });
    expect(out.images).toEqual([{ data: png, mimeType: 'image/png' }]);
    expect(generate).toHaveBeenCalledWith(expect.not.objectContaining({ response_format: expect.anything() }), undefined);
    fetchMock.mockRestore();
  });

  test('chat-modality images (OpenRouter): data URLs on message.images', async () => {
    const create = vi.fn(async () => ({ choices: [{ message: { content: 'Here it is', images: [{ image_url: { url: `data:image/png;base64,${Buffer.from('x').toString('base64')}` } }] } }] }));
    const out = await chatModalityImages({ chat: { completions: { create } } } as never, { model: 'google/gemini-2.5-flash-image', modelConfigName: 'o', prompt: 'cat', n: 1, aspect: 'portrait' });
    expect(out.images[0]).toEqual({ data: Buffer.from('x'), mimeType: 'image/png' });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ modalities: ['image', 'text'], image_config: { aspect_ratio: '9:16' } }), undefined);
  });

  test('Gemini: Imagen :predict and Gemini image models :generateContent', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ predictions: [{ bytesBase64Encoded: Buffer.from('i').toString('base64'), mimeType: 'image/png' }] })));
    const imagen = await geminiImages('k', { model: 'imagen-4.0-generate-001', modelConfigName: 'i', prompt: 'cat', n: 1, aspect: 'landscape' });
    expect(imagen.images[0].data).toEqual(Buffer.from('i'));
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/imagen-4\.0-generate-001:predict$/);
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toMatchObject({ parameters: { sampleCount: 1, aspectRatio: '16:9' } });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }, { inlineData: { mimeType: 'image/png', data: Buffer.from('g').toString('base64') } }] } }] })));
    const gem = await geminiImages('k', { model: 'gemini-2.5-flash-image', modelConfigName: 'g', prompt: 'cat', n: 1, aspect: 'square', references: [png] });
    expect(gem).toEqual({ images: [{ data: Buffer.from('g'), mimeType: 'image/png' }], revisedPrompt: 'ok' });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'blocked' } }), { status: 400 }));
    await expect(geminiImages('k', { model: 'imagen-4', modelConfigName: 'i', prompt: 'x', n: 1, aspect: 'square' })).rejects.toThrow(/blocked/);
    fetchMock.mockRestore();
  });
});
