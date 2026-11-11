/**
 * The per-user plugin store (docs/PLUGIN-PACKAGES.md#store): what the host
 * API (`/api/plugin-host/store`, a package's tools) and the page bridge
 * (`/api/plugins/:name/store`, the signed-in user on the package's page) do
 * with it. The rows go through src/db/repositories/plugin-store-repository.ts.
 *
 * The user is always the caller's own: the user of the call's token, or the
 * signed-in user of the page; and so is the workspace: the one the call ran
 * in, or the page's (null: the user's personal one). Nothing here takes a
 * user or a workspace from a request, so a package cannot name another user,
 * there is no store shared across users, and what a user's calls keep in a
 * shared space is read in that space only.
 *
 * Limits: a key matches `PLUGIN_STORE_KEY_RE` with no empty, `.` or `..`
 * segment (so it is the same path through the egress proxy and the browser);
 * a value is JSON of at most `PLUGIN_STORE_MAX_VALUE_BYTES` (also as the
 * database serialises it); a user's entries of a package stay within the
 * quota its manifest declares and `PLUGIN_STORE_MAX_ENTRIES` (checked
 * atomically with the write); writes share one rate limit
 * (`storeWriteLimit`) from tools and pages.
 *
 * Protection levels: an entry records the level it was written at (the
 * call's level; an overwrite keeps the higher of that and the entry's own).
 * An entry above the caller's `maxProtection` is not there for it: a get, a
 * list, a write and a delete answer as for a missing key, so no answer
 * depends on it. Everything else an answer says about an entry (its value,
 * its key in a list, its version in a conflict, that a delete found it)
 * raises the caller to the entry's level.
 */
import { eq } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { checkRateLimit } from '@/core/artifacts/rate-limit';
import { pluginStoreRepository, type StoreScope } from '@/db/repositories/plugin-store-repository';
import { pluginPackages } from '@/db/schema/plugin-packages';
import {
  PLUGIN_STORE_KEY_RE,
  PLUGIN_STORE_MAX_LIST,
  PLUGIN_STORE_MAX_VALUE_BYTES,
  type PluginStoreKeyView,
  pluginStoreQuota,
} from '@/shared/plugin-package';

export type StoreOutcome<T> = { ok: true; value: T } | { ok: false; status: number; code: string; error: string; current?: number };

const fail = (status: number, code: string, error: string, extra: { current?: number } = {}): StoreOutcome<never> => ({ ok: false, status, code, error, ...extra });

/** Why `key` is not a store key, or null. */
export function storeKeyProblem(key: unknown): string | null {
  if (typeof key !== 'string' || !PLUGIN_STORE_KEY_RE.test(key)) return 'A key is 1-200 letters, digits and . _ : / -';
  if (key.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    return 'A key has no empty, "." or ".." segment between its slashes';
  }
  return null;
}

/** Why `prefix` is not a list prefix, or null (empty lists every key). */
export function storePrefixProblem(prefix: unknown): string | null {
  if (prefix === undefined || prefix === '') return null;
  return typeof prefix === 'string' && /^[A-Za-z0-9._:/-]{1,200}$/.test(prefix) ? null : 'A prefix is at most 200 letters, digits and . _ : / -';
}

/** `value` as the JSON stored, or why it cannot be. */
export function encodeStoreValue(value: unknown): { json: string } | { status: number; code: string; error: string } {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (err) {
    // Parsed JSON can only fail here by nesting deeper than the stack goes.
    if (err instanceof RangeError) return { status: 400, code: 'invalid_value', error: 'The value is too deeply nested' };
    json = undefined;
  }
  if (json === undefined) return { status: 400, code: 'invalid_value', error: 'The value is not JSON' };
  // Postgres jsonb has no NUL character.
  if (json.includes('\\u0000')) return { status: 400, code: 'invalid_value', error: 'The value may not contain a NUL character' };
  if (Buffer.byteLength(json, 'utf8') > PLUGIN_STORE_MAX_VALUE_BYTES) return tooLarge();
  return { json };
}

const tooLarge = () => ({ status: 413, code: 'too_large', error: `A value is at most ${PLUGIN_STORE_MAX_VALUE_BYTES} bytes of JSON` });

/** The per-user quota of an installed package, or null when it declares no store (or is not installed). */
export async function storeQuotaOf(pkg: string): Promise<number | null> {
  const [row] = await getDb().select({ manifest: pluginPackages.manifest }).from(pluginPackages).where(eq(pluginPackages.name, pkg)).limit(1);
  return row ? pluginStoreQuota(row.manifest) : null;
}

/** The answer for a key that is not there, or not there for this caller (above its `maxProtection`): the same either way. */
const notFound = () => fail(404, 'not_found', 'No such key');

/** One entry of `s`: its value and version, and its level (not found above `maxProtection`). */
export async function storeGet(s: StoreScope, key: string, maxProtection: number): Promise<StoreOutcome<{ value: unknown; version: number; protectionLevel: number }>> {
  const problem = storeKeyProblem(key);
  if (problem) return fail(400, 'invalid_key', problem);
  const entry = await pluginStoreRepository.get(s, key);
  // Above the cap the entry is not there for this caller: nothing in the answer tells it apart from a missing key.
  if (!entry || entry.protectionLevel > maxProtection) return notFound();
  return { ok: true, value: { value: entry.value, version: entry.version, protectionLevel: entry.protectionLevel } };
}

/**
 * The keys of `s` (sorted), with size and version, starting with `prefix`,
 * at most `limit` (default 100, at most PLUGIN_STORE_MAX_LIST). Entries
 * above `maxProtection` are not there for the caller: not listed, not
 * counted. `protectionLevel` is the highest of those handed over (1 when
 * none).
 */
export async function storeList(
  s: StoreScope, opts: { prefix?: string; limit?: number }, maxProtection: number,
): Promise<StoreOutcome<{ keys: PluginStoreKeyView[]; truncated: boolean; protectionLevel: number }>> {
  const problem = storePrefixProblem(opts.prefix);
  if (problem) return fail(400, 'invalid_prefix', problem);
  const limit = Math.min(PLUGIN_STORE_MAX_LIST, Math.max(1, Math.floor(opts.limit ?? 100) || 100));
  const rows = await pluginStoreRepository.list(s, { prefix: opts.prefix || undefined, limit: limit + 1, maxProtection });
  const page = rows.slice(0, limit);
  return {
    ok: true,
    value: {
      keys: page.map((r) => ({ key: r.key, size: r.size, version: r.version, updatedAt: r.updatedAt.toISOString() })),
      truncated: rows.length > limit,
      protectionLevel: Math.max(1, ...page.map((r) => r.protectionLevel)),
    },
  };
}

/**
 * What a write or delete told the caller about an entry that was there:
 * its level (null: there was none). The caller is raised to it, as by a
 * read: a version conflict, a refusal and a success each say something
 * about the entry.
 */
export type StoreWriteOutcome<T> = StoreOutcome<T> & { previousLevel: number | null };

/**
 * Write one entry of `s` at `protectionLevel` (or the entry's own level, if
 * higher), within the package's quota and entry cap; with `ifVersion`, only
 * if the entry is at that version now (0: only if there is none). An entry
 * above `maxProtection` is not there for the caller: refused as not found.
 */
export async function storePut(
  s: StoreScope, key: string, body: { value?: unknown; ifVersion?: number }, protectionLevel: number, maxProtection: number,
): Promise<StoreWriteOutcome<{ version: number; size: number }>> {
  const none = { previousLevel: null };
  const problem = storeKeyProblem(key);
  if (problem) return { ...fail(400, 'invalid_key', problem), ...none };
  if (!Object.hasOwn(body, 'value')) return { ...fail(400, 'invalid_value', 'The body is { value, ifVersion? }'), ...none };
  if (body.ifVersion !== undefined && !(Number.isInteger(body.ifVersion) && body.ifVersion >= 0)) {
    return { ...fail(400, 'invalid_version', 'ifVersion is a whole number, 0 for "only if it does not exist"'), ...none };
  }
  const encoded = encodeStoreValue(body.value);
  if ('error' in encoded) return { ...fail(encoded.status, encoded.code, encoded.error), ...none };
  const quota = await storeQuotaOf(s.pkg);
  if (quota === null) return { ...fail(403, 'no_store', 'This package declares no store'), ...none };
  const result = await pluginStoreRepository.put(s, key, encoded.json, { protectionLevel, maxProtection, quotaBytes: quota, ifVersion: body.ifVersion });
  if (result.ok) return { ok: true, value: { version: result.version, size: result.size }, previousLevel: result.previousLevel };
  if (result.code === 'hidden') return { ...notFound(), ...none };
  const was = { previousLevel: result.previousLevel };
  if (result.code === 'version_conflict') {
    return { ...fail(409, 'version_conflict', `The entry is at version ${result.current}, not ${body.ifVersion}`, { current: result.current }), ...was };
  }
  if (result.code === 'too_large') return { ...fail(413, 'too_large', tooLarge().error), ...was };
  if (result.code === 'too_many_entries') {
    return { ...fail(413, 'too_many_entries', `You keep at most ${result.max} entries in this package's store; delete some first`), ...was };
  }
  return { ...fail(413, 'quota', `This would take your data of this package over its quota of ${result.quota} bytes`), ...was };
}

/** Delete one entry of `s` (not found above `maxProtection`). */
export async function storeDelete(s: StoreScope, key: string, maxProtection: number): Promise<StoreWriteOutcome<{ deleted: true }>> {
  const problem = storeKeyProblem(key);
  if (problem) return { ...fail(400, 'invalid_key', problem), previousLevel: null };
  const result = await pluginStoreRepository.delete(s, key, maxProtection);
  return result.deleted ? { ok: true, value: { deleted: true }, previousLevel: result.previousLevel } : { ...notFound(), previousLevel: null };
}

/** The write limit of the store, per package and user: the same bucket for the host API and the page (30 in a burst, 5 a second after that). */
export function storeWriteLimit(pkg: string, userId: string): { allowed: boolean; retryAfterSeconds?: number } {
  return checkRateLimit(`plugin-store-write:${pkg}:${userId}`, { capacity: 30, refillPerSecond: 5 });
}

/** The key of a store request: the path after `<marker>`, decoded once (the egress proxy forwards no `%`). */
export function storeKeyFromPath(url: string, marker: string): string {
  const pathname = new URL(url).pathname;
  const at = pathname.indexOf(marker);
  if (at < 0) return '';
  try {
    return decodeURIComponent(pathname.slice(at + marker.length));
  } catch {
    return '';
  }
}
