/**
 * The scenario the media work was asked for (plan §A12): "Generate an image
 * with text on it, look at it and describe it, and read the text out loud."
 * The three tools, chained as an agent calls them, on stub lanes: the image
 * model returns a fixed PNG, the speech engine a fixed WAV. A seeing model
 * gets the pixels back; a blind one gets the Vision lane's reading. The
 * person gets the image and the speech with the answer.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentContext } from '@/core/types';

const state = vi.hoisted(() => ({ root: '', rows: {} as Record<string, unknown>, said: [] as string[] }));

vi.mock('@/security/workspace-fs', async (orig) => {
  const real = await orig<typeof import('@/security/workspace-fs')>();
  const TestFS = new Proxy(real.WorkspaceFS, {
    get: (target, prop, receiver) => (prop === 'forAgent' ? () => target.withRoot(state.root) : Reflect.get(target, prop, receiver)),
  });
  return { ...real, WorkspaceFS: TestFS };
});
vi.mock('@/models/image-generation', () => ({
  imageGenerationTakesReferences: async () => false,
  generateImageWithLane: async () => ({
    model: 'stub image model',
    images: [{
      mimeType: 'image/png',
      data: await sharp({ create: { width: 64, height: 32, channels: 3, background: '#fff' } }).png().toBuffer(),
    }],
  }),
}));
vi.mock('@/models/model-registry', () => ({ getModelRegistry: () => ({ getModel: async (n: string) => state.rows[n] ?? null }) }));
vi.mock('@/models/media-resolver', () => ({ resolveMedia: async () => ({ mode: 'lane', lane: 'vision', row: { name: 'stub vision', modelId: 'vl' } }) }));
vi.mock('@/models/litellm-client', () => ({ getLiteLLMClient: () => ({ completeVision: async () => ({ content: 'A white sign with the word "OPEN" in black letters.' }) }) }));
vi.mock('@/voice/resolve', () => ({
  synthesizeWithLane: async (text: string) => {
    state.said.push(text);
    return { audio: Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(40)]), format: 'wav', contentType: 'audio/wav', model: 'stub speech' };
  },
}));
vi.mock('@/models/install-access', () => ({ mayUseInstallModels: async () => true }));

const { ImageGenTool } = await import('@/tools/imagegen');
const { VisionTool, resetViewCountsForTest } = await import('@/tools/vision');
const { AudioTool } = await import('@/tools/audio');
const { runWithContext } = await import('@/core/run-context');
const { takeTurnMedia } = await import('./turn-media');
const { TOOL_MEDIA_KEY } = await import('./tool-media');

type Call = (args: Record<string, unknown>, ctx: AgentContext) => Promise<Record<string, unknown>>;
const draw = (new ImageGenTool() as unknown as { generate: Call }).generate.bind(new ImageGenTool());
const vision = new VisionTool() as unknown as { viewImage: Call };
const look: Call = (a, c) => vision.viewImage(a, c);
const audio = new AudioTool() as unknown as { speak: Call };
const speak: Call = (a, c) => audio.speak(a, c);

const ctx = (modelName: string) => ({ id: `agent-${modelName}`, sessionId: 's1', userId: 'u1', modelName, role: 'general', funding: 'install' }) as unknown as AgentContext;

beforeEach(async () => {
  state.root = await mkdtemp(join(tmpdir(), 'octipus-a12-'));
  state.rows = {
    seeing: { name: 'seeing', provider: 'ollama', supportsVision: true },
    blind: { name: 'blind', provider: 'openai', supportsVision: false },
  };
  state.said = [];
  resetViewCountsForTest();
});
afterEach(async () => { await rm(state.root, { recursive: true, force: true }); });

describe('generate → look → read aloud', () => {
  for (const model of ['seeing', 'blind'] as const) {
    test(`with a ${model} root`, async () => {
      await runWithContext({ runId: `run_a12_${model}` }, async () => {
        const drawn = await draw({ prompt: 'A white sign with the word "OPEN"' }, ctx(model));
        const path = (drawn.images as Array<{ path: string }>)[0].path;
        expect(await readFile(join(state.root, path))).toBeTruthy();

        const seen = await look({ source: path, question: 'What text is on it?' }, ctx(model));
        if (model === 'seeing') {
          expect(seen.status).toMatch(/you can see it now/);
          expect(seen[TOOL_MEDIA_KEY]).toHaveLength(1);
        } else {
          expect(seen.description).toMatch(/"OPEN"/);
        }

        const spoken = await speak({ text: 'OPEN' }, ctx(model));
        expect(spoken).toMatchObject({ mimeType: 'audio/wav', model: 'stub speech' });
        expect(state.said).toEqual(['OPEN']);
      });
      const media = takeTurnMedia(`run_a12_${model}`);
      expect(media.map((m) => [m.kind, m.deliver])).toEqual([['image', 'attach'], ['audio', 'voice']]);
    });
  }
});
