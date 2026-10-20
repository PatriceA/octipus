import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { WorkspaceFS } from '@/security/workspace-fs';
import { buildRootAttachmentContext } from './image-attachments';

const mocks = vi.hoisted(() => ({ vision: vi.fn(), complete: vi.fn() }));
vi.mock('@/models/model-registry', () => ({ getModelRegistry: () => ({ getModelForTopic: mocks.vision }) }));
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

test('API auxiliary description is explicitly fallible and preserves the original reference', async () => {
  root = await mkdtemp(join(tmpdir(), 'octipus-images-'));
  await writeFile(join(root, 'screen.png'), Buffer.from([137, 80, 78, 71]));
  mocks.vision.mockResolvedValue({ name: 'vision', modelId: 'configured-vision' });
  mocks.complete.mockResolvedValue({ content: 'A French quiz' });
  const result = await buildRootAttachmentContext(WorkspaceFS.withRoot(root), [{ path: 'screen.png' }], false, 'user', 'Explain spacing');
  expect(result.context).toContain('Supplemental image description (may contain errors');
  expect(result.context).toContain(join(root, 'screen.png'));
  expect(result.imagePaths).toEqual([]);
});
