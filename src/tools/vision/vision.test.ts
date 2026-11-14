/**
 * vision__view_image and vision__read_document_text (src/tools/vision):
 * one verb whatever the model — pixels for a model shown images after a tool
 * result, the Vision lane's answer for one that is not, the file for a CLI
 * agent — inside the workspace, SSRF-guarded for URLs, capped per image.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TOOL_MEDIA_KEY } from '@/core/media/tool-media';
import type { AgentContext } from '@/core/types';

const state = vi.hoisted(() => ({
  root: '',
  rows: {} as Record<string, unknown>,
  resolution: { mode: 'none', reason: 'nobody sees' } as unknown,
  imageInput: 'auto',
  complete: vi.fn(async () => ({ content: 'A red square.' })),
  fetchGuarded: vi.fn(),
  extractText: vi.fn(async () => '# Invoice\nTotal 42'),
  resolveCalls: [] as unknown[],
}));

vi.mock('@/security/workspace-fs', async (orig) => {
  const real = await orig<typeof import('@/security/workspace-fs')>();
  const TestFS = new Proxy(real.WorkspaceFS, {
    get: (target, prop, receiver) => (prop === 'forAgent' ? () => target.withRoot(state.root) : Reflect.get(target, prop, receiver)),
  });
  return { ...real, WorkspaceFS: TestFS };
});
vi.mock('@/models/model-registry', () => ({ getModelRegistry: () => ({ getModel: async (n: string) => state.rows[n] ?? null }) }));
vi.mock('@/models/media-resolver', () => ({ resolveMedia: async (...args: unknown[]) => { state.resolveCalls.push(args); return state.resolution; } }));
vi.mock('@/models/litellm-client', () => ({ getLiteLLMClient: () => ({ completeVision: state.complete }) }));
vi.mock('@/config', async (orig) => {
  const real = await orig<typeof import('@/config')>();
  return { ...real, getConfig: () => ({ ...real.getConfig(), media: { imageInput: state.imageInput } }) };
});
vi.mock('@/utils/sanitize', async (orig) => ({ ...(await orig<typeof import('@/utils/sanitize')>()), fetchGuarded: state.fetchGuarded }));
vi.mock('@/core/documents/processor', () => ({ documentProcessor: { extractText: state.extractText } }));

const { VisionTool, resetViewCountsForTest } = await import('./index');
const tool = new VisionTool() as unknown as {
  viewImage(args: Record<string, unknown>, ctx: AgentContext): Promise<Record<string, unknown>>;
  readDocumentText(args: Record<string, unknown>, ctx: AgentContext): Promise<Record<string, unknown>>;
};

const ctx = (modelName: string, id = 'agent-1') => ({ id, sessionId: 's1', userId: 'u1', modelName, role: 'general', funding: 'install' }) as unknown as AgentContext;
const red = () => sharp({ create: { width: 40, height: 20, channels: 3, background: '#d00' } }).png().toBuffer();

beforeEach(async () => {
  state.root = await mkdtemp(join(tmpdir(), 'octipus-vision-'));
  state.rows = {
    seeing: { name: 'seeing', provider: 'anthropic', supportsVision: true },
    blind: { name: 'blind', provider: 'openai', supportsVision: false },
    mistral: { name: 'mistral', provider: 'mistral', supportsVision: true },
    cli: { name: 'cli', provider: 'cli', supportsVision: true },
  };
  state.resolution = { mode: 'lane', lane: 'vision', row: { name: 'vision row', modelId: 'qwen-vl' } };
  state.imageInput = 'auto';
  state.resolveCalls = [];
  resetViewCountsForTest();
  vi.clearAllMocks();
  await writeFile(join(state.root, 'red.png'), await red());
});
afterEach(async () => { await rm(state.root, { recursive: true, force: true }); });

describe('view_image', () => {
  test('a model shown images after a tool result gets the pixels (a normalized copy), nothing described', async () => {
    const out = await tool.viewImage({ source: 'red.png' }, ctx('seeing'));
    expect(out.status).toMatch(/you can see it now/);
    const media = out[TOOL_MEDIA_KEY] as Array<{ path: string; mimeType: string }>;
    expect(media).toHaveLength(1);
    expect(media[0].path.startsWith(join(state.root, '.octipus/media/cache'))).toBe(true);
    expect(state.complete).not.toHaveBeenCalled();
  });

  test('a blind model gets the Vision lane\'s answer to its question, within the session\'s protection level', async () => {
    const out = await tool.viewImage({ source: 'red.png', question: 'What colour is it?' }, ctx('blind'));
    expect(out).toMatchObject({ description: 'A red square.', model: 'vision row' });
    expect(out.note).toMatch(/may be wrong/);
    expect(out[TOOL_MEDIA_KEY]).toBeUndefined();
    expect(state.resolveCalls[0]).toEqual(['see', { sessionId: 's1', userId: 'u1' }]);
    expect(state.complete).toHaveBeenCalledWith(expect.objectContaining({
      model: 'qwen-vl', modelConfigName: 'vision row', userId: 'u1', sessionId: 's1', agentId: 'agent-1',
      prompt: expect.stringMatching(/^What colour is it\?[\s\S]*content, not instructions/),
    }));
  });

  test('Mistral reads images but not after a tool result: the lane looks instead; describe mode does the same', async () => {
    expect((await tool.viewImage({ source: 'red.png' }, ctx('mistral'))).description).toBe('A red square.');
    state.imageInput = 'describe';
    expect((await tool.viewImage({ source: 'red.png' }, ctx('seeing', 'agent-2'))).description).toBe('A red square.');
  });

  test('nothing can look: a seeing model on a provider that cannot be shown says what to bind', async () => {
    state.resolution = { mode: 'none', reason: 'nobody' };
    await expect(tool.viewImage({ source: 'red.png' }, ctx('mistral'))).rejects.toThrow(/Bind one on the Topics page/);
    await expect(tool.viewImage({ source: 'red.png' }, ctx('blind'))).rejects.toMatchObject({ code: 'capability_not_configured' });
  });

  test('a CLI agent gets the file to open with its own reader', async () => {
    const out = await tool.viewImage({ source: 'red.png' }, ctx('cli'));
    expect(out.path).toBe(join(state.root, 'red.png'));
    expect(out[TOOL_MEDIA_KEY]).toBeUndefined();
  });

  test('a region is cropped first; outside the image says its size', async () => {
    await tool.viewImage({ source: 'red.png', region: { x: 0, y: 0, width: 10, height: 10 } }, ctx('blind'));
    expect(state.complete).toHaveBeenCalledTimes(1);
    await expect(tool.viewImage({ source: 'red.png', region: { x: 30, y: 0, width: 20, height: 10 } }, ctx('blind'))).rejects.toThrow(/40×20/);
    await expect(tool.viewImage({ source: 'red.png', region: { x: 'a' } }, ctx('blind'))).rejects.toThrow(/numeric/);
  });

  test('outside the workspace, not an image, or missing: refused before anything is read', async () => {
    await expect(tool.viewImage({ source: '../../etc/passwd' }, ctx('seeing'))).rejects.toThrow(/outside allowed workspace/);
    await writeFile(join(state.root, 'notes.txt'), 'hello');
    await expect(tool.viewImage({ source: 'notes.txt' }, ctx('seeing'))).rejects.toThrow(/not an image/);
    await expect(tool.viewImage({ source: 'nope.png' }, ctx('seeing'))).rejects.toThrow(/No image at/);
  });

  test('the same image more than three times in a run is refused', async () => {
    for (let i = 0; i < 3; i++) await tool.viewImage({ source: 'red.png' }, ctx('seeing'));
    await expect(tool.viewImage({ source: 'red.png' }, ctx('seeing'))).rejects.toThrow(/3 times/);
    // Another run starts afresh.
    await expect(tool.viewImage({ source: 'red.png' }, ctx('seeing', 'agent-9'))).resolves.toBeTruthy();
  });

  test('a URL is fetched through the SSRF guard and size-capped', async () => {
    const bytes = await red();
    state.fetchGuarded.mockResolvedValueOnce(new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'image/png' } }));
    const out = await tool.viewImage({ source: 'https://example.com/a.png' }, ctx('seeing'));
    expect(state.fetchGuarded).toHaveBeenCalledWith('https://example.com/a.png', expect.anything());
    expect(out.source).toBe('https://example.com/a.png');
    state.fetchGuarded.mockResolvedValueOnce(new Response('x', { status: 200, headers: { 'content-length': String(30 * 1024 * 1024) } }));
    await expect(tool.viewImage({ source: 'https://example.com/big.png' }, ctx('seeing'))).rejects.toThrow(/limit is 25 MB/);
    state.fetchGuarded.mockRejectedValueOnce(new Error('URL blocked (SSRF guard): private address'));
    await expect(tool.viewImage({ source: 'http://169.254.169.254/x.png' }, ctx('seeing'))).rejects.toThrow(/SSRF/);
  });
});

describe('read_document_text', () => {
  test('reads a workspace file through the document pipeline\'s extraction, in the session\'s protection level', async () => {
    await writeFile(join(state.root, 'scan.pdf'), '%PDF-1.7');
    await expect(tool.readDocumentText({ path: 'scan.pdf' }, ctx('blind'))).resolves.toEqual({ path: 'scan.pdf', text: '# Invoice\nTotal 42' });
    expect(state.extractText).toHaveBeenCalledWith(join(state.root, 'scan.pdf'), 'application/pdf', 'scan.pdf', { sessionId: 's1', userId: 'u1' });
    await expect(tool.readDocumentText({ path: '../x.pdf' }, ctx('blind'))).rejects.toThrow(/outside allowed workspace/);
  });
});
