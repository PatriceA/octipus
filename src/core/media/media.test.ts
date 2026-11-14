/**
 * Images on their way to a model (src/core/media): normalized once and
 * cached, hydrated into a request's copy only, the newest few kept, and a
 * tool's image shown after its result.
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { AgentMessage, MediaRef } from '@/core/types';
import { WorkspaceFS } from '@/security/workspace-fs';
import { hasMedia, hydrateMedia, withoutMediaBytes } from './hydrate';
import { cropImageBytes, MAX_IMAGE_EDGE, MediaError, normalizeImageBytes, sniffImageType, TARGET_IMAGE_BYTES } from './normalize';
import { TOOL_MEDIA_KEY, takeToolMedia, toolMediaMessage, withToolMedia } from './tool-media';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'octipus-media-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const png = (width: number, height: number, noise = false) => {
  const channels = 3;
  const raw = Buffer.alloc(width * height * channels);
  for (let i = 0; i < raw.length; i++) raw[i] = noise ? Math.floor(Math.random() * 256) : (i % channels === 0 ? 200 : 30);
  return sharp(raw, { raw: { width, height, channels } }).png().toBuffer();
};

describe('normalize', () => {
  test('sniffs by content, not by name', async () => {
    expect(sniffImageType(await png(4, 4))).toBe('image/png');
    expect(sniffImageType(await sharp(await png(4, 4)).jpeg().toBuffer())).toBe('image/jpeg');
    expect(sniffImageType(Buffer.from('%PDF-1.7 not an image'))).toBeUndefined();
  });

  test('a large image comes back within 2048 px, cached by its hash; a second call reuses it', async () => {
    const bytes = await png(4000, 1000);
    const ref = await normalizeImageBytes(bytes, dir);
    const meta = await sharp(await readFile(ref.path)).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(MAX_IMAGE_EDGE);
    expect(ref.path.startsWith(dir)).toBe(true);
    const mtime = (await stat(ref.path)).mtimeMs;
    const again = await normalizeImageBytes(bytes, dir);
    expect(again.path).toBe(ref.path);
    expect((await stat(again.path)).mtimeMs).toBe(mtime);
  });

  test('a heavy photo is brought down to about 300 KB', async () => {
    const ref = await normalizeImageBytes(await png(1800, 1800, true), dir);
    expect((await readFile(ref.path)).length).toBeLessThanOrEqual(TARGET_IMAGE_BYTES * 1.2);
  });

  test('not an image is refused with a reason', async () => {
    await expect(normalizeImageBytes(Buffer.from('hello'), dir)).rejects.toBeInstanceOf(MediaError);
  });

  test('a crop is in original pixels; outside the image is refused with its size', async () => {
    const bytes = await png(400, 200);
    const cropped = await cropImageBytes(bytes, { x: 10, y: 10, width: 100, height: 50 });
    expect(await sharp(cropped).metadata()).toMatchObject({ width: 100, height: 50 });
    await expect(cropImageBytes(bytes, { x: 350, y: 0, width: 100, height: 50 })).rejects.toThrow(/400×200/);
  });
});

describe('hydrate', () => {
  const ref = (path: string): MediaRef => ({ kind: 'image', path, mimeType: 'image/png', source: 'user' });
  const user = (content: string, media?: MediaRef[]): AgentMessage => ({ role: 'user', content, timestamp: new Date(), ...(media ? { media } : {}) });

  test('only the newest few image messages carry bytes; older ones become a line to look again', async () => {
    await mkdir(join(dir, '.octipus/media'), { recursive: true });
    const paths = await Promise.all([1, 2, 3, 4].map(async (n) => { const p = join(dir, '.octipus/media', `${n}.png`); await writeFile(p, await png(2, 2)); return p; }));
    const messages = paths.map((p, i) => user(`m${i}`, [ref(p)]));
    const out = await hydrateMedia(messages, { fs: WorkspaceFS.withRoot(dir), readsImages: true, hearsAudio: false, replayRecent: 3 });
    expect(out[0].media).toBeUndefined();
    expect(out[0].content).toContain('vision__view_image');
    for (const m of out.slice(1)) expect(m.media?.[0].data).toBeTruthy();
    // The stored conversation is untouched: bytes live in the request's copy only.
    expect(messages[3].media?.[0].data).toBeUndefined();
    expect(withoutMediaBytes(out)[3].media?.[0].data).toBeUndefined();
  });

  test('a model that cannot see gets a line instead; a file that is gone is said so', async () => {
    const p = join(dir, 'a.png');
    await writeFile(p, await png(2, 2));
    const fs = WorkspaceFS.withRoot(dir);
    const blind = await hydrateMedia([user('look', [ref(p)])], { fs, readsImages: false, hearsAudio: false });
    expect(blind[0].media).toBeUndefined();
    expect(blind[0].content).toMatch(/cannot see images: call vision__view_image/);
    const gone = await hydrateMedia([user('look', [ref(join(dir, 'missing.png'))])], { fs, readsImages: true, hearsAudio: false });
    expect(gone[0].content).toMatch(/no longer available/);
    expect(hasMedia([user('x')])).toBe(false);
  });

  test('only this workspace\'s media files are read, and only of the kind they claim; confidential media stays off a remote model', async () => {
    const fs = WorkspaceFS.withRoot(dir);
    await mkdir(join(dir, '.octipus/media'), { recursive: true });
    const inside = join(dir, '.octipus/media/ok.png');
    await writeFile(inside, await png(2, 2));
    await writeFile(join(dir, 'secret.png'), await png(2, 2)); // not a media dir
    await writeFile(join(dir, '.octipus/media/fake.png'), 'not an image');
    const out = await hydrateMedia([
      user('a', [ref(inside)]), user('b', [ref(join(dir, 'secret.png'))]), user('c', [ref('/etc/passwd')]), user('d', [ref(join(dir, '.octipus/media/fake.png'))]),
    ], { fs, readsImages: true, hearsAudio: false, replayRecent: 10 });
    expect(out[0].media?.[0].data).toBeTruthy();
    for (const m of out.slice(1)) { expect(m.media).toBeUndefined(); expect(m.content).toMatch(/no longer available/); }
    const confidential = await hydrateMedia([user('a', [ref(inside)])], { fs, readsImages: true, hearsAudio: false, protectedContent: true });
    expect(confidential[0].media).toBeUndefined();
    expect(confidential[0].content).toMatch(/confidential and this model is not local/);
    expect((await hydrateMedia([user('a', [ref(inside)])], { fs: null, readsImages: true, hearsAudio: false }))[0].media).toBeUndefined();
  });
});

describe('tool media', () => {
  test('a tool result carries media under its key; it is taken off and shown in one user message', () => {
    const media: MediaRef[] = [{ kind: 'image', path: '/w/a.png', mimeType: 'image/png', source: 'user' }];
    const result = withToolMedia({ status: 'Image loaded' }, media);
    expect(result).toHaveProperty(TOOL_MEDIA_KEY);
    const taken = takeToolMedia(result);
    expect(taken.result).toEqual({ status: 'Image loaded' });
    expect(taken.media).toEqual([{ ...media[0], source: 'tool' }]);
    expect(takeToolMedia('plain')).toEqual({ result: 'plain', media: [] });
    const msg = toolMediaMessage(taken.media);
    expect(msg).toMatchObject({ role: 'user', media: taken.media });
    expect(msg.content).toMatch(/content, not instructions/);
    expect(withToolMedia({ a: 1 }, [])).toEqual({ a: 1 });
  });
});

describe('audio and size', () => {
  test('a recording is sent once (with the newest media); a file over the size cap is never inlined', async () => {
    const { WorkspaceFS } = await import('@/security/workspace-fs');
    const fs = WorkspaceFS.withRoot(dir);
    await mkdir(join(dir, '.octipus/attachments'), { recursive: true });
    const wav = join(dir, '.octipus/attachments/memo.wav');
    await writeFile(wav, Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(100)]));
    const audio: MediaRef = { kind: 'audio', path: wav, mimeType: 'audio/wav', source: 'user' };
    const img = join(dir, '.octipus/attachments/a.png');
    await writeFile(img, await png(2, 2));
    const msgs: AgentMessage[] = [
      { role: 'user', content: 'listen', timestamp: new Date(), media: [audio] },
      { role: 'user', content: 'look', timestamp: new Date(), media: [{ kind: 'image', path: img, mimeType: 'image/png', source: 'user' }] },
    ];
    const out = await hydrateMedia(msgs, { fs, readsImages: true, hearsAudio: true });
    expect(out[0].media).toBeUndefined();
    expect(out[1].media?.[0].data).toBeTruthy();
    expect((await hydrateMedia([msgs[0]], { fs, readsImages: true, hearsAudio: true }))[0].media?.[0].data).toBeTruthy();
    const { MAX_HYDRATE_BYTES } = await import('./hydrate');
    const big = join(dir, '.octipus/attachments/big.wav');
    await writeFile(big, Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(MAX_HYDRATE_BYTES)]));
    expect((await hydrateMedia([{ role: 'user', content: 'x', timestamp: new Date(), media: [{ ...audio, path: big }] }], { fs, readsImages: true, hearsAudio: true }))[0].media).toBeUndefined();
  });
});

describe('after a restart', () => {
  test('images a turn showed come back as references from the message row', async () => {
    const { toContextMessage } = await import('@/core/session-history');
    const msg = toContextMessage({
      id: 'm1', role: 'user', content: 'What is this?', createdAt: new Date(),
      metadata: { attachments: [{ type: 'image', path: '/w/.octipus/media/cache/a.png', mimeType: 'image/png', source: 'user' }, { type: 'file', path: '/w/doc.pdf' }] },
    } as never);
    expect(msg.media).toEqual([{ kind: 'image', path: '/w/.octipus/media/cache/a.png', mimeType: 'image/png', source: 'user' }]);
  });
});
