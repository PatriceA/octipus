/**
 * A spoken reply as a voice note: OGG/Opus, which Telegram and WhatsApp show
 * as a voice message (an MP3 or WAV arrives as a music file). The input is
 * this install's own speech output; ffmpeg is guarded all the same.
 */
import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function toVoiceNote(audio: Buffer, mimeType: string): Promise<Buffer> {
  if (/ogg|opus/.test(mimeType)) return audio;
  const { runFfmpegTool, safeInput } = await import('./ffmpeg');
  const base = join(tmpdir(), `octipus-voice-${randomUUID()}`);
  const ext = /mpeg|mp3/.test(mimeType) ? 'mp3' : /wav/.test(mimeType) ? 'wav' : /flac/.test(mimeType) ? 'flac' : 'audio';
  const src = `${base}.${ext}`;
  const out = `${base}.ogg`;
  try {
    await writeFile(src, audio);
    await runFfmpegTool('ffmpeg', ['-y', ...safeInput(src), '-vn', '-ac', '1', '-c:a', 'libopus', '-b:a', '32k', out], 120_000);
    return await readFile(out);
  } finally {
    await rm(src, { force: true });
    await rm(out, { force: true });
  }
}
