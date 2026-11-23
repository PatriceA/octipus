/**
 * Skill registries (docs/SKILL-EXCHANGE.md#registries): the static indexes an
 * operator lists in `skills.registries`, browsed and searched on the Skills
 * page, and the bundle download behind a registry preview and install.
 *
 * - **Nothing by default.** No registry is configured, and none is contacted
 *   unless the operator lists it.
 * - **Fetching.** Every index and bundle goes through the SSRF-guarded https
 *   download plugin packages use (`downloadHttps`: private addresses refused
 *   after resolution, redirects checked again, a byte cap while streaming, one
 *   deadline for the whole download). An index is cached for
 *   `SKILL_REGISTRY_CACHE_MS` (at most `MAX_CACHED_INDEXES`), and concurrent
 *   reads of one index share one request. A bundle whose bytes matched its
 *   digest is kept by that digest (at most `MAX_CACHED_BUNDLES`). Registry
 *   previews and installs are limited per person (`REGISTRY_FETCH_LIMIT`).
 * - **No URLs to callers.** A configured index URL may carry a token. What a
 *   caller sees of a failure is the registry's name and the class of failure;
 *   the log line has the URL with its query and user info removed.
 * - **Trust.** An index is untrusted input (./registry-index.ts). A bundle
 *   must hash to the index's digest, match what the listing says of it, and
 *   then pass the exchange's own signature check with a key of one of the
 *   registry's publishers (`checkBundleTrust`): the digest pins the bytes, it
 *   never stands in for the signature. A signature does not cover a
 *   listing's name or version, so those are claims: `installWarnings` flags a
 *   relabelled old bundle (a rollback) and content that is not provably newer.
 * - **No updates.** A newer version is shown as available; installing it is
 *   a new preview and install. Nothing here writes a skill.
 */
import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { getConfig } from '@/config';
import { getDb } from '@/db/postgres';
import type { SkillExec } from '@/db/repositories/skill-repository';
import { type SkillRegistryInstall, type SkillRegistryInstallEvent, skillRegistryInstalls } from '@/db/schema/skill-registry-installs';
import { skills } from '@/db/schema/skills';
import { downloadHttps, mapBounded, RemoteFetchError } from '@/plugins/packages/remote';
import type { KeyRing } from '@/plugins/packages/signature';
import type {
  ListedSignatureStatus,
  SkillIndexEntry,
  SkillRegistryListing,
  SkillRegistryListingResponse,
  SkillRegistrySource,
} from '@/shared/skill-registry';
import { coreLogger } from '@/utils/logger';
import { compareVersions } from '@/utils/semver';
import { bundleKeyRing, MAX_BUNDLE_BYTES, type ParsedImport, SkillBundleError } from './exchange';
import { MAX_SKILL_INDEX_BYTES, type ParsedSkillIndex, parseSkillIndex, SkillIndexError } from './registry-index';

/** How long a read index is reused. */
export const SKILL_REGISTRY_CACHE_MS = 5 * 60_000;
/** How long a registry that could not be read is left alone before it is tried again. */
const FAILURE_CACHE_MS = 30_000;
/** The most indexes kept in the cache (the oldest is dropped first). */
export const MAX_CACHED_INDEXES = 32;
/** The most verified bundles kept, and their total size. */
export const MAX_CACHED_BUNDLES = 16;
const MAX_CACHED_BUNDLE_BYTES = 8 * 1024 * 1024;
const BUNDLE_CACHE_MS = 10 * 60_000;
/** The most listings one answer carries. */
export const MAX_LISTINGS = 500;
/** Registry previews and installs one person may start per `REGISTRY_FETCH_WINDOW_MS`. */
export const REGISTRY_FETCH_LIMIT = 30;
const REGISTRY_FETCH_WINDOW_MS = 60_000;
/** The most versions kept in an install record's history. */
const MAX_HISTORY = 50;
const INDEX_TIMEOUT_MS = 10_000;
const BUNDLE_TIMEOUT_MS = 15_000;
const FETCH_CONCURRENCY = 4;

/** A registry of `skills.registries`. */
export interface SkillRegistryConfig {
  name: string;
  url: string;
  publishers: string[];
}

/** The configured registries; none by default. */
export function configuredSkillRegistries(): SkillRegistryConfig[] {
  return (getConfig().skills?.registries ?? []).map((r) => ({ name: r.name, url: r.url, publishers: [...(r.publishers ?? [])] }));
}

/** sha256 of a registry's URL: what install records are keyed by (never the URL, which may carry a token). */
export function registryUrlKey(url: string): string {
  return createHash('sha256').update(url, 'utf8').digest('hex');
}

/** A URL for a log line: no user info, no query values, no fragment. */
export function urlForLog(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.hash = '';
    if (url.search) url.search = '?[REDACTED]';
    return url.toString();
  } catch {
    return '[not a URL]';
  }
}

/** Every URL in a message, as `urlForLog` writes it. */
function scrubUrls(message: string): string {
  return message.replace(/\bhttps?:\/\/[^\s"'<>)]+/g, (u) => urlForLog(u));
}

/**
 * What a caller may be told of a failed fetch: its class, never a URL. A
 * `SkillIndexError` names no URL (it is about the document) and is kept.
 */
function publicReason(err: RemoteFetchError | SkillIndexError): string {
  if (err instanceof SkillIndexError) return err.message;
  const m = err.message;
  if (/took longer than/.test(m)) return 'timed out';
  const size = /larger than (\d+) bytes/.exec(m);
  if (size) return `the file is larger than ${size[1]} bytes`;
  const http = /answered HTTP (\d{3})/.exec(m);
  if (http) return `the server answered HTTP ${http[1]}`;
  if (/SSRF guard/.test(m)) return 'it resolves to a private or reserved address (refused)';
  if (/redirect|Only https|credentials|Location/.test(m)) return 'it redirects somewhere that is not followed';
  return 'it could not be reached';
}

type IndexResult = { index: ParsedSkillIndex; error: null } | { index: null; error: string };
const cache = new Map<string, { at: number; ttl: number; result: IndexResult }>();
const inFlight = new Map<string, Promise<IndexResult>>();
const bundles = new Map<string, { at: number; bytes: Buffer }>();
const fetchTimes = new Map<string, number[]>();

/** Forget every cached index and bundle, and every person's fetch count (a config change, tests). */
export function clearSkillRegistryCache(): void {
  cache.clear();
  bundles.clear();
  fetchTimes.clear();
}

/** Fetch and parse one index, uncached. Throws `RemoteFetchError` or `SkillIndexError`. */
async function fetchIndex(registry: SkillRegistryConfig): Promise<ParsedSkillIndex> {
  const bytes = await downloadHttps(registry.url, { maxBytes: MAX_SKILL_INDEX_BYTES, timeoutMs: INDEX_TIMEOUT_MS, accept: 'application/json' });
  const index = parseSkillIndex(bytes);
  if (index.problems.length > 0) coreLogger.warn({ registry: registry.name, problems: index.problems.slice(0, 20) }, 'Skill registry index has entries that were skipped');
  return index;
}

async function loadIndex(registry: SkillRegistryConfig, key: string): Promise<IndexResult> {
  let result: IndexResult;
  try {
    result = { index: await fetchIndex(registry), error: null };
  } catch (err) {
    if (!(err instanceof RemoteFetchError) && !(err instanceof SkillIndexError)) throw err;
    coreLogger.warn({ registry: registry.name, url: urlForLog(registry.url), err: scrubUrls(err.message) }, 'Skill registry could not be read');
    result = { index: null, error: publicReason(err) };
  }
  for (const [k, v] of cache) if (Date.now() - v.at >= v.ttl) cache.delete(k);
  cache.delete(key);
  while (cache.size >= MAX_CACHED_INDEXES) cache.delete(cache.keys().next().value as string);
  cache.set(key, { at: Date.now(), ttl: result.error === null ? SKILL_REGISTRY_CACHE_MS : FAILURE_CACHE_MS, result });
  return result;
}

/**
 * A registry's index, cached for `SKILL_REGISTRY_CACHE_MS` (a failure for
 * `FAILURE_CACHE_MS`); concurrent reads share one request. A refusal
 * (unreachable, too large, malformed) is an error the listing reports, in
 * words that name no URL, never a throw.
 */
export async function readSkillIndex(registry: SkillRegistryConfig): Promise<IndexResult> {
  const key = `${registry.name}\n${registry.url}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.result;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const request = loadIndex(registry, key).finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
}

/** What the trust settings say of the key a listing claims, for this registry's publishers. */
function listedSignature(keyId: string | null, ring: KeyRing, publishers: readonly string[]): SkillRegistryListing['signature'] {
  if (keyId === null) return { status: 'unsigned', publisher: null, detail: 'Not signed: not installable from a registry' };
  const known = ring.get(keyId);
  if (!known) return { status: 'unknown_key', publisher: null, detail: `Signed by a key not in plugins.trustedPublishers (${keyId})` };
  if (known.untrusted) return { status: known.untrusted.status, publisher: known.key ? known.name : null, detail: known.untrusted.detail };
  if (!publishers.includes(known.name)) return { status: 'unknown_key', publisher: null, detail: `Signed by ${known.name}, not a publisher trusted for this registry` };
  return { status: 'valid' satisfies ListedSignatureStatus, publisher: known.name, detail: `Signed by ${known.name} (checked at preview)` };
}

/**
 * The caller's install records (`owner_key`: a user id, or `system`) of the
 * configured registries, by registry name and listing name. A record of a
 * registry whose URL changed since does not count; nor does one whose
 * skills are all gone, or were replaced by another import.
 */
async function installRecords(userId: string, registries: readonly SkillRegistryConfig[]): Promise<Map<string, SkillRegistryInstall>> {
  const urlKeys = new Map(registries.map((r) => [r.name, registryUrlKey(r.url)]));
  const rows = (await getDb().select().from(skillRegistryInstalls).where(eq(skillRegistryInstalls.ownerKey, userId)))
    .filter((r) => urlKeys.get(r.registry) === r.registryUrlSha256 && r.skillIds.length > 0);
  if (rows.length === 0) return new Map();
  const ids = [...new Set(rows.flatMap((r) => r.skillIds))];
  const alive = new Set((await getDb().select({ id: skills.id }).from(skills).where(inArray(skills.id, ids))).map((r) => r.id));
  return new Map(rows.filter((r) => r.skillIds.some((id) => alive.has(id))).map((r) => [`${r.registry}\n${r.name}`, r]));
}

/** What the caller installed of one listing from `registry`, or null. */
export async function installRecord(userId: string, registry: SkillRegistryConfig, name: string): Promise<SkillRegistryInstall | null> {
  return (await installRecords(userId, [registry])).get(`${registry.name}\n${name}`) ?? null;
}

/**
 * What a preview should say about a listing next to what the caller
 * installed of it before. A signature covers the bundle's content, not the
 * listing's name or version, so a registry can relabel an old signed bundle
 * with a higher version (a rollback), or offer older content as an update.
 */
export function installWarnings(entry: SkillIndexEntry, record: Pick<SkillRegistryInstall, 'version' | 'contentHash' | 'history'> | null): string[] {
  if (!record) return [];
  const warnings: string[] = [];
  if (entry.contentHash === record.contentHash) {
    warnings.push(`This is the content you installed as ${record.version} (${record.contentHash}); installing it changes nothing.`);
    return warnings;
  }
  const before = record.history.filter((h) => h.contentHash === entry.contentHash);
  if (before.length > 0) {
    const versions = [...new Set(before.map((h) => h.version))].join(', ');
    warnings.push(`Possible rollback: this exact content was installed before as ${versions}, and the registry now lists it as ${entry.version}. A signature does not cover the version number; replacing your ${record.version} with it goes back to older content.`);
  } else if (compareVersions(entry.version, record.version) <= 0) {
    warnings.push(`You installed ${record.version} (${record.contentHash}); this listing is ${entry.version}, other content that is not newer. Replacing yours with it may go back to older content.`);
  }
  return warnings;
}

function matches(entry: SkillIndexEntry, q: string, tag: string): boolean {
  if (tag && !entry.tags.some((t) => t.toLowerCase() === tag)) return false;
  if (!q) return true;
  const haystack = [entry.name, entry.description, entry.author ?? '', ...entry.tags, ...entry.skills].join('\n').toLowerCase();
  return q.split(/\s+/).filter(Boolean).every((word) => haystack.includes(word));
}

/**
 * Every listing of the configured registries, newest version per name, with
 * its listed signature status and whether the caller installed it (and an
 * update is available), filtered by `q` (every word, in the name,
 * description, author, tags or skill names) and `tag`. With no registry
 * configured, nothing is fetched. Index URLs are never in the answer.
 */
export async function listSkillRegistries(userId: string, filter: { q?: string; tag?: string } = {}): Promise<SkillRegistryListingResponse> {
  const registries = configuredSkillRegistries();
  if (registries.length === 0) return { registries: [], listings: [], errors: [], problems: [], truncated: false };
  const results = await mapBounded(registries, FETCH_CONCURRENCY, async (r) => ({ registry: r, ...(await readSkillIndex(r)) }));
  const ring = bundleKeyRing();
  const installed = await installRecords(userId, registries);
  const q = (filter.q ?? '').trim().toLowerCase();
  const tag = (filter.tag ?? '').trim().toLowerCase();
  const listings: SkillRegistryListing[] = [];
  for (const { registry, index } of results) {
    if (!index) continue;
    const byName = new Map<string, SkillIndexEntry[]>();
    for (const e of index.entries) byName.set(e.name, [...(byName.get(e.name) ?? []), e]);
    for (const versions of byName.values()) {
      versions.sort((a, b) => compareVersions(b.version, a.version));
      const newest = versions[0];
      if (!matches(newest, q, tag)) continue;
      const record = installed.get(`${registry.name}\n${newest.name}`) ?? null;
      listings.push({
        ...newest,
        registry: registry.name,
        olderVersions: versions.slice(1).map((v) => v.version),
        signature: listedSignature(newest.publisherKeyId, ring, registry.publishers),
        installedVersion: record?.version ?? null,
        installedContentHash: record?.contentHash ?? null,
        // Other content under a higher version, and not content installed before (a relabelled rollback).
        updateAvailable: record !== null && newest.contentHash !== record.contentHash
          && compareVersions(newest.version, record.version) > 0
          && !record.history.some((h) => h.contentHash === newest.contentHash),
      });
    }
  }
  listings.sort((a, b) => (a.registry === b.registry ? (a.name < b.name ? -1 : 1) : a.registry < b.registry ? -1 : 1));
  return {
    registries: registries.map((r) => r.name),
    listings: listings.slice(0, MAX_LISTINGS),
    errors: results.filter((r) => r.error !== null).map((r) => ({ registry: r.registry.name, error: r.error as string })),
    problems: results.flatMap((r) => (r.index?.problems ?? []).map((problem) => ({ registry: r.registry.name, problem }))).slice(0, 50),
    truncated: listings.length > MAX_LISTINGS,
  };
}

/**
 * Count one registry preview or install for `userId`; throws `SkillBundleError`
 * (429) past `REGISTRY_FETCH_LIMIT` in a minute. Each may download a bundle.
 */
export function takeRegistryFetch(userId: string): void {
  const now = Date.now();
  const recent = (fetchTimes.get(userId) ?? []).filter((t) => now - t < REGISTRY_FETCH_WINDOW_MS);
  if (recent.length >= REGISTRY_FETCH_LIMIT) {
    fetchTimes.set(userId, recent);
    throw new SkillBundleError(`At most ${REGISTRY_FETCH_LIMIT} registry previews and installs a minute; try again shortly`, 429);
  }
  recent.push(now);
  fetchTimes.set(userId, recent);
  if (fetchTimes.size > 10_000) for (const [k, v] of fetchTimes) if (v.every((t) => now - t >= REGISTRY_FETCH_WINDOW_MS)) fetchTimes.delete(k);
}

function cacheBundle(sha256: string, bytes: Buffer): void {
  const now = Date.now();
  for (const [k, v] of bundles) if (now - v.at >= BUNDLE_CACHE_MS) bundles.delete(k);
  bundles.delete(sha256);
  bundles.set(sha256, { at: now, bytes });
  let total = 0;
  for (const v of bundles.values()) total += v.bytes.length;
  while (bundles.size > MAX_CACHED_BUNDLES || total > MAX_CACHED_BUNDLE_BYTES) {
    const [oldest, v] = bundles.entries().next().value as [string, { bytes: Buffer }];
    bundles.delete(oldest);
    total -= v.bytes.length;
  }
}

/** A bundle downloaded from a registry listing: its bytes matched the index digest. Nothing about its signature is known yet. */
export interface RegistryBundle {
  registry: SkillRegistryConfig;
  entry: SkillIndexEntry;
  text: string;
}

/**
 * Download the bundle a registry lists for `source` (a configured registry,
 * a name and version its index lists) through the SSRF-guarded fetch, at
 * most `MAX_BUNDLE_BYTES`, and refuse it unless its bytes hash to the index
 * digest. Bytes that matched a digest before are reused from the cache by
 * that digest. Throws `SkillBundleError`, in words that name no URL.
 */
export async function fetchRegistryBundle(source: SkillRegistrySource): Promise<RegistryBundle> {
  const registry = configuredSkillRegistries().find((r) => r.name === source.registry);
  if (!registry) throw new SkillBundleError(`"${source.registry}" is not a skill registry configured here (skills.registries)`);
  const read = await readSkillIndex(registry);
  if (!read.index) throw new SkillBundleError(`The registry ${registry.name} could not be read: ${read.error}`);
  const entry = read.index.entries.find((e) => e.name === source.name && e.version === source.version);
  if (!entry) throw new SkillBundleError(`The registry ${registry.name} does not list ${source.name} ${source.version}`, 404);
  const cached = bundles.get(entry.bundleSha256);
  if (cached && Date.now() - cached.at < BUNDLE_CACHE_MS) return { registry, entry, text: cached.bytes.toString('utf8') };
  coreLogger.info({ registry: registry.name, name: entry.name, version: entry.version, url: urlForLog(entry.bundleUrl) }, 'Skill registry: fetching a bundle');
  let bytes: Buffer;
  try {
    bytes = await downloadHttps(entry.bundleUrl, { maxBytes: MAX_BUNDLE_BYTES, timeoutMs: BUNDLE_TIMEOUT_MS, accept: 'application/json' });
  } catch (err) {
    if (!(err instanceof RemoteFetchError)) throw err;
    coreLogger.warn({ registry: registry.name, name: entry.name, version: entry.version, err: scrubUrls(err.message) }, 'Skill registry: the bundle could not be downloaded');
    throw new SkillBundleError(`The bundle of ${entry.name} ${entry.version} from the registry ${registry.name} could not be downloaded: ${publicReason(err)}`);
  }
  const actual = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (actual !== entry.bundleSha256) {
    throw new SkillBundleError(`The bundle of ${entry.name} ${entry.version} hashes to ${actual}, not to the ${entry.bundleSha256} the registry ${registry.name} lists; not imported`);
  }
  cacheBundle(actual, bytes);
  return { registry, entry, text: bytes.toString('utf8') };
}

/**
 * Refuse a registry bundle that is not what its listing says: its content
 * hash, its skills (names, in order) and the key it is signed with (or
 * unsigned) must all be the listing's, so a listing cannot pass for another
 * bundle than the one previewed.
 */
export function checkListingMatches(registry: string, entry: SkillIndexEntry, parsed: ParsedImport): void {
  const mismatch = (what: string) => new SkillBundleError(`The bundle does not match its listing in the registry ${registry} (${what}); not imported`);
  if (parsed.contentHash !== entry.contentHash) throw mismatch(`content hash ${parsed.contentHash}, listed ${entry.contentHash}`);
  const names = parsed.skills.map((s) => s.name);
  if (names.length !== entry.skills.length || names.some((n, i) => n !== entry.skills[i])) throw mismatch('its skills are not the ones listed');
  const keyId = parsed.signature?.keyId ?? null;
  if (keyId !== entry.publisherKeyId) throw mismatch(`signed by ${keyId ?? 'nobody'}, listed as ${entry.publisherKeyId ?? 'unsigned'}`);
}

/**
 * Inside an install's transaction: take `skillIds` (replaced by this install)
 * out of the caller's install records, except `keep`'s own. A skill replaced
 * by another import, or by another listing, no longer counts as installed
 * from the listing it came from.
 */
export async function detachReplacedSkills(tx: SkillExec, userId: string, skillIds: readonly string[], keep?: { registry: string; urlKey: string; name: string }): Promise<void> {
  if (skillIds.length === 0) return;
  const replaced = new Set(skillIds);
  for (const row of await tx.select().from(skillRegistryInstalls).where(eq(skillRegistryInstalls.ownerKey, userId))) {
    if (keep && row.registry === keep.registry && row.registryUrlSha256 === keep.urlKey && row.name === keep.name) continue;
    if (!row.skillIds.some((id) => replaced.has(id))) continue;
    await tx.update(skillRegistryInstalls).set({ skillIds: row.skillIds.filter((id) => !replaced.has(id)) }).where(eq(skillRegistryInstalls.id, row.id));
  }
}

/**
 * Record which listing and version the caller installed (inside the
 * install's transaction): one row per owner, registry (name and URL) and
 * listing name, with every version and content hash installed in `history`.
 */
export async function recordRegistryInstall(
  tx: SkillExec, userId: string, registry: { name: string; urlKey: string }, source: SkillRegistrySource, contentHash: string, skillIds: readonly string[],
): Promise<void> {
  const where = and(
    eq(skillRegistryInstalls.ownerKey, userId), eq(skillRegistryInstalls.registry, registry.name),
    eq(skillRegistryInstalls.registryUrlSha256, registry.urlKey), eq(skillRegistryInstalls.name, source.name),
  );
  const [existing] = await tx.select().from(skillRegistryInstalls).where(where);
  const now = new Date();
  const event: SkillRegistryInstallEvent = { version: source.version, contentHash, installedAt: now.toISOString() };
  const history = [...(existing?.history ?? []).filter((h) => h.version !== event.version || h.contentHash !== event.contentHash), event].slice(-MAX_HISTORY);
  const values = { version: source.version, contentHash, skillIds: [...skillIds], history, installedAt: now };
  if (existing) await tx.update(skillRegistryInstalls).set(values).where(eq(skillRegistryInstalls.id, existing.id));
  else await tx.insert(skillRegistryInstalls).values({ ownerKey: userId, registry: registry.name, registryUrlSha256: registry.urlKey, name: source.name, ...values });
}
