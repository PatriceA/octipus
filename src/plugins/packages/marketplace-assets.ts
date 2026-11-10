/**
 * Listing images and download counts, fetched by the host
 * (docs/PLUGIN-PACKAGES.md#marketplace). Both are display-only and hostile
 * until checked.
 *
 * **Images** (`GET /api/plugin-packages/marketplace/asset?url=…`): only a URL
 * a readable index lists as an icon or screenshot is fetched — the proxy is
 * never a general fetcher — and it is already https on that registry's
 * origin under `/<name>/` (./index-v2.ts). It is fetched through the SSRF
 * guard, without following a redirect off the origin, at most 2 MB, and kept
 * only when its first bytes are PNG, JPEG, WebP or GIF (no SVG: it can carry
 * script). The type served is the one sniffed, never the server's.
 *
 * **Download counts**: the marketplace may serve an unsigned
 * `<origin>/stats.json` (`{ generatedAt, downloads: { "<name>": n } }`),
 * aggregated from its web server's logs. Read with the same guard, a size
 * cap and a strict schema, cached; any problem means no counts. They are
 * shown, and never used for trust, install or default order. The host never
 * reports its own installs anywhere.
 */
import { z } from 'zod';
import { coreLogger } from '@/utils/logger';
import { isoTime } from './index-v2';
import { manifestSchema } from './manifest';
import { currentMarketplace } from './marketplace-config';
import { marketplaceHooks, marketplaceSource } from './marketplace';
import { configuredRegistries, downloadHttps, isIndexRefusal, readIndex } from './remote';

/** Largest image served. */
export const MAX_ASSET_BYTES = 2 * 1024 * 1024;
/** Largest stats.json read. */
export const MAX_STATS_BYTES = 256 * 1024;
const ASSET_TIMEOUT_MS = 10_000;
const ASSET_CACHE_MS = 60 * 60_000;
const ASSET_CACHE_MAX_ENTRIES = 64;
const ASSET_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const STATS_CACHE_MS = 10 * 60_000;

export type ImageType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

/** The image type of `bytes` by their magic number, or null (SVG, HTML, anything else). */
export function sniffImage(bytes: Uint8Array): ImageType | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && (b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a')) return 'image/gif';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

export class AssetError extends Error {
  constructor(readonly status: 400 | 404 | 415 | 413 | 502, message: string) {
    super(message);
    this.name = 'AssetError';
  }
}

/** Whether a readable index (the marketplace, or a configured registry) lists `url` as an icon or screenshot. */
async function isListedAsset(url: string): Promise<boolean> {
  const sources = [];
  const settings = currentMarketplace();
  if (settings.state === 'ready') {
    const mp = await marketplaceSource(settings);
    if (!('error' in mp)) sources.push({ source: mp, hooks: marketplaceHooks(settings) });
  }
  for (const r of configuredRegistries()) sources.push({ source: r, hooks: {} });
  for (const { source, hooks } of sources) {
    const result = await readIndex(source, hooks);
    for (const e of result.fetched?.index.entries ?? []) {
      if (e.icon === url || e.screenshots.includes(url)) return true;
    }
  }
  return false;
}

const assetCache = new Map<string, { at: number; type: ImageType; bytes: Buffer }>();

/** Test-only. */
export function clearAssetCache(): void {
  assetCache.clear();
  statsCache.clear();
}

function remember(url: string, type: ImageType, bytes: Buffer): void {
  assetCache.set(url, { at: Date.now(), type, bytes });
  let total = 0;
  for (const v of assetCache.values()) total += v.bytes.length;
  for (const [k, v] of assetCache) {
    if (assetCache.size <= ASSET_CACHE_MAX_ENTRIES && total <= ASSET_CACHE_MAX_BYTES) break;
    assetCache.delete(k);
    total -= v.bytes.length;
  }
}

/** A listing image, checked as the module comment says. Throws `AssetError` with the status to answer. */
export async function fetchListingAsset(url: string): Promise<{ type: ImageType; bytes: Buffer }> {
  if (typeof url !== 'string' || url.length > 2000) throw new AssetError(400, 'Not an asset URL');
  const cached = assetCache.get(url);
  if (cached && Date.now() - cached.at < ASSET_CACHE_MS) return cached;
  if (!(await isListedAsset(url))) throw new AssetError(404, 'Not an image a registry lists');
  let bytes: Buffer;
  try {
    bytes = await downloadHttps(url, { maxBytes: MAX_ASSET_BYTES, timeoutMs: ASSET_TIMEOUT_MS, sameOrigin: true, accept: 'image/png, image/jpeg, image/webp, image/gif' });
  } catch (err) {
    if (!isIndexRefusal(err)) throw err;
    coreLogger.info({ url, err: err.message }, 'plugin marketplace: listing image not fetched');
    throw new AssetError(/larger than/.test(err.message) ? 413 : 502, /larger than/.test(err.message) ? 'The image is too large' : 'The image could not be fetched');
  }
  const type = sniffImage(bytes);
  if (type === null) throw new AssetError(415, 'Not a PNG, JPEG, WebP or GIF image');
  remember(url, type, bytes);
  return { type, bytes };
}

const statsSchema = z.object({
  generatedAt: isoTime,
  downloads: z.record(manifestSchema.shape.name, z.number().int().min(0).max(1e12))
    .refine((d) => Object.keys(d).length <= 10_000, 'at most 10,000 plugins'),
}).strict();

const statsCache = new Map<string, { at: number; downloads: Map<string, number> | null }>();

/**
 * The marketplace's download counts by plugin name, or null when there are
 * none to show (no file, any error). Display only.
 */
export async function marketplaceDownloads(indexUrl: string): Promise<Map<string, number> | null> {
  let statsUrl: string;
  try {
    statsUrl = new URL('/stats.json', new URL(indexUrl).origin).toString();
  } catch {
    return null;
  }
  const cached = statsCache.get(statsUrl);
  if (cached && Date.now() - cached.at < STATS_CACHE_MS) return cached.downloads;
  let downloads: Map<string, number> | null = null;
  try {
    const bytes = await downloadHttps(statsUrl, { maxBytes: MAX_STATS_BYTES, timeoutMs: ASSET_TIMEOUT_MS, sameOrigin: true, accept: 'application/json' });
    const parsed = statsSchema.safeParse(JSON.parse(bytes.toString('utf8')));
    if (parsed.success) downloads = new Map(Object.entries(parsed.data.downloads));
    else coreLogger.info({ problem: parsed.error.issues[0]?.message }, 'plugin marketplace: stats.json ignored (does not fit its schema)');
  } catch (err) {
    coreLogger.debug({ err: (err as Error).message }, 'plugin marketplace: no download counts');
  }
  statsCache.set(statsUrl, { at: Date.now(), downloads });
  return downloads;
}
