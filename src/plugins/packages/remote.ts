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
import { type IndexEntry, IndexFormatError, type ParsedIndex, parseIndexDocument } from './index-v2';
import { ListingPinError, pinListings, pinMismatches } from './listing-pins';
import { IndexRollbackError, acceptIndexTime } from './registry-state';
import { revokedKeyIds } from './revocations';
import { installFromDirectory, PluginPackageError } from './service';
import { REGISTRY_INDEX_SIGNATURE_SUFFIX, type SignatureCheck, type TrustedPublisher, verifyRegistryIndex } from './signature';

/** The options of `installFromDirectory`. */
type InstallOptions = NonNullable<Parameters<typeof installFromDirectory>[2]>;
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
/** Largest index signature read (the canonical form is about 200 bytes). */
const MAX_INDEX_SIGNATURE_BYTES = 1024;

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
export async function downloadHttps(url: string, opts: { maxBytes: number; timeoutMs: number; accept?: string; sameOrigin?: boolean }): Promise<Buffer> {
  let current = requireHttps(url).toString();
  const origin = new URL(current).origin;
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
      // An asset or stats file stays on the registry's origin, redirects included.
      if (opts.sameOrigin && new URL(current).origin !== origin) throw new RemoteFetchError(`${url} redirects off its origin (${origin}); not followed`);
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
 * package of the same name (see `installFromDirectory` for downgrades and a
 * change of signer). `name` and `version` (a registry entry's) must match the
 * package's manifest.
 */
export async function installFromUrl(
  url: string,
  actorUserId: string,
  opts: {
    upgrade?: boolean; sha256?: string; name?: string; version?: string; allowSignerChange?: boolean; allowDowngrade?: boolean;
    /** A registry install (./registry-install.ts): what the listing promised, where it is from, whose keys count, the runtime. */
    registry?: Pick<InstallOptions, 'expectListing' | 'origin' | 'trustOnly' | 'requireRuntime' | 'allowSourceChange'>;
  } = {},
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
    return await installFromDirectory(root, actorUserId, {
      upgrade: opts.upgrade,
      requireTrustedSignature: true,
      source: url,
      expect: { name: opts.name, version: opts.version },
      allowSignerChange: opts.allowSignerChange,
      allowDowngrade: opts.allowDowngrade,
      origin: { source: 'url', url },
      ...opts.registry,
    });
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

/** A registry to read: one of `plugins.registries`, or the marketplace (./marketplace.ts). */
export interface RegistrySource {
  /** Its name (`marketplace` for the built-in one). */
  name: string;
  url: string;
  /** The publisher whose key must sign the index (`<url>.sig`); none: read unsigned. */
  publisher?: string;
  /** The keys that count for that signature instead of `plugins.trustedPublishers` (the marketplace's own). */
  publishers?: readonly TrustedPublisher[];
  /** Index v2 only, with each tarball on the registry's origin (the marketplace). */
  strict?: boolean;
}

/** An index read, its signature checked and its format parsed. */
export interface FetchedIndex {
  index: ParsedIndex;
  /** `sha256:<hex>` of the exact bytes. */
  sha256: string;
  /** The key that signed it, when the registry names a publisher. */
  signedBy: string | null;
}

/**
 * Hooks of a registry with rules of its own (the marketplace's revocations):
 * `distrust` runs after the signature and format checks and before the
 * rollback check, and returns key ids the index revokes (it throws to refuse
 * the index); `accepted` runs once the index is accepted.
 */
export interface IndexHooks {
  distrust?: (fetched: FetchedIndex) => Promise<string[]>;
  accepted?: (fetched: FetchedIndex) => Promise<void>;
}

/** Errors of reading an index that mean "not listed", as opposed to a bug. */
export function isIndexRefusal(err: unknown): err is Error {
  return err instanceof RemoteFetchError || err instanceof IndexFormatError || err instanceof IndexRollbackError || err instanceof ListingPinError;
}

type IndexResult = { fetched: FetchedIndex | null; error: string | null };
const indexCache = new Map<string, { at: number; result: IndexResult }>();

/** Forget the cached indexes (a config change, a new revocation, tests). */
export function clearRegistryCache(): void {
  indexCache.clear();
}

/**
 * Where an index's detached signature is: the index URL with `.sig` appended
 * to its path, its query kept (`https://x/index.json?v=2` →
 * `https://x/index.json.sig?v=2`). A URL with a fragment is refused: it is
 * never sent, so it cannot say which signature is meant.
 */
export function indexSignatureUrl(indexUrl: string): string {
  const url = requireHttps(indexUrl);
  if (url.hash !== '' || indexUrl.includes('#')) throw new RemoteFetchError(`A registry URL with a fragment (#…) is refused when it names a publisher: ${indexUrl}`);
  url.pathname = `${url.pathname}${REGISTRY_INDEX_SIGNATURE_SUFFIX}`;
  return url.toString();
}

/** Why a signature check of an index does not let it be listed, in words. */
function indexSignatureShortfall(registry: RegistrySource, sigUrl: string, check: Exclude<SignatureCheck, { status: 'valid' }>): string {
  const who = `publisher ${registry.publisher}`;
  const where = registry.publishers ? 'the marketplace keys' : 'plugins.trustedPublishers';
  switch (check.status) {
    case 'unsigned':
      return `The index is not signed (${sigUrl} missing), and the registry requires a signature by ${who}`;
    case 'unknown_key':
      return `The index is signed by ${check.keyId}, which is not a key of ${who} in ${where}`;
    case 'revoked':
    case 'expired':
      return `The index signature does not count: ${check.detail}`;
    case 'invalid':
      return `The index signature is not valid: ${check.reason}`;
  }
}

/** Key ids that trust nothing now: `plugins.revokedKeys` and the marketplace's revocations. */
export async function revokedKeysNow(): Promise<string[]> {
  return [...new Set([...(getConfig().plugins?.revokedKeys ?? []), ...await revokedKeyIds()])];
}

/**
 * When the registry names a publisher: fetch `<url>.sig` and check it against
 * the exact index bytes. Returns the key that signed it; throws
 * `RemoteFetchError` (the index is not listed) unless it verifies with a
 * trusted, unrevoked, unexpired key of that publisher.
 */
async function checkIndexSignature(registry: RegistrySource & { publisher: string }, sigUrl: string, body: Buffer): Promise<string> {
  let text: string | null;
  try {
    text = (await downloadHttps(sigUrl, { maxBytes: MAX_INDEX_SIGNATURE_BYTES, timeoutMs: INDEX_TIMEOUT_MS })).toString('utf8');
  } catch (err) {
    if (!(err instanceof RemoteFetchError)) throw err;
    if (!/answered HTTP 404\b/.test(err.message)) throw new RemoteFetchError(`The index signature could not be read: ${err.message}`);
    text = null;
  }
  const plugins = getConfig().plugins;
  const publishers = registry.publishers ?? plugins?.trustedPublishers ?? [];
  const check = verifyRegistryIndex(body, text, registry.publisher, publishers, (publisher, reason) => {
    coreLogger.warn({ publisher, reason }, 'A key in plugins.trustedPublishers cannot be read; it trusts nothing');
  }, { revokedKeys: await revokedKeysNow() });
  if (check.status !== 'valid') throw new RemoteFetchError(indexSignatureShortfall(registry, sigUrl, check));
  return check.keyId;
}

/**
 * A fingerprint of the trust config an index check depends on
 * (`trustedPublishers`, `revokedKeys`, the marketplace setting): part of the
 * cache key, so revoking or adding a key takes effect on the next listing,
 * not a minute later.
 */
function trustFingerprint(registry: RegistrySource): string {
  const plugins = getConfig().plugins;
  return createHash('sha256').update(JSON.stringify([plugins?.trustedPublishers ?? [], plugins?.revokedKeys ?? [], registry.publishers ?? null, plugins?.marketplace ?? null])).digest('hex');
}

/**
 * Fetch, verify and parse one index, uncached: the bytes (at most 1 MB,
 * through the SSRF guard), the signature when the registry names a
 * publisher, the format (./index-v2.ts), the registry's own rules
 * (`hooks.distrust`), and for a signed index with a `generatedAt` the
 * rollback check (./registry-state.ts). Throws on any refusal.
 */
export async function fetchRegistryIndex(registry: RegistrySource, hooks: IndexHooks = {}): Promise<FetchedIndex> {
  const sigUrl = registry.publisher === undefined ? null : indexSignatureUrl(registry.url);
  const body = await downloadHttps(registry.url, { maxBytes: MAX_INDEX_BYTES, timeoutMs: INDEX_TIMEOUT_MS, accept: 'application/json' });
  const signedBy = sigUrl !== null ? await checkIndexSignature(registry as RegistrySource & { publisher: string }, sigUrl, body) : null;
  let json: unknown;
  try {
    json = JSON.parse(body.toString('utf8'));
  } catch {
    throw new RemoteFetchError('The index is not valid JSON');
  }
  const index = parseIndexDocument(json, registry, { tarballSameOrigin: registry.strict === true });
  if (registry.strict && index.schema !== 2) throw new IndexFormatError('This registry requires index v2 (schema 2)');
  const fetched: FetchedIndex = { index, sha256: `sha256:${createHash('sha256').update(body).digest('hex')}`, signedBy };
  const distrusted = hooks.distrust ? await hooks.distrust(fetched) : [];
  // A published version never changes content: another hash for a name@version seen before refuses the index.
  const changed = await pinMismatches(registry.url, index.entries);
  if (changed.length > 0) await refuseChangedListings(registry, changed);
  if (signedBy !== null && index.generatedAt !== null) {
    await acceptIndexTime(registry.url, index.generatedAt, fetched.sha256, signedBy, [...await revokedKeysNow(), ...distrusted]);
  }
  await pinListings(registry.url, index.entries);
  if (index.schema === 2 && registry.publishers === undefined && (index.revoked.packages.length > 0 || index.revoked.keys.length > 0)) {
    coreLogger.info({ registry: registry.name }, 'A registry index lists revocations; only the marketplace\'s are applied');
  }
  if (hooks.accepted) await hooks.accepted(fetched);
  if (index.problems.length > 0) coreLogger.warn({ registry: registry.name, problems: index.problems.slice(0, 20) }, 'Plugin registry index has entries that were skipped');
  return fetched;
}

/** Changed listings already reported, so a refused index read every minute notifies once. */
const reportedPins = new Set<string>();

async function refuseChangedListings(registry: RegistrySource, changed: ListingPinError['changed']): Promise<never> {
  const list = changed.map((c) => `${c.name} ${c.version} (pinned ${c.pinned}, now listed as ${c.listed})`).join('; ');
  const key = `${registry.url}\n${list}`;
  if (!reportedPins.has(key)) {
    if (reportedPins.size > 500) reportedPins.clear();
    reportedPins.add(key);
    coreLogger.error({ registry: registry.name, changed }, 'A plugin registry index lists other content for versions already published; refused');
    const { auditRepository } = await import('@/db/repositories/audit-repository');
    const { SYSTEM_USER_ID } = await import('@/security/principal');
    await auditRepository.log({
      userId: SYSTEM_USER_ID, action: 'permission_denied', resourceType: 'plugin_package', resourceId: registry.name,
      details: { op: 'listing_replaced', registry: registry.name, url: registry.url, changed },
    }).catch((err: unknown) => coreLogger.error({ err }, 'plugin registry: audit row could not be written'));
    const { notifyAdmins } = await import('./revocation-effects');
    await notifyAdmins('plugin_listing_replaced', `Plugin registry ${registry.name} changed a published version`,
      `The index of ${registry.name} lists other content for versions it published before: ${list}. The index is refused; nothing from it is listed or installed until this is resolved.`,
      { registry: registry.name, changed });
  }
  throw new ListingPinError(`The index lists other content for versions already published (${list}); refused`, changed);
}

/**
 * `fetchRegistryIndex`, cached for a minute per registry and trust config.
 * A refusal is cached as an error the listing reports.
 */
export async function readIndex(registry: RegistrySource, hooks: IndexHooks = {}): Promise<IndexResult> {
  const key = `${registry.name}\n${registry.url}\n${registry.publisher ?? ''}\n${registry.publisher === undefined ? '' : trustFingerprint(registry)}`;
  const now = Date.now();
  const cached = indexCache.get(key);
  if (cached && now - cached.at < REGISTRY_CACHE_MS) return cached.result;
  // Entries of an older trust config are never read again: drop what has expired.
  for (const [k, v] of indexCache) if (now - v.at >= REGISTRY_CACHE_MS) indexCache.delete(k);
  let result: IndexResult;
  try {
    const fetched = await fetchRegistryIndex(registry, hooks);
    const { entries, problems } = fetched.index;
    result = { fetched, error: entries.length === 0 && problems.length > 0 ? problems[0] : null };
  } catch (err) {
    if (!isIndexRefusal(err)) throw err;
    coreLogger.warn({ registry: registry.name, err: err.message }, 'Plugin registry could not be read');
    result = { fetched: null, error: err.message };
  }
  indexCache.set(key, { at: Date.now(), result });
  return result;
}

/** The configured registries (`plugins.registries`), as sources. */
export function configuredRegistries(): RegistrySource[] {
  return (getConfig().plugins?.registries ?? []).map((r) => ({ name: r.name, url: r.url, ...(r.publisher !== undefined ? { publisher: r.publisher } : {}) }));
}

/** An index entry in the v1 listing shape of `GET /registry`. */
function v1Shape(e: IndexEntry): Omit<PluginRegistryEntry, 'installedVersion'> {
  return { registry: e.registry, name: e.name, version: e.version, description: e.description === null ? null : e.description.slice(0, 500), url: e.url, sha256: e.sha256 };
}

/**
 * Every package the configured registries (`plugins.registries`) list, with
 * the version installed here. Each index is cached for a minute; one that
 * cannot be read, or (for a registry naming a `publisher`) whose signature
 * does not verify with a trusted key of that publisher, is reported in
 * `errors` and the others still listed.
 */
export async function listRegistry(): Promise<PluginRegistryListing> {
  const results = await Promise.all(configuredRegistries().map(async (r) => ({ registry: r.name, ...(await readIndex(r)) })));
  const installed = new Map(
    (await getDb().select({ name: pluginPackages.name, version: pluginPackages.version }).from(pluginPackages)).map((r) => [r.name, r.version]),
  );
  return {
    packages: results.flatMap((r) => (r.fetched?.index.entries ?? []).map((e) => ({ ...v1Shape(e), installedVersion: installed.get(e.name) ?? null }))),
    errors: results.filter((r) => r.error !== null).map((r) => ({ registry: r.registry, error: r.error as string })),
  };
}
