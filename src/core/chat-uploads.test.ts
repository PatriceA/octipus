import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { WorkspaceFS } from '@/security/workspace-fs';
import { storeChatUploads } from './chat-uploads';

test('pasted image bytes are preserved inside the session workspace', async () => {
  const fs = WorkspaceFS.withRoot(await mkdtemp(join(tmpdir(), 'octi-upload-')));
  const bytes = new Uint8Array([137, 80, 78, 71, 0, 1]);
  const [upload] = await storeChatUploads(fs, [new File([bytes], '../../paste.png', { type: 'image/png' })]);
  expect(upload.path).toMatch(/^\.octipus\/attachments\/[^/]+\/[^/]+\.png$/);
  expect(new Uint8Array(await readFile(fs.resolve(upload.path)))).toEqual(bytes);
});
test('empty files and too many files fail visibly', async () => {
  const fs = WorkspaceFS.withRoot(await mkdtemp(join(tmpdir(), 'octi-upload-')));
  await expect(storeChatUploads(fs, [new File([], 'empty.png')])).rejects.toThrow('must contain data');
  await expect(storeChatUploads(fs, Array.from({ length: 11 }, () => new File(['a'], 'a')))).rejects.toThrow('between 1 and 10');
});
