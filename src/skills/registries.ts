/**
 * Skill registries (docs/SKILL-EXCHANGE.md#registries): the static indexes an
 * operator lists in `skills.registries`, browsed and searched on the Skills
 * page, and the bundle download behind a registry preview and install.
 *
 * - **Nothing by default.** No registry is configured, and none is contacted
 *   unless the operator lists it.
 * - **Fetching.** Every index and bundle goes through the SSRF-guarded https
 *   download plugin packages use (`downloadHttps`: private addresses refused
 *   after resolution, redirects checked again, a byte cap while streaming, a
 *   timeout). An index is cached for `SKILL_REGISTRY_CACHE_MS`, at most
 *   `MAX_CACHED_INDEXES` of them.
 * - **Trust.** An index is untrusted input (./registry-index.ts). A bundle
 *   must hash to the index's digest, match what the listing says of it, and
 *   then pass the exchange's own signature check with a key of one of the
 *   registry's publishers (`checkBundleTrust`): the digest pins the bytes, it
 *   never stands in for the signature.
 * - **No updates.** A newer version is shown as available; installing it is
 *   a new preview and install. Nothing here writes a skill.
 */
import { createHash } from 'node:crypto';
import { inArray, eq } from 'drizzle-orm';
import { getConfig } from '@/config';
import { getDb } from '@/db/postgres';
import type { SkillExec } from '@/db/repositories/skill-repository';
import { skillRegistryInstalls } from '@/db/schema/skill-registry-installs';
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
/** The most listings one answer carries. */
export const MAX_LISTINGS = 500;
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

type IndexResult = { index: ParsedSkillIndex; error: null } | { index: null; error: string };
const cache = new Map<string, { at: number; ttl: number; result: IndexResult }>();

/** Forget every cached index (a config change, tests). */
export function clearSkillRegistryCache(): void {
  cache.clear();
}

/** Fetch and parse one index, uncached. Throws `RemoteFetchError` or `SkillIndexError`. */
async function fetchIndex(registry: SkillRegistryConfig): Promise<ParsedSkillIndex> {
  const bytes = await downloadHttps(registry.url, { maxBytes: MAX_SKILL_INDEX_BYTES, timeoutMs: INDEX_TIMEOUT_MS, accept: 'application/json' });
  const index = parseSkillIndex(bytes);
  if (index.problems.length > 0) coreLogger.warn({ registry: registry.name, problems: index.problems.slice(0, 20) }, 'Skill registry index has entries that were skipped');
  return index;
}

/**
 * A registry's index, cached for `SKILL_REGISTRY_CACHE_MS` (a failure for
 * `FAILURE_CACHE_MS`). A refusal (unreachable, too large, malformed) is an
 * error the listing reports, never a throw.
 */
export async function readSkillIndex(registry: SkillRegistryConfig): Promise<IndexResult> {
  const key = `${registry.name}\n${registry.url}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < hit.ttl) return hit.result;
  let result: IndexResult;
  try {
    result = { index: await fetchIndex(registry), error: null };
  } catch (err) {
    if (!(err instanceof RemoteFetchError) && !(err instanceof SkillIndexError)) throw err;
    coreLogger.warn({ registry: registry.name, err: err.message }, 'Skill registry could not be read');
    result = { index: null, error: err.message };
  }
  cache.delete(key);
  for (const [k, v] of cache) if (Date.now() - v.at >= v.ttl) cache.delete(k);
  while (cache.size >= MAX_CACHED_INDEXES) cache.delete(cache.keys().next().value as string);
  cache.set(key, { at: Date.now(), ttl: result.error === null ? SKILL_REGISTRY_CACHE_MS : FAILURE_CACHE_MS, result });
  return result;
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

/** The versions the caller (`owner_key`: a user id, or `system`) installed, by registry and listing name; a record whose skills are all gone no longer counts. */
async function installedVersions(userId: string): Promise<Map<string, string>> {
  const rows = await getDb().select().from(skillRegistryInstalls).where(eq(skillRegistryInstalls.ownerKey, userId));
  if (rows.length === 0) return new Map();
  const ids = [...new Set(rows.flatMap((r) => r.skillIds))];
  const alive = new Set(ids.length === 0 ? [] : (await getDb().select({ id: skills.id }).from(skills).where(inArray(skills.id, ids))).map((r) => r.id));
  return new Map(rows.filter((r) => r.skillIds.some((id) => alive.has(id))).map((r) => [`${r.registry}\n${r.name}`, r.version]));
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
 * configured, nothing is fetched.
 */
export async function listSkillRegistries(userId: string, filter: { q?: string; tag?: string } = {}): Promise<SkillRegistryListingResponse> {
  const registries = configuredSkillRegistries();
  if (registries.length === 0) return { registries: [], listings: [], errors: [], problems: [], truncated: false };
  const results = await mapBounded(registries, FETCH_CONCURRENCY, async (r) => ({ registry: r, ...(await readSkillIndex(r)) }));
  const ring = bundleKeyRing();
  const installed = await installedVersions(userId);
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
      const installedVersion = installed.get(`${registry.name}\n${newest.name}`) ?? null;
      listings.push({
        ...newest,
        registry: registry.name,
        olderVersions: versions.slice(1).map((v) => v.version),
        signature: listedSignature(newest.publisherKeyId, ring, registry.publishers),
        installedVersion,
        updateAvailable: installedVersion !== null && compareVersions(newest.version, installedVersion) > 0,
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
 * digest. Throws `SkillBundleError`.
 */
export async function fetchRegistryBundle(source: SkillRegistrySource): Promise<RegistryBundle> {
  const registry = configuredSkillRegistries().find((r) => r.name === source.registry);
  if (!registry) throw new SkillBundleError(`"${source.registry}" is not a skill registry configured here (skills.registries)`);
  const read = await readSkillIndex(registry);
  if (!read.index) throw new SkillBundleError(`The registry ${registry.name} could not be read: ${read.error}`);
  const entry = read.index.entries.find((e) => e.name === source.name && e.version === source.version);
  if (!entry) throw new SkillBundleError(`The registry ${registry.name} does not list ${source.name} ${source.version}`, 404);
  coreLogger.info({ registry: registry.name, name: entry.name, version: entry.version, url: entry.bundleUrl }, 'Skill registry: fetching a bundle');
  let bytes: Buffer;
  try {
    bytes = await downloadHttps(entry.bundleUrl, { maxBytes: MAX_BUNDLE_BYTES, timeoutMs: BUNDLE_TIMEOUT_MS, accept: 'application/json' });
  } catch (err) {
    if (err instanceof RemoteFetchError) throw new SkillBundleError(err.message);
    throw err;
  }
  const actual = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (actual !== entry.bundleSha256) {
    throw new SkillBundleError(`The bundle at ${entry.bundleUrl} hashes to ${actual}, not to the ${entry.bundleSha256} the registry ${registry.name} lists; not imported`);
  }
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

/** Record which listing and version the caller installed (inside the install's transaction). One row per owner, registry and listing name. */
export async function recordRegistryInstall(tx: SkillExec, userId: string, source: SkillRegistrySource, contentHash: string, skillIds: readonly string[]): Promise<void> {
  const row = { ownerKey: userId, registry: source.registry, name: source.name, version: source.version, contentHash, skillIds: [...skillIds], installedAt: new Date() };
  await tx.insert(skillRegistryInstalls).values(row).onConflictDoUpdate({
    target: [skillRegistryInstalls.ownerKey, skillRegistryInstalls.registry, skillRegistryInstalls.name],
    set: { version: row.version, contentHash: row.contentHash, skillIds: row.skillIds, installedAt: row.installedAt },
  });
}
