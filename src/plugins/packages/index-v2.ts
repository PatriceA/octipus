/**
 * Registry index v2 (docs/PLUGIN-PACKAGES.md#index-v2), parsed strictly.
 *
 * Every byte of an index is hostile until checked, even a signed one (a
 * signature says who wrote it, not that it is well-formed). So:
 *
 * - **Shape.** A zod schema with a length limit on every string and an item
 *   limit on every list. A `schema` greater than 2 is refused (the host does
 *   not know what it would be agreeing to); v1 indexes (no `schema`, or 1)
 *   are read as before (./remote.ts, `parseRegistryIndex`).
 * - **Text.** No control characters (tab and newline only where text is
 *   Markdown), and no bidirectional overrides in names, titles and other
 *   short fields (they can make a listing read as something else).
 * - **URLs.** Only http(s), and only https for anything the host fetches.
 *   The tarball is https; icons and screenshots must be https on the
 *   registry's own origin under `/<name>/`, anything else is dropped (never
 *   followed). A homepage or author link is display-only: https or dropped.
 * - **Key ids.** The index's `keyId` is never used: who signed a package is
 *   read from its signature.
 * - **Entries.** One that does not fit is skipped (and reported), so it can
 *   never be installed; a name and version listed twice are both skipped.
 * - **Revocations.** All or nothing: a malformed `revoked` refuses the whole
 *   index, since skipping one would silently un-revoke it.
 */
import { z } from 'zod';
import { PLUGIN_RUNTIMES, PLUGIN_TOOL_EFFECTS, type PluginPermissionsSummary } from '@/shared/plugin-package';
import { manifestSchema } from './manifest';
import { normalizeSha256, parseRegistryIndex } from './remote';
import { isKeyId } from './signature';

/** The highest index format this host reads. */
export const INDEX_SCHEMA_VERSION = 2;
/** Most entries an index may list. */
export const MAX_INDEX_ENTRIES = 5000;
/** Most revocations an index may list. */
export const MAX_INDEX_REVOCATIONS = 2000;
/** The longest README and CHANGELOG kept (characters). */
export const MAX_README_CHARS = 200_000;
export const MAX_CHANGELOG_CHARS = 100_000;

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const CORE_SEMVER_RE = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
/** C0 controls other than tab, newline and carriage return, DEL and C1 controls. */
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
/** Any control character at all (single-line fields). */
const ANY_CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/;
/** Bidirectional embeddings, overrides and isolates, and zero-width marks that can disguise a short text. */
const BIDI_RE = /[؜​-‏‪-‮⁦-⁩﻿]/;

/** A single-line text field. */
export const line = (max: number) => z.string().max(max)
  .refine((s) => !ANY_CONTROL_RE.test(s), 'no control characters')
  .refine((s) => !BIDI_RE.test(s), 'no bidirectional or invisible formatting characters');
/** A Markdown text (README, CHANGELOG): tab and newlines allowed, other controls not. */
const markdown = (max: number) => z.string().max(max).refine((s) => !CONTROL_RE.test(s), 'no control characters');
export const isoTime = z.string().max(40).regex(ISO_RE, 'an ISO date-time with a zone').refine((s) => !Number.isNaN(Date.parse(s)), 'not a real time');
const sortedUnique = (items: readonly string[]) => items.every((v, i) => i === 0 || items[i - 1] < v);

/** `computePermissions` output, as an index lists it: exactly these keys, bounded. */
export const indexPermissionsSchema = z.object({
  name: z.string().max(50),
  version: z.string().max(100).regex(SEMVER_RE),
  apiVersion: z.string().max(100).regex(SEMVER_RE),
  runtime: z.enum(PLUGIN_RUNTIMES),
  host: z.array(line(40)).max(30),
  network: z.array(line(300)).max(50),
  tools: z.array(z.object({ name: line(64), effect: z.enum(PLUGIN_TOOL_EFFECTS) }).strict()).max(200),
  effects: z.object({ read: z.number().int().min(0).max(200), write: z.number().int().min(0).max(200), external: z.number().int().min(0).max(200) }).strict(),
  contributions: z.object({
    commands: z.array(line(64)).max(100),
    schedules: z.array(line(64)).max(100),
    events: z.array(line(64)).max(100),
    prompt: z.boolean(),
    context: z.boolean(),
  }).strict(),
  pages: z.number().int().min(0).max(100),
  trustedInput: z.boolean(),
  maxProtection: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
}).strict().refine((p) => sortedUnique(p.host) && sortedUnique(p.network), 'host and network are sorted lists without repeats');

const authorSchema = z.object({ name: line(80).pipe(z.string().min(1)), url: z.string().max(300).optional().nullable() }).strict();

/** One v2 entry. Unknown keys are dropped (an older host ignores newer listing fields); known ones are checked. */
const entrySchema = z.object({
  name: manifestSchema.shape.name,
  version: z.string().max(100).regex(SEMVER_RE),
  description: line(2000).optional().nullable(),
  url: z.string().max(2000),
  sha256: z.string().max(80),
  contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  apiVersion: z.string().max(100).regex(SEMVER_RE),
  minOctipus: z.string().regex(CORE_SEMVER_RE).optional().nullable(),
  title: line(100).optional().nullable(),
  summary: line(200).optional().nullable(),
  category: z.string().max(40).regex(/^[a-z][a-z0-9-]{0,39}$/).optional().nullable(),
  tags: z.array(z.string().max(24).regex(/^[a-z0-9][a-z0-9-]{0,23}$/)).max(8).optional().nullable(),
  icon: z.string().max(500).optional().nullable(),
  screenshots: z.array(z.string().max(500)).max(6).optional().nullable(),
  homepage: z.string().max(300).optional().nullable(),
  author: authorSchema.optional().nullable(),
  readme: markdown(MAX_README_CHARS).optional().nullable(),
  changelog: markdown(MAX_CHANGELOG_CHARS).optional().nullable(),
  publisher: line(100).optional().nullable(),
  license: line(100).optional().nullable(),
  publishedAt: isoTime.optional().nullable(),
  keyId: z.string().max(80).refine(isKeyId, 'a key id, ed25519:<64 hex>').optional().nullable(),
  permissions: indexPermissionsSchema,
  deprecated: line(300).optional().nullable(),
});

const revokedSchema = z.array(z.union([
  z.object({ name: manifestSchema.shape.name, version: z.string().max(100).regex(SEMVER_RE), reason: line(500).optional().nullable() }).strict(),
  z.object({ keyId: z.string().max(80).refine(isKeyId, 'a key id, ed25519:<64 hex>'), reason: line(500).optional().nullable() }).strict(),
])).max(MAX_INDEX_REVOCATIONS);

const topSchema = z.object({
  schema: z.literal(2),
  generatedAt: isoTime,
  publisher: line(100).optional().nullable(),
  url: z.string().max(2000).optional().nullable(),
  packages: z.array(z.unknown()).max(MAX_INDEX_ENTRIES),
  revoked: revokedSchema.optional().nullable(),
});

/** A listed package, as the host uses it (v1 entries have the v2 fields null). */
export interface IndexEntry {
  registry: string;
  name: string;
  version: string;
  description: string | null;
  url: string;
  sha256: string;
  contentHash: string | null;
  apiVersion: string | null;
  minOctipus: string | null;
  title: string | null;
  summary: string | null;
  category: string | null;
  tags: string[];
  /** https, on the registry's origin; else null. */
  icon: string | null;
  screenshots: string[];
  homepage: string | null;
  author: { name: string; url: string | null } | null;
  readme: string | null;
  changelog: string | null;
  publisher: string | null;
  license: string | null;
  publishedAt: string | null;
  permissions: PluginPermissionsSummary | null;
  deprecated: string | null;
}

export interface ParsedIndex {
  schema: 1 | 2;
  generatedAt: Date | null;
  entries: IndexEntry[];
  revoked: { packages: Array<{ name: string; version: string; reason: string }>; keys: Array<{ keyId: string; reason: string }> };
  /** Entries skipped, and why. */
  problems: string[];
}

export class IndexFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IndexFormatError';
  }
}

/** A URL the host may fetch: https, no credentials, no fragment; the normalised string or null. */
export function fetchableUrl(value: unknown, sameOriginAs?: string): string | null {
  if (typeof value !== 'string' || value.length > 2000) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || value.includes('#')) return null;
  if (sameOriginAs !== undefined) {
    let origin: string;
    try {
      origin = new URL(sameOriginAs).origin;
    } catch {
      return null;
    }
    if (url.origin !== origin) return null;
  }
  return url.toString();
}

/** A display-only link: https, no credentials; else null. Never fetched by the host. */
export function displayUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 300) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  return url.toString();
}

/** A listing image: https, on the registry's origin, under `/<name>/` (where the marketplace serves a plugin's images); else null. */
export function assetUrl(value: unknown, registryUrl: string, name: string): string | null {
  const url = fetchableUrl(value, registryUrl);
  if (url === null) return null;
  const parsed = new URL(url);
  if (parsed.search !== '' || !parsed.pathname.startsWith(`/${name}/`) || parsed.pathname.length <= name.length + 2) return null;
  return url;
}

function v1Entry(e: { registry: string; name: string; version: string; description: string | null; url: string; sha256: string }): IndexEntry {
  return {
    ...e, contentHash: null, apiVersion: null, minOctipus: null, title: null, summary: null, category: null, tags: [], icon: null, screenshots: [],
    homepage: null, author: null, readme: null, changelog: null, publisher: null, license: null, publishedAt: null, permissions: null, deprecated: null,
  };
}

function zodProblem(err: z.ZodError): string {
  return err.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ');
}

/**
 * Parse an index document fetched from `registry.url`. Throws
 * `IndexFormatError` when the index as a whole cannot be used (an unknown
 * schema, a malformed v2 header or `revoked`); a bad entry is skipped and
 * reported in `problems`. `tarballSameOrigin` also requires each tarball to
 * be on the registry's origin (the marketplace).
 */
export function parseIndexDocument(json: unknown, registry: { name: string; url: string }, opts: { tarballSameOrigin?: boolean } = {}): ParsedIndex {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new IndexFormatError('The index is not a JSON object');
  const raw = json as Record<string, unknown>;
  const schema = raw.schema;
  if (schema === undefined || schema === 1) {
    const { entries, problems } = parseRegistryIndex(json, registry.name);
    const kept = opts.tarballSameOrigin ? entries.filter((e) => fetchableUrl(e.url, registry.url) !== null) : entries;
    if (kept.length !== entries.length) problems.push(`${entries.length - kept.length} entries with a tarball off the registry's origin skipped`);
    return { schema: 1, generatedAt: null, entries: kept.map(v1Entry), revoked: { packages: [], keys: [] }, problems };
  }
  if (typeof schema !== 'number' || !Number.isInteger(schema)) throw new IndexFormatError('The index "schema" is not a whole number');
  if (schema > INDEX_SCHEMA_VERSION) throw new IndexFormatError(`The index is schema ${schema}; this host reads up to ${INDEX_SCHEMA_VERSION}: update Octipus`);
  if (schema !== 2) throw new IndexFormatError(`The index "schema" ${schema} is not one this host reads`);
  const top = topSchema.safeParse(raw);
  if (!top.success) throw new IndexFormatError(`The index does not fit index v2: ${zodProblem(top.error)}`);

  const revoked: ParsedIndex['revoked'] = { packages: [], keys: [] };
  for (const r of top.data.revoked ?? []) {
    if ('keyId' in r) revoked.keys.push({ keyId: r.keyId, reason: r.reason ?? '' });
    else revoked.packages.push({ name: r.name, version: r.version, reason: r.reason ?? '' });
  }

  const problems: string[] = [];
  const entries: IndexEntry[] = [];
  top.data.packages.forEach((item, i) => {
    const parsed = entrySchema.safeParse(item);
    const label = `packages[${i}]${typeof (item as { name?: unknown })?.name === 'string' ? ` (${String((item as { name: string }).name).slice(0, 50)})` : ''}`;
    if (!parsed.success) {
      problems.push(`${label}: ${zodProblem(parsed.error)}`);
      return;
    }
    const e = parsed.data;
    const url = fetchableUrl(e.url, opts.tarballSameOrigin ? registry.url : undefined);
    const sha256 = normalizeSha256(e.sha256);
    if (!url || !sha256) {
      problems.push(`${label}: ${!url ? `url (https${opts.tarballSameOrigin ? ', on the registry\'s origin' : ''}, no credentials or fragment)` : 'sha256'} missing or not valid`);
      return;
    }
    if (e.permissions.name !== e.name || e.permissions.version !== e.version || e.permissions.apiVersion !== e.apiVersion) {
      problems.push(`${label}: permissions name, version and apiVersion must be the entry's`);
      return;
    }
    const screenshots = (e.screenshots ?? []).map((s) => assetUrl(s, registry.url, e.name)).filter((s): s is string => s !== null);
    entries.push({
      registry: registry.name,
      name: e.name,
      version: e.version,
      description: e.description ?? null,
      url,
      sha256,
      contentHash: e.contentHash,
      apiVersion: e.apiVersion,
      minOctipus: e.minOctipus ?? null,
      title: e.title ?? null,
      summary: e.summary ?? null,
      category: e.category ?? null,
      tags: [...new Set(e.tags ?? [])],
      icon: assetUrl(e.icon, registry.url, e.name),
      screenshots,
      homepage: displayUrl(e.homepage),
      author: e.author ? { name: e.author.name, url: displayUrl(e.author.url) } : null,
      readme: e.readme ?? null,
      changelog: e.changelog ?? null,
      publisher: e.publisher ?? null,
      license: e.license ?? null,
      publishedAt: e.publishedAt ?? null,
      permissions: e.permissions as PluginPermissionsSummary,
      deprecated: e.deprecated ?? null,
    });
  });

  // A name and version listed twice: neither is trusted to be the one meant.
  const seen = new Map<string, number>();
  for (const e of entries) seen.set(`${e.name}@${e.version}`, (seen.get(`${e.name}@${e.version}`) ?? 0) + 1);
  const unique = entries.filter((e) => {
    if ((seen.get(`${e.name}@${e.version}`) ?? 0) === 1) return true;
    problems.push(`${e.name} ${e.version} is listed more than once; skipped`);
    return false;
  });
  return { schema: 2, generatedAt: new Date(top.data.generatedAt), entries: unique, revoked, problems };
}
