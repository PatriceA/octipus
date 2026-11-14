import type { Page } from '@playwright/test';
import { dataUrlToBlob, mediaFileName, mediaFromAttachments, mediaFromResult, sessionFileApiPath } from '../../web/lib/turn-media';
import { json, selectChatSession } from './fixtures/api-stubs';
import { expect, test } from './fixtures/auth';
import { stubGateway } from './fixtures/gateway';

/**
 * Turn media (src/core/media/turn-media.ts): the images and speech a turn made
 * for the person show under the answer, live from the turn result's `media`
 * and after a reload from the row's `metadata.attachments`.
 */

// 1×1 transparent PNG.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const IMAGE = '/workspace/u1/generated/sunset.png';
const SPEECH = '/workspace/u1/speech/reply.mp3';

test.describe('turn media mapping', () => {
  test('history keeps only the answer\'s own media, normalised', () => {
    const media = mediaFromAttachments([
      { type: 'image', path: '/w/.octipus/attachments/upload.png', mimeType: 'image/png', source: 'user' },
      { type: 'image', path: '/w/tool-shot.png', mimeType: 'image/png', source: 'tool' },
      { type: 'image', path: IMAGE, mimeType: 'image/png', source: 'assistant', deliver: 'attach', filename: 'sunset.png' },
      { type: 'audio', path: SPEECH, mimeType: 'audio/mpeg', source: 'assistant', deliver: 'voice' },
      { type: 'video', path: '/w/clip.mp4', mimeType: 'video/mp4', source: 'assistant' },
      { type: 'image', mimeType: 'image/png', source: 'assistant' },
      null,
    ]);
    expect(media).toEqual([
      { kind: 'image', path: IMAGE, mimeType: 'image/png', deliver: 'attach', filename: 'sunset.png' },
      { kind: 'audio', path: SPEECH, mimeType: 'audio/mpeg', deliver: 'voice' },
    ]);
    expect(mediaFromAttachments([{ type: 'image', path: '/w/a.png', mimeType: 'image/png', source: 'user' }])).toBeUndefined();
    expect(mediaFromAttachments(undefined)).toBeUndefined();
  });

  test('a live result maps to the same shape as its persisted row', () => {
    const live = mediaFromResult([
      { kind: 'image', path: IMAGE, mimeType: 'image/png', deliver: 'attach', filename: 'sunset.png' },
      { kind: 'audio', path: SPEECH, mimeType: 'audio/mpeg', deliver: 'voice', filename: undefined },
    ]);
    const stored = mediaFromAttachments([
      { type: 'image', path: IMAGE, mimeType: 'image/png', filename: 'sunset.png', source: 'assistant', deliver: 'attach' },
      { type: 'audio', path: SPEECH, mimeType: 'audio/mpeg', source: 'assistant', deliver: 'voice' },
    ]);
    expect(live).toEqual(stored);
    expect(mediaFromResult([])).toBeUndefined();
    expect(mediaFromResult({ kind: 'image' })).toBeUndefined();
  });

  test('names, API paths and data URLs', async () => {
    expect(mediaFileName({ kind: 'image', path: IMAGE, mimeType: 'image/png', deliver: 'attach' })).toBe('sunset.png');
    expect(mediaFileName({ kind: 'audio', path: SPEECH, mimeType: 'audio/mpeg', deliver: 'voice', filename: 'answer.mp3' })).toBe('answer.mp3');
    expect(sessionFileApiPath('sess-1', '/a b/c.png')).toBe('/sessions/sess-1/files?path=%2Fa%20b%2Fc.png');
    const blob = dataUrlToBlob(PNG)!;
    expect(blob.type).toBe('image/png');
    expect([...new Uint8Array(await blob.arrayBuffer()).slice(1, 4)].map(c => String.fromCharCode(c)).join('')).toBe('PNG');
    expect(dataUrlToBlob('data:text/plain,hello')).toBeNull();
    expect(dataUrlToBlob('/api/x')).toBeNull();
  });
});

/** Session files: the image as the route returns it; the audio as `binary` (no bytes) unless `audioBytes`. */
async function stubSessionFiles(page: Page, opts: { audioBytes?: boolean } = {}): Promise<string[]> {
  const requested: string[] = [];
  await page.route('**/api/sessions/sess-1/files?*', route => {
    const path = new URL(route.request().url()).searchParams.get('path')!;
    requested.push(path);
    if (path === IMAGE) return json(route, 200, { type: 'image', path, mimeType: 'image/png', dataUrl: PNG, version: 'v1', size: 68, modifiedAt: '2026-11-01T10:00:00Z' });
    if (path === SPEECH && opts.audioBytes) return json(route, 200, { type: 'audio', path, mimeType: 'audio/mpeg', dataUrl: 'data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0U=', version: 'v1', size: 14, modifiedAt: '2026-11-01T10:00:00Z' });
    return json(route, 200, { type: 'binary', path, version: 'v1', size: 4096, modifiedAt: '2026-11-01T10:00:00Z' });
  });
  return requested;
}

const storedAnswer = {
  id: 'answer-1', role: 'assistant', content: 'Here is the sunset, and I read it out.', createdAt: '2026-11-01T10:00:00Z',
  metadata: { attachments: [
    { type: 'image', path: IMAGE, mimeType: 'image/png', filename: 'sunset.png', source: 'assistant', deliver: 'attach' },
    { type: 'audio', path: SPEECH, mimeType: 'audio/mpeg', source: 'assistant', deliver: 'voice' },
  ] },
};

test('an answer\'s stored media shows under it after a reload', async ({ authenticatedPage: page }) => {
  await page.route('**/api/sessions/sess-1/messages**', route => json(route, 200, { messages: [storedAnswer] }));
  const requested = await stubSessionFiles(page);
  await page.goto('/chat');
  await selectChatSession(page, 'sess-1');

  const image = page.getByTestId('turn-media-image');
  await expect(image.locator('img')).toHaveAttribute('src', /^blob:/);
  await expect(image.getByRole('link', { name: 'Download sunset.png' })).toHaveAttribute('download', 'sunset.png');
  // No bytes for audio from the files route yet: said, not a broken player.
  await expect(page.getByTestId('turn-media-audio')).toContainText('audio cannot be played in the browser yet');
  expect(requested).toEqual(expect.arrayContaining([IMAGE, SPEECH]));

  // The thumbnail opens the image in the in-chat file view.
  await image.getByRole('button', { name: 'Open sunset.png' }).click();
  await expect(page.locator('.workspace-file-view img')).toBeVisible();
});

test('a live answer\'s media plays, and matches its persisted copy', async ({ authenticatedPage: page }) => {
  let persisted: unknown[] = [];
  const gateway = await stubGateway(page);
  await page.route('**/api/sessions/sess-1/messages**', route => json(route, 200, { messages: persisted }));
  await stubSessionFiles(page, { audioBytes: true });
  await page.goto('/chat');
  await selectChatSession(page, 'sess-1');
  await expect.poll(() => gateway.subscribed()).toBe(1);

  gateway.event('chat.response', { response: {
    response: storedAnswer.content,
    media: [
      { kind: 'image', path: IMAGE, mimeType: 'image/png', deliver: 'attach', filename: 'sunset.png' },
      { kind: 'audio', path: SPEECH, mimeType: 'audio/mpeg', deliver: 'voice' },
    ],
  } }, 'sess-1');

  await expect(page.getByTestId('turn-media-image').locator('img')).toHaveAttribute('src', /^blob:/);
  const audio = page.getByTestId('turn-media-audio');
  await expect(audio.locator('audio')).toHaveAttribute('src', /^blob:/);
  await expect(audio.getByRole('link', { name: 'Download reply.mp3' })).toHaveAttribute('download', 'reply.mp3');

  persisted = [{ ...storedAnswer, createdAt: new Date().toISOString() }];
  await page.reload();
  await selectChatSession(page, 'sess-1');
  await expect(page.getByTestId('turn-media')).toHaveCount(1);
  await expect(page.getByTestId('turn-media-audio').locator('audio')).toHaveAttribute('src', /^blob:/);
});
