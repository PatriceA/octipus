import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { WorkspaceFS } from '@/security/workspace-fs';
import { buildRootAttachmentContext } from './image-attachments';

const mocks = vi.hoisted(() => ({ vision: vi.fn(), complete: vi.fn() }));
vi.mock('@/models/model-registry', () => ({ getModelRegistry: () => ({ getModelForTopic: mocks.vision, getDefaultModel: async () => null }) }));
vi.mock('@/models/litellm-client', () => ({ getLiteLLMClient: () => ({ completeVision: mocks.complete }) }));
let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); vi.clearAllMocks(); });

test('CLI attachment keeps the original path and never calls OCR', async () => {
  root = await mkdtemp(join(tmpdir(), 'octipus-images-'));
  await writeFile(join(root, 'screen.png'), Buffer.from([137, 80, 78, 71]));
  const result = await buildRootAttachmentContext(WorkspaceFS.withRoot(root), [{ path: 'screen.png' }], true, 'user', 'Explain spacing');
  expect(result.imagePaths).toEqual([join(root, 'screen.png')]);
  expect(result.context).toContain('Original image supplied');
  expect(mocks.vision).not.toHaveBeenCalled();
  expect(mocks.complete).not.toHaveBeenCalled();
});

test('a model without tool calls gets an up-front description: explicitly fallible, the original reference kept', async () => {
  root = await mkdtemp(join(tmpdir(), 'octipus-images-'));
  await writeFile(join(root, 'screen.png'), Buffer.from([137, 80, 78, 71]));
  mocks.vision.mockResolvedValue({ name: 'vision', modelId: 'configured-vision', topicRoles: { vision: 'primary' } });
  mocks.complete.mockResolvedValue({ content: 'A French quiz' });
  const small = { name: 'small', provider: 'ollama', supportsVision: false, supportsTools: false } as never;
  const result = await buildRootAttachmentContext(WorkspaceFS.withRoot(root), [{ path: 'screen.png' }], false, 'user', 'Explain spacing', undefined, undefined, small);
  expect(result.context).toContain('Supplemental image description (may contain errors');
  expect(result.context).toContain(join(root, 'screen.png'));
  expect(result.imagePaths).toEqual([]);
  expect(result.media).toEqual([]);
});

test('a model that cannot see but calls tools gets the path and decides whether to look (no eager description)', async () => {
  root = await mkdtemp(join(tmpdir(), 'octipus-images-'));
  await writeFile(join(root, 'screen.png'), Buffer.from([137, 80, 78, 71]));
  mocks.vision.mockResolvedValue({ name: 'vision', modelId: 'configured-vision', topicRoles: { vision: 'primary' } });
  const blind = { name: 'blind', provider: 'openai', supportsVision: false, supportsTools: true } as never;
  const result = await buildRootAttachmentContext(WorkspaceFS.withRoot(root), [{ path: 'screen.png' }], false, 'user', 'Explain spacing', undefined, undefined, blind);
  expect(result.context).toMatch(/call vision__view_image with source/);
  expect(mocks.complete).not.toHaveBeenCalled();
  expect(result.media).toEqual([]);
});

test('a model that reads images gets the image itself (a normalized copy), nothing described', async () => {
  root = await mkdtemp(join(tmpdir(), 'octipus-images-'));
  const sharp = (await import('sharp')).default;
  await writeFile(join(root, 'photo.png'), await sharp({ create: { width: 8, height: 8, channels: 3, background: '#c00' } }).png().toBuffer());
  const seeing = { name: 'seeing', provider: 'anthropic', supportsVision: true, supportsTools: true } as never;
  const result = await buildRootAttachmentContext(WorkspaceFS.withRoot(root), [{ path: 'photo.png' }], false, 'user', 'What colour?', undefined, undefined, seeing);
  expect(result.media).toHaveLength(1);
  expect(result.media[0]).toMatchObject({ kind: 'image', mimeType: 'image/png', source: 'user' });
  expect(result.media[0].path.startsWith(join(root, '.octipus/media/cache'))).toBe(true);
  expect(result.context).toMatch(/Shown to you directly/);
  expect(mocks.complete).not.toHaveBeenCalled();
});

test('imageInputMode: describe when asked or without tools; native for a seeing non-CLI model; else tool', async () => {
  const { imageInputMode } = await import('./image-attachments');
  expect(imageInputMode({ supportsVision: true, supportsTools: true, provider: 'openai' }, 'describe')).toBe('describe');
  expect(imageInputMode({ supportsVision: true, supportsTools: false, provider: 'ollama' }, 'auto')).toBe('describe');
  expect(imageInputMode({ supportsVision: true, supportsTools: true, provider: 'openai' }, 'auto')).toBe('native');
  expect(imageInputMode({ supportsVision: true, supportsTools: true, provider: 'cli' }, 'auto')).toBe('tool');
  expect(imageInputMode({ supportsVision: false, supportsTools: true, provider: 'openai' }, 'auto')).toBe('tool');
  expect(imageInputMode(null, 'auto')).toBe('tool');
});

test('remote project attachments use the selected reader rather than resolving a host file', async () => {
  root = await mkdtemp(join(tmpdir(), 'octipus-images-'));
  const reader = vi.fn(async (path: string) => ({ type: 'text' as const, path, content: 'remote project content', version: 'remote-v2', size: 22, modifiedAt: new Date().toISOString() }));
  const result = await buildRootAttachmentContext(WorkspaceFS.withRoot(root), [{ path: '/srv/project/brief.md', version: 'remote-v1' }], false, 'user', 'Update the remote file', undefined, reader);
  expect(reader).toHaveBeenCalledWith('/srv/project/brief.md');
  expect(result.context).toContain('remote project content');
  expect(result.context).toContain('changed since the user last viewed');
  expect(result.context).not.toContain('could not be read');
});

test('an attached recording is transcribed with the turn; a model that hears gets it too only when asked (native)', async () => {
  root = await mkdtemp(join(tmpdir(), 'octipus-images-'));
  await writeFile(join(root, 'memo.wav'), Buffer.from('RIFFfake'));
  const gates = await import('@/core/capabilities/gates');
  gates.setCapabilitiesForTest({ hear: true });
  const resolve = await import('@/voice/resolve');
  const spy = vi.spyOn(resolve, 'transcribeWithLane').mockResolvedValue({ text: 'buy milk', segments: [], language: 'en', duration: 1, model: 'm' });
  const hearing = { name: 'hearing', provider: 'openai', supportsVision: false, supportsTools: true, supportsAudioInput: true } as never;
  const result = await buildRootAttachmentContext(WorkspaceFS.withRoot(root), [{ path: 'memo.wav' }], false, 'user', 'What did I say?', 'sess', undefined, hearing);
  expect(result.context).toMatch(/Transcript \(speech to text; may contain errors\)[\s\S]*buy milk/);
  expect(spy).toHaveBeenCalledWith(expect.any(Buffer), expect.objectContaining({ sessionId: 'sess', format: 'wav' }));
  expect(result.media).toEqual([]); // media.audioInput defaults to transcribe
  gates.setCapabilitiesForTest({ hear: false });
  const off = await buildRootAttachmentContext(WorkspaceFS.withRoot(root), [{ path: 'memo.wav' }], false, 'user', 'What did I say?', 'sess', undefined, hearing);
  expect(off.context).toMatch(/No speech-to-text engine is configured/);
  gates.resetCapabilitiesForTest();
  spy.mockRestore();
});
