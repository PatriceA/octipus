/**
 * Images made fit for a model (docs/MEDIA.md): any format a user or a tool
 * produces (HEIC, AVIF, TIFF, BMP, GIF, WebP, PNG, JPEG) becomes a PNG or
 * JPEG no larger than 2048 px on its long edge and about 300 KB, because an
 * image in the conversation is re-sent with every later request. The result
 * is cached by the source's SHA-256 next to the originals, so a picture is
 * converted once. The original is never changed.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { MediaRef } from '@/core/types';

export const MAX_IMAGE_EDGE = 2048;
export const TARGET_IMAGE_BYTES = 300 * 1024;
/** What is read at all: a larger file is refused, not decoded. */
export const MAX_SOURCE_IMAGE_BYTES = 25 * 1024 * 1024;

const SIGNATURES: Array<{ mime: string; test: (b: Buffer) => boolean }> = [
  { mime: 'image/png', test: (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47 },
  { mime: 'image/jpeg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', test: (b) => b.subarray(0, 4).toString('latin1') === 'GIF8' },
  { mime: 'image/webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  { mime: 'image/bmp', test: (b) => b.subarray(0, 2).toString('latin1') === 'BM' },
  { mime: 'image/tiff', test: (b) => ['II*\0', 'MM\0*'].includes(b.subarray(0, 4).toString('latin1')) },
  { mime: 'image/heic', test: (b) => b.subarray(4, 8).toString('latin1') === 'ftyp' && /^(heic|heix|hevc|mif1|msf1)$/.test(b.subarray(8, 12).toString('latin1')) },
  { mime: 'image/avif', test: (b) => b.subarray(4, 8).toString('latin1') === 'ftyp' && /^(avif|avis)$/.test(b.subarray(8, 12).toString('latin1')) },
];

/** The image type of `bytes` by its magic number (not its name), or undefined. */
export function sniffImageType(bytes: Buffer): string | undefined {
  return SIGNATURES.find((s) => s.test(bytes))?.mime;
}

export class MediaError extends Error {}

/** Where model-ready copies live, relative to a workspace root. */
export const MEDIA_CACHE_DIR = '.octipus/media/cache';

export interface ImageRegion { x: number; y: number; width: number; height: number }

/**
 * A crop of `bytes` in original pixels (EXIF rotation applied first, as the
 * model sees it), PNG. A region outside the image is refused with its size.
 */
export async function cropImageBytes(bytes: Buffer, region: ImageRegion): Promise<Buffer> {
  if (!sniffImageType(bytes)) throw new MediaError('Not an image this install can read (PNG, JPEG, GIF, WebP, BMP, TIFF, HEIC or AVIF).');
  const { default: sharp } = await import('sharp');
  const rotated = await sharp(bytes, { animated: false, limitInputPixels: 100_000_000 }).rotate().toBuffer({ resolveWithObject: true });
  const { width, height } = rotated.info;
  const r = { left: Math.round(region.x), top: Math.round(region.y), width: Math.round(region.width), height: Math.round(region.height) };
  if (r.left < 0 || r.top < 0 || r.width < 1 || r.height < 1 || r.left + r.width > width || r.top + r.height > height) {
    throw new MediaError(`The region is outside the image, which is ${width}×${height} pixels.`);
  }
  return sharp(rotated.data).extract(r).png().toBuffer();
}

/**
 * The model-ready copy of an image file: PNG or JPEG, ≤ 2048 px, about
 * ≤ 300 KB. `cacheDir` holds the copies (keyed by the source's SHA-256).
 */
export async function normalizeImage(sourcePath: string, cacheDir: string): Promise<MediaRef> {
  const info = await stat(sourcePath);
  if (info.size > MAX_SOURCE_IMAGE_BYTES) throw new MediaError(`Image is ${Math.round(info.size / 1024 / 1024)} MB; the limit is ${MAX_SOURCE_IMAGE_BYTES / 1024 / 1024} MB.`);
  return normalizeImageBytes(await readFile(sourcePath), cacheDir);
}

/** `normalizeImage` for bytes already in hand (a download, a data URL, a remote file). */
export async function normalizeImageBytes(bytes: Buffer, cacheDir: string): Promise<MediaRef> {
  if (bytes.length > MAX_SOURCE_IMAGE_BYTES) throw new MediaError(`Image is ${Math.round(bytes.length / 1024 / 1024)} MB; the limit is ${MAX_SOURCE_IMAGE_BYTES / 1024 / 1024} MB.`);
  const sourceType = sniffImageType(bytes);
  if (!sourceType) throw new MediaError('Not an image this install can read (PNG, JPEG, GIF, WebP, BMP, TIFF, HEIC or AVIF).');
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  const cached = await findCached(cacheDir, sha256);
  if (cached) return cached;

  const { default: sharp } = await import('sharp');
  // First frame of an animation; rotation from EXIF applied; nothing upscaled.
  let pipeline = sharp(bytes, { animated: false, limitInputPixels: 100_000_000 }).rotate()
    .resize({ width: MAX_IMAGE_EDGE, height: MAX_IMAGE_EDGE, fit: 'inside', withoutEnlargement: true });
  const meta = await sharp(bytes).metadata();
  // Keep PNG for graphics with transparency or few colours (screenshots, text); JPEG for photos.
  const keepPng = sourceType === 'image/png' && (meta.hasAlpha || (meta.width ?? 0) * (meta.height ?? 0) < 1_500_000);
  let out = keepPng ? await pipeline.png({ compressionLevel: 9 }).toBuffer() : await pipeline.jpeg({ quality: 85, mozjpeg: true }).toBuffer();
  let mimeType = keepPng ? 'image/png' : 'image/jpeg';
  // Still too heavy: JPEG at falling quality, then a smaller edge.
  for (const [quality, edge] of [[75, MAX_IMAGE_EDGE], [65, 1536], [60, 1024]] as const) {
    if (out.length <= TARGET_IMAGE_BYTES) break;
    pipeline = sharp(bytes, { animated: false, limitInputPixels: 100_000_000 }).rotate()
      .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true });
    out = await pipeline.flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true }).toBuffer();
    mimeType = 'image/jpeg';
  }
  const path = join(cacheDir, `${sha256}.${mimeType === 'image/png' ? 'png' : 'jpg'}`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, out, { mode: 0o600 });
  return { kind: 'image', path, mimeType, sha256, source: 'user' };
}

async function findCached(cacheDir: string, sha256: string): Promise<MediaRef | undefined> {
  for (const [ext, mimeType] of [['png', 'image/png'], ['jpg', 'image/jpeg']] as const) {
    const path = join(cacheDir, `${sha256}.${ext}`);
    try {
      await stat(path);
      // A copy in use stays: the daily prune removes those unused for 30 days (cache-prune.ts).
      const now = new Date();
      await utimes(path, now, now).catch(() => {});
      return { kind: 'image', path, mimeType, sha256, source: 'user' };
    } catch {
      // not cached in this format
    }
  }
  return undefined;
}
