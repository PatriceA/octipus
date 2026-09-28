import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, resolve } from 'node:path';
import type { ChatAttachment } from '@/shared/chat-attachments';
const MAX_BYTES = 10 * 1024 * 1024;
const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

export function imageAttachment(bytes: Buffer, name: string, mimeType: string): ChatAttachment {
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('Images must contain data and be no larger than 10 MiB.');
  return { name, mimeType, data: bytes.toString('base64') };
}
export async function readImageFile(path: string, cwd = process.cwd()): Promise<ChatAttachment> {
  path = path.trim().replace(/^["']|["']$/g, '').replace(/^~(?=[/\\])/, homedir());
  const target = resolve(cwd, path);
  const mime = MIME[extname(target).toLowerCase()];
  if (!mime) throw new Error('Attach a PNG, JPEG, GIF, or WebP image.');
  if ((await stat(target)).size > MAX_BYTES) throw new Error('Image exceeds 10 MiB.');
  return imageAttachment(await readFile(target), basename(target), mime);
}
export async function readClipboardImage(): Promise<ChatAttachment> {
  const run = (binary: string, args: string[]) => new Promise<Buffer>((resolveBuffer, reject) => {
    execFile(binary, args, { encoding: 'buffer', maxBuffer: 15 * 1024 * 1024, timeout: 5000, windowsHide: true },
      (error, stdout) => error ? reject(new Error('No clipboard image available. Use /attach <image-path>, or install a clipboard image helper for your desktop.')) : resolveBuffer(stdout));
  });
  let bytes: Buffer;
  if (process.platform === 'win32') {
    const output = await run('powershell.exe', ['-NoProfile', '-STA', '-Command',
      'Add-Type -AssemblyName System.Windows.Forms; $image = [System.Windows.Forms.Clipboard]::GetImage(); if ($null -eq $image) { exit 1 }; $stream = New-Object System.IO.MemoryStream; try { $image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png); [Console]::Write([Convert]::ToBase64String($stream.ToArray())) } finally { $image.Dispose(); $stream.Dispose() }']);
    bytes = Buffer.from(output.toString().trim(), 'base64');
  } else if (process.platform === 'darwin') {
    bytes = await run('pngpaste', ['-']);
  } else {
    try { bytes = await run('wl-paste', ['--type', 'image/png']); }
    catch { bytes = await run('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']); }
  }
  return imageAttachment(bytes, 'clipboard.png', 'image/png');
}
