/**
 * imagegen__generate_image: refused before paying, saved in the workspace,
 * added to the turn's media for the person.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentContext } from '@/core/types';

const state = vi.hoisted(() => ({
  root: '',
  generate: vi.fn(),
  references: false,
}));
vi.mock('@/security/workspace-fs', async (orig) => {
  const real = await orig<typeof import('@/security/workspace-fs')>();
  const TestFS = new Proxy(real.WorkspaceFS, {
    get: (target, prop, receiver) => (prop === 'forAgent' ? () => target.withRoot(state.root) : Reflect.get(target, prop, receiver)),
  });
  return { ...real, WorkspaceFS: TestFS };
});
vi.mock('@/models/image-generation', () => ({
  generateImageWithLane: state.generate,
  imageGenerationTakesReferences: async () => state.references,
}));

const { ImageGenTool } = await import('./index');
const { runWithContext } = await import('@/core/run-context');
const { takeTurnMedia } = await import('@/core/media/turn-media');
const tool = new ImageGenTool() as unknown as { generate(args: Record<string, unknown>, ctx: AgentContext): Promise<Record<string, unknown>> };
const ctx = { id: 'a1', sessionId: 's1', userId: 'u1', role: 'general', funding: 'install' } as unknown as AgentContext;

let png: Buffer;
beforeEach(async () => {
  state.root = await mkdtemp(join(tmpdir(), 'octipus-imagegen-'));
  png = await sharp({ create: { width: 30, height: 20, channels: 3, background: '#0a0' } }).png().toBuffer();
  state.generate.mockReset();
  state.generate.mockResolvedValue({ images: [{ data: png, mimeType: 'image/png' }], model: 'gpt image', revisedPrompt: 'green' });
  state.references = false;
});
afterEach(async () => { await rm(state.root, { recursive: true, force: true }); });

describe('generate_image', () => {
  test('saves the image in the workspace, reports its size, and gives it to the person with the answer', async () => {
    const out = await runWithContext({ runId: 'run_test1' }, () => tool.generate({ prompt: 'A sign that says "OPEN"', aspect_ratio: 'landscape', n: 2 }, ctx));
    const images = out.images as Array<{ path: string; width: number; height: number }>;
    expect(images[0].path).toMatch(/^\.octipus\/media\/generated\/[0-9a-f-]+\.png$/);
    expect(images[0]).toMatchObject({ width: 30, height: 20 });
    expect(await readFile(join(state.root, images[0].path))).toEqual(png);
    expect(out).toMatchObject({ model: 'gpt image', revisedPrompt: 'green' });
    expect(state.generate).toHaveBeenCalledWith('A sign that says "OPEN"', { n: 2, aspect: 'landscape', references: [] }, expect.objectContaining({ userId: 'u1', sessionId: 's1', agentId: 'a1' }));
    const media = takeTurnMedia('run_test1');
    expect(media).toEqual([expect.objectContaining({ kind: 'image', mimeType: 'image/png', deliver: 'attach', path: join(state.root, images[0].path) })]);
  });

  test('an output path is a new file inside the workspace; everything is checked before paying', async () => {
    const out = await tool.generate({ prompt: 'cat', output_path: 'art/cat.png' }, ctx);
    expect((out.images as Array<{ path: string }>)[0].path).toBe('art/cat.png');
    state.generate.mockClear();
    await expect(tool.generate({ prompt: 'cat', output_path: 'art/cat.png' }, ctx)).rejects.toThrow(/already exists/);
    await expect(tool.generate({ prompt: 'cat', output_path: '../x.png' }, ctx)).rejects.toThrow(/outside allowed workspace/);
    await writeFile(join(state.root, 'ref.png'), png);
    await expect(tool.generate({ prompt: 'cat', reference_images: ['ref.png'] }, ctx)).rejects.toThrow(/does not take reference images/);
    await expect(tool.generate({ prompt: 'x'.repeat(5000) }, ctx)).rejects.toThrow(/at most/);
    expect(state.generate).not.toHaveBeenCalled();
  });

  test('several images: each gets its own new name next to the output path, all checked before paying', async () => {
    state.generate.mockResolvedValue({ images: [{ data: png, mimeType: 'image/png' }, { data: png, mimeType: 'image/png' }], model: 'm' });
    const out = await tool.generate({ prompt: 'cat', n: 2, output_path: 'cat.png' }, ctx);
    expect((out.images as Array<{ path: string }>).map((i) => i.path)).toEqual(['cat.png', 'cat-2.png']);
    state.generate.mockClear();
    await writeFile(join(state.root, 'dog-2.png'), 'taken');
    await expect(tool.generate({ prompt: 'dog', n: 2, output_path: 'dog.png' }, ctx)).rejects.toThrow(/dog-2\.png' already exists/);
    expect(state.generate).not.toHaveBeenCalled();
  });

  test('a spend budget that refuses is a definite no-op, not an uncertain action', async () => {
    const err = Object.assign(new Error('Agents are paused: the daily budget is spent.'), { name: 'SpendBudgetExceededError' });
    state.generate.mockRejectedValueOnce(err);
    const { ToolNotExecutedError } = await import('@/core/tool-execution-error');
    await expect(tool.generate({ prompt: 'cat' }, ctx)).rejects.toBeInstanceOf(ToolNotExecutedError);
  });

  test('reference images are read from the workspace and must be images', async () => {
    state.references = true;
    await writeFile(join(state.root, 'ref.png'), png);
    await writeFile(join(state.root, 'notes.txt'), 'hello');
    await tool.generate({ prompt: 'make it blue', reference_images: ['ref.png'] }, ctx);
    expect(state.generate).toHaveBeenCalledWith('make it blue', expect.objectContaining({ references: [{ data: png, mimeType: 'image/png' }] }), expect.anything());
    await expect(tool.generate({ prompt: 'x', reference_images: ['notes.txt'] }, ctx)).rejects.toThrow(/not an image/);
  });
});
