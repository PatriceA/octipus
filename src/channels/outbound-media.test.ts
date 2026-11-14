/**
 * Channel adapters send bytes (a generated image, a spoken reply), not only
 * URLs: WhatsApp uploads and sends by id, Slack uploads into the thread,
 * a spoken reply becomes a voice note.
 */
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { isPublicPath } from '@/api/middleware/auth-guard';

afterEach(() => { vi.restoreAllMocks(); });
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

describe('WhatsApp', () => {
  test('bytes are uploaded to the media store and sent by id', async () => {
    const { WhatsAppChannel } = await import('./whatsapp/index');
    const channel = new WhatsAppChannel() as unknown as { accessToken: string; phoneNumberId: string; send: (to: string, r: unknown) => Promise<string> };
    channel.accessToken = 'tok';
    channel.phoneNumberId = '123';
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      calls.push({ url: String(url), body: init?.body });
      if (String(url).endsWith('/media')) return new Response(JSON.stringify({ id: 'media-1' }));
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.1' }] }));
    });
    await channel.send('4915', { content: 'Here', attachments: [{ type: 'image', data: Buffer.from('png'), mimeType: 'image/png', filename: 'cat.png' }] });
    expect(calls[0].url).toBe('https://graph.facebook.com/v21.0/123/media');
    expect(calls[0].body).toBeInstanceOf(FormData);
    const sent = JSON.parse(String(calls[1].body));
    expect(sent).toMatchObject({ type: 'image', image: { id: 'media-1' }, to: '4915' });
  });
});

describe('a failed attachment never loses the reply', () => {
  test('WhatsApp: the upload fails, the text still goes out', async () => {
    const { WhatsAppChannel } = await import('./whatsapp/index');
    const channel = new WhatsAppChannel() as unknown as { accessToken: string; phoneNumberId: string; send: (to: string, r: unknown) => Promise<string> };
    channel.accessToken = 'tok';
    channel.phoneNumberId = '123';
    const urls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      urls.push(String(url));
      if (String(url).endsWith('/media')) return new Response('unsupported', { status: 400 });
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.2' }] }));
    });
    await expect(channel.send('4915', { content: 'Text', attachments: [{ type: 'audio', data: Buffer.from('wav'), mimeType: 'audio/wav', filename: 'r.wav' }] })).resolves.toBe('wamid.2');
    expect(urls.at(-1)).toMatch(/\/messages$/);
  });

  test('Telegram: a refused photo, the text still goes out', async () => {
    const { TelegramChannel } = await import('./telegram/index');
    const channel = new TelegramChannel() as unknown as { bot: unknown; send: (id: string, r: unknown) => Promise<string> };
    const sendMessage = vi.fn(async () => ({ message_id: 7 }));
    channel.bot = { api: { sendPhoto: vi.fn(async () => { throw new Error('PHOTO_INVALID_DIMENSIONS'); }), sendMessage } };
    await channel.send('42', { content: 'Text', attachments: [{ type: 'image', data: Buffer.from('png'), mimeType: 'image/png' }] });
    expect(sendMessage).toHaveBeenCalled();
  });
});

describe('the turn\'s media for a channel', () => {
  test('read from the workspace; a speech file is a voice note; too large or gone is skipped', async () => {
    const { mkdtemp, rm, writeFile, truncate } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'octipus-chmedia-'));
    try {
      await writeFile(join(dir, 'a.png'), 'png');
      await writeFile(join(dir, 'r.mp3'), 'mp3');
      await writeFile(join(dir, 'big.png'), '');
      await truncate(join(dir, 'big.png'), 21 * 1024 * 1024);
      const { channelMediaAttachments } = await import('./index');
      const out = await channelMediaAttachments([
        { kind: 'image', path: join(dir, 'a.png'), mimeType: 'image/png', deliver: 'attach', filename: 'a.png' },
        { kind: 'audio', path: join(dir, 'r.mp3'), mimeType: 'audio/mpeg', deliver: 'voice' },
        { kind: 'image', path: join(dir, 'big.png'), mimeType: 'image/png', deliver: 'attach' },
        { kind: 'image', path: join(dir, 'gone.png'), mimeType: 'image/png', deliver: 'attach' },
      ]);
      expect(out).toEqual([
        { type: 'image', mimeType: 'image/png', data: Buffer.from('png'), filename: 'a.png' },
        { type: 'audio', mimeType: 'audio/mpeg', data: Buffer.from('mp3'), filename: undefined, voice: true },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('Slack', () => {
  test('bytes are uploaded into the reply\'s thread; a failed upload says so', async () => {
    const { SlackChannel } = await import('./slack/index');
    const channel = new SlackChannel() as unknown as { app: unknown; send: (id: string, r: unknown) => Promise<string> };
    const uploadV2 = vi.fn(async () => ({ ok: true }));
    const postMessage = vi.fn(async () => ({ ts: '111.222' }));
    channel.app = { client: { chat: { postMessage }, files: { uploadV2 } } };
    await channel.send('C1', { content: 'Here', attachments: [{ type: 'audio', data: Buffer.from('mp3'), mimeType: 'audio/mpeg', filename: 'reply.mp3' }] });
    expect(uploadV2).toHaveBeenCalledWith(expect.objectContaining({ channel_id: 'C1', thread_ts: '111.222', filename: 'reply.mp3', file: Buffer.from('mp3') }));
    uploadV2.mockRejectedValueOnce(new Error('missing_scope'));
    await channel.send('C1', { content: 'Again', threadId: '9.9', attachments: [{ type: 'image', data: Buffer.from('png'), mimeType: 'image/png', filename: 'a.png' }] });
    expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ thread_ts: '9.9', text: expect.stringMatching(/files:write/) }));
  });
});

describe('voice notes and public links', () => {
  test.skipIf(!hasFfmpeg)('a spoken reply becomes OGG/Opus', async () => {
    const { toVoiceNote } = await import('@/voice/voice-note');
    const wav = spawnSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=d=1', '-f', 'wav', '-'], { maxBuffer: 10_000_000 }).stdout;
    const note = await toVoiceNote(wav, 'audio/wav');
    expect(note.subarray(0, 4).toString('latin1')).toBe('OggS');
    expect(await toVoiceNote(note, 'audio/ogg')).toBe(note);
  });

  test('the public media route is open only for a well-formed token', () => {
    expect(isPublicPath(`/api/media/public/${'a'.repeat(32)}`)).toBe(true);
    expect(isPublicPath('/api/media/public/short')).toBe(false);
    expect(isPublicPath(`/api/media/public/${'a'.repeat(32)}/x`)).toBe(false);
  });
});
