import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { imageAttachment, readImageFile } from './image-attachments';
import { decodeChatAttachment, storeChatUploads } from '@/core/chat-uploads';
import { WorkspaceFS } from '@/security/workspace-fs';

test('local TUI image survives gateway serialization and backend storage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'octi-tui-image-'));
  const bytes = Buffer.from([137, 80, 78, 71, 0, 9]);
  await writeFile(join(root, 'my image.png'), bytes);
  const wire = JSON.parse(JSON.stringify(await readImageFile('"my image.png"', root)));
  const decoded = decodeChatAttachment(wire);
  expect(Buffer.from(await decoded.arrayBuffer())).toEqual(bytes);
  expect((await storeChatUploads(WorkspaceFS.withRoot(root), [decoded]))[0].path).toMatch(/my_image.png$/);
});
test('empty images and malformed gateway base64 are rejected', () => {
  expect(() => imageAttachment(Buffer.alloc(0), 'image.png', 'image/png')).toThrow('contain data');
  expect(() => decodeChatAttachment({ name: 'x.png', mimeType: 'image/png', data: 'not base64!' })).toThrow('valid base64');
});
