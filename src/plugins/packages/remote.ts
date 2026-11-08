/**
 * Installing a plugin package from an https URL, and the registries that
 * list such URLs (docs/PLUGIN-PACKAGES.md#remote-install, #registries).
 *
 * A download goes through the SSRF guard every outbound fetch of
 * user-supplied URLs uses (`fetchGuarded`, src/utils/sanitize.ts): the host is
 * resolved and every address checked against private, loopback and
 * link-local ranges, the socket is pinned to the checked address, and each
 * redirect is checked again (https only, at most three). The body is capped
 * while it streams. A tarball is checked against the sha256 it was offered
 * with (a registry's index) before it is unpacked, unpacked by ./tar.ts into
 * a fresh directory, and then installed like a directory — except that it
 * must carry a valid signature by a trusted publisher, whatever
 * `plugins.requireSignature` says: a URL says nothing about who made it.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getConfig } from '@/config';
import { getDb } from '@/db/postgres';
import { type PluginPackageRow, pluginPackages } from '@/db/schema/plugin-packages';
import type { PluginRegistryEntry, PluginRegistryListing } from '@/shared/plugin-package';
import { coreLogger } from '@/utils/logger';
import { fetchGuarded } from '@/utils/sanitize';
import { manifestSchema } from './manifest';
import { installFromDirectory, PluginPackageError } from './service';
import { extractTarGz, packageRootIn, TarError } from './tar';

/** Largest tarball a remote install downloads (compressed). */
export const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
/** Largest registry index read. */
export const MAX_INDEX_BYTES = 1024 * 1024;
/** How long a registry index is reused before it is fetched again. */
export const REGISTRY_CACHE_MS = 60_000;
const MAX_REDIRECTS = 3;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const INDEX_TIMEOUT_MS = 10_000;

export class RemoteFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteFetchError';
  }
}

/** `sha256:<hex>` from a sha256 given with or without the prefix, or null when it is not one. */
export function normalizeSha256(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const hex = value.trim().toLowerCase().replace(/^sha256:/, '');
  return /^[0-9a-f]{64}$/.test(hex) ? `sha256:${hex}` : null;
}

function requireHttps(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new RemoteFetchError(`Not a URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new RemoteFetchError(`Only https URLs are fetched (${parsed.protocol} refused)`);
  if (parsed.username || parsed.password) throw new RemoteFetchError('A URL with credentials in it is refused');
  return parsed;
}

/**
 * GET an https URL through the SSRF guard, following at most three
 * redirects (each https and checked again), and read at most `maxBytes`.
 */
export async function downloadHttps(url: string, opts: { maxBytes: number; timeoutMs: number; accept?: string }): Promise<Buffer> {
  let current = requireHttps(url).toString();
  for (let hop = 0; ; hop++) {
    let res: Response;
    try {
      res = await fetchGuarded(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(opts.timeoutMs),
        headers: opts.accept ? { accept: opts.accept } : undefined,
      }, 0);
    } catch (err) {
      throw new RemoteFetchError(`Could not fetch ${current}: ${(err as Error).message}`);
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {});
      const location = res.headers.get('location');
      if (!location) throw new RemoteFetchError(`${current} answered ${res.status} without a Location`);
      if (hop >= MAX_REDIRECTS) throw new RemoteFetchError(`${url} redirects more than ${MAX_REDIRECTS} times`);
      current = requireHttps(new URL(location, current).toString()).toString();
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new RemoteFetchError(`${current} answered HTTP ${res.status}`);
    }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > opts.maxBytes) {
      await res.body?.cancel().catch(() => {});
      throw new RemoteFetchError(`${current} is larger than ${opts.maxBytes} bytes`);
    }
    if (!res.body) return Buffer.alloc(0);
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > opts.maxBytes) {
        await reader.cancel().catch(() => {});
        throw new RemoteFetchError(`${current} is larger than ${opts.maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }
}

/** Where downloads are unpacked before they are installed (removed after each). */
function downloadsRoot(): string {
  return join(resolve(getConfig().workspace.rootPath), 'plugin-downloads');
}

/**
 * Download an https tarball (`.tar.gz`), check it against `sha256` when
 * given, unpack it and install it (`installFromDirectory`) with a valid
 * trusted signature required. With `upgrade`, it replaces the installed
 * package of the same name.
 */
export async function installFromUrl(
  url: string,
  actorUserId: string,
  opts: { upgrade?: boolean; sha256?: string } = {},
): Promise<PluginPackageRow & { warnings: string[] }> {
  let expected: string | null = null;
  if (opts.sha256 !== undefined) {
    expected = normalizeSha256(opts.sha256);
    if (!expected) throw new PluginPackageError('invalid', 'sha256 must be 64 hex digits (optionally after "sha256:")');
  }
  let tarball: Buffer;
  try {
    tarball = await downloadHttps(url, { maxBytes: MAX_DOWNLOAD_BYTES, timeoutMs: DOWNLOAD_TIMEOUT_MS });
  } catch (err) {
    if (err instanceof RemoteFetchError) throw new PluginPackageError('invalid', err.message);
    throw err;
  }
  const actual = `sha256:${createHash('sha256').update(tarball).digest('hex')}`;
  if (expected && actual !== expected) {
    throw new PluginPackageError('invalid', `The download from ${url} hashes to ${actual}, not to the expected ${expected}; not unpacked`);
  }
  const work = join(downloadsRoot(), `${process.pid}-${randomBytes(8).toString('hex')}`);
  try {
    await mkdir(work, { recursive: true, mode: 0o700 });
    let root: string;
    try {
      await extractTarGz(tarball, work);
      root = await packageRootIn(work);
    } catch (err) {
      if (err instanceof TarError) throw new PluginPackageError('invalid', `${err.message}; not installed`);
      throw err;
    }
    return await installFromDirectory(root, actorUserId, { upgrade: opts.upgrade, requireTrustedSignature: true, source: url });
  } finally {
    await rm(work, { recursive: true, force: true }).catch((err: unknown) => coreLogger.warn({ err, dir: work }, 'Could not remove a plugin download'));
  }
}

/** What a registry index says, entry by entry: the usable entries and what is wrong with the rest. */
export function parseRegistryIndex(json: unknown, registry: string): { entries: Array<Omit<PluginRegistryEntry, 'installedVersion'>>; problems: string[] } {
  const problems: string[] = [];
  const entries: Array<Omit<PluginRegistryEntry, 'installedVersion'>> = [];
  const list = typeof json === 'object' && json !== null && !Array.isArray(json) ? (json as { packages?: unknown }).packages : undefined;
  if (!Array.isArray(list)) return { entries, problems: ['The index is not { "packages": [...] }'] };
  list.forEach((raw, i) => {
    const at = `packages[${i}]`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      problems.push(`${at}: not an object`);
      return;
    }
    const p = raw as Record<string, unknown>;
    const name = manifestSchema.shape.name.safeParse(p.name);
    const version = manifestSchema.shape.version.safeParse(p.version);
    const sha256 = normalizeSha256(p.sha256);
    let url: string | null = null;
    if (typeof p.url === 'string' && p.url.length <= 2000) {
      try {
        url = requireHttps(p.url).toString();
      } catch {
        url = null;
      }
    }
    const wrong = [
      !name.success && 'name',
      !version.success && 'version',
      !url && 'url (https)',
      !sha256 && 'sha256',
      p.description !== undefined && p.description !== null && typeof p.description !== 'string' && 'description',
    ].filter(Boolean);
    if (wrong.length > 0 || !name.success || !version.success || !url || !sha256) {
      problems.push(`${at}${typeof p.name === 'string' ? ` (${p.name.slice(0, 50)})` : ''}: ${wrong.join(', ')} missing or not valid`);
      return;
    }
    const description = typeof p.description === 'string' ? p.description.slice(0, 500) : null;
    entries.push({ registry, name: name.data, version: version.data, description, url, sha256 });
  });
  return { entries, problems };
}

type IndexResult = { entries: Array<Omit<PluginRegistryEntry, 'installedVersion'>>; error: string | null };
const indexCache = new Map<string, { at: number; result: IndexResult }>();

/** Forget the cached indexes (a config change, tests). */
export function clearRegistryCache(): void {
  indexCache.clear();
}

async function readIndex(registry: { name: string; url: string }): Promise<IndexResult> {
  const key = `${registry.name}\n${registry.url}`;
  const cached = indexCache.get(key);
  if (cached && Date.now() - cached.at < REGISTRY_CACHE_MS) return cached.result;
  let result: IndexResult;
  try {
    const body = await downloadHttps(registry.url, { maxBytes: MAX_INDEX_BYTES, timeoutMs: INDEX_TIMEOUT_MS, accept: 'application/json' });
    let json: unknown;
    try {
      json = JSON.parse(body.toString('utf8'));
    } catch {
      throw new RemoteFetchError('The index is not valid JSON');
    }
    const { entries, problems } = parseRegistryIndex(json, registry.name);
    if (problems.length > 0) coreLogger.warn({ registry: registry.name, problems: problems.slice(0, 20) }, 'Plugin registry index has entries that were skipped');
    result = { entries, error: entries.length === 0 && problems.length > 0 ? problems[0] : null };
  } catch (err) {
    if (!(err instanceof RemoteFetchError)) throw err;
    coreLogger.warn({ registry: registry.name, err: err.message }, 'Plugin registry could not be read');
    result = { entries: [], error: err.message };
  }
  indexCache.set(key, { at: Date.now(), result });
  return result;
}

/**
 * Every package the configured registries (`plugins.registries`) list, with
 * the version installed here. Each index is cached for a minute; one that
 * cannot be read is reported in `errors` and the others still listed.
 */
export async function listRegistry(): Promise<PluginRegistryListing> {
  const registries = getConfig().plugins?.registries ?? [];
  const results = await Promise.all(registries.map(async (r) => ({ registry: r.name, ...(await readIndex(r)) })));
  const installed = new Map(
    (await getDb().select({ name: pluginPackages.name, version: pluginPackages.version }).from(pluginPackages)).map((r) => [r.name, r.version]),
  );
  return {
    packages: results.flatMap((r) => r.entries.map((e) => ({ ...e, installedVersion: installed.get(e.name) ?? null }))),
    errors: results.filter((r) => r.error !== null).map((r) => ({ registry: r.registry, error: r.error as string })),
  };
}
