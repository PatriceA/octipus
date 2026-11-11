/**
 * The per-user plugin store (docs/PLUGIN-PACKAGES.md#store): what the host
 * API (`/api/plugin-host/store`, a package's tools) and the page bridge
 * (`/api/plugins/:name/store`, the signed-in user on the package's page) do
 * with it. The rows go through src/db/repositories/plugin-store-repository.ts.
 *
 * The user is always the caller's own: the user of the call's token, or the
 * signed-in user of the page. Nothing here takes a user from a request, so a
 * package cannot name another user, and there is no store shared across
 * users.
 *
 * Limits: a key matches `PLUGIN_STORE_KEY_RE` with no empty, `.` or `..`
 * segment (so it is the same path through the egress proxy and the browser);
 * a value is JSON of at most `PLUGIN_STORE_MAX_VALUE_BYTES`; a user's entries
 * of a package stay within the quota its manifest declares (checked
 * atomically with the write).
 *
 * Protection levels: an entry records the level it was written at (the
 * call's read level); reading it is refused above the package's
 * `maxProtection` and raises the reader to its level. A list leaves out the
 * keys of entries above `maxProtection` (a key can carry data too) and
 * raises the reader to the highest level it hands over.
 */
import { eq } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { pluginStoreRepository } from '@/db/repositories/plugin-store-repository';
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
  } catch {
    json = undefined;
  }
  if (json === undefined) return { status: 400, code: 'invalid_value', error: 'The value is not JSON' };
  // Postgres jsonb has no NUL character.
  if (json.includes('\\u0000')) return { status: 400, code: 'invalid_value', error: 'The value may not contain a NUL character' };
  if (Buffer.byteLength(json, 'utf8') > PLUGIN_STORE_MAX_VALUE_BYTES) {
    return { status: 413, code: 'too_large', error: `A value is at most ${PLUGIN_STORE_MAX_VALUE_BYTES} bytes of JSON` };
  }
  return { json };
}

/** The per-user quota of an installed package, or null when it declares no store (or is not installed). */
export async function storeQuotaOf(pkg: string): Promise<number | null> {
  const [row] = await getDb().select({ manifest: pluginPackages.manifest }).from(pluginPackages).where(eq(pluginPackages.name, pkg)).limit(1);
  return row ? pluginStoreQuota(row.manifest) : null;
}

/** One entry of `userId`: its value and version, and its level (refused above `maxProtection`). */
export async function storeGet(pkg: string, userId: string, key: string, maxProtection: number): Promise<StoreOutcome<{ value: unknown; version: number; protectionLevel: number }>> {
  const problem = storeKeyProblem(key);
  if (problem) return fail(400, 'invalid_key', problem);
  const entry = await pluginStoreRepository.get(pkg, userId, key);
  if (!entry) return fail(404, 'not_found', 'No such key');
  if (entry.protectionLevel > maxProtection) {
    return fail(403, 'protection_level', `The entry was written at protection level ${entry.protectionLevel}; this package may see up to ${maxProtection}`);
  }
  return { ok: true, value: { value: entry.value, version: entry.version, protectionLevel: entry.protectionLevel } };
}

/**
 * The keys of `userId` (sorted), with size and version, starting with
 * `prefix`, at most `limit` (default 100, at most PLUGIN_STORE_MAX_LIST).
 * Keys of entries above `maxProtection` are left out (`withheld`);
 * `protectionLevel` is the highest of those handed over (1 when none).
 */
export async function storeList(
  pkg: string, userId: string, opts: { prefix?: string; limit?: number }, maxProtection: number,
): Promise<StoreOutcome<{ keys: PluginStoreKeyView[]; withheld: number; truncated: boolean; protectionLevel: number }>> {
  const problem = storePrefixProblem(opts.prefix);
  if (problem) return fail(400, 'invalid_prefix', problem);
  const limit = Math.min(PLUGIN_STORE_MAX_LIST, Math.max(1, Math.floor(opts.limit ?? 100) || 100));
  const rows = await pluginStoreRepository.list(pkg, userId, { prefix: opts.prefix || undefined, limit: limit + 1 });
  const truncated = rows.length > limit;
  const page = rows.slice(0, limit);
  const kept = page.filter((r) => r.protectionLevel <= maxProtection);
  return {
    ok: true,
    value: {
      keys: kept.map((r) => ({ key: r.key, size: r.size, version: r.version, updatedAt: r.updatedAt.toISOString() })),
      withheld: page.length - kept.length,
      truncated,
      protectionLevel: Math.max(1, ...kept.map((r) => r.protectionLevel)),
    },
  };
}

/**
 * Write one entry of `userId` at `protectionLevel`, within the package's
 * quota; with `ifVersion`, only if the entry is at that version now (0: only
 * if there is none).
 */
export async function storePut(
  pkg: string, userId: string, key: string, body: { value?: unknown; ifVersion?: number }, protectionLevel: number,
): Promise<StoreOutcome<{ version: number; size: number }>> {
  const problem = storeKeyProblem(key);
  if (problem) return fail(400, 'invalid_key', problem);
  if (!Object.hasOwn(body, 'value')) return fail(400, 'invalid_value', 'The body is { value, ifVersion? }');
  if (body.ifVersion !== undefined && !(Number.isInteger(body.ifVersion) && body.ifVersion >= 0)) {
    return fail(400, 'invalid_version', 'ifVersion is a whole number, 0 for "only if it does not exist"');
  }
  const encoded = encodeStoreValue(body.value);
  if ('error' in encoded) return fail(encoded.status, encoded.code, encoded.error);
  const quota = await storeQuotaOf(pkg);
  if (quota === null) return fail(403, 'no_store', 'This package declares no store');
  const result = await pluginStoreRepository.put(pkg, userId, key, encoded.json, { protectionLevel, quotaBytes: quota, ifVersion: body.ifVersion });
  if (result.ok) return { ok: true, value: { version: result.version, size: result.size } };
  if (result.code === 'version_conflict') {
    return fail(409, 'version_conflict', `The entry is at version ${result.current}, not ${body.ifVersion}`, { current: result.current });
  }
  return fail(413, 'quota', `This would take your data of this package over its quota of ${result.quota} bytes (${result.used} used)`);
}

/** Delete one entry of `userId`. */
export async function storeDelete(pkg: string, userId: string, key: string): Promise<StoreOutcome<{ deleted: true }>> {
  const problem = storeKeyProblem(key);
  if (problem) return fail(400, 'invalid_key', problem);
  return await pluginStoreRepository.delete(pkg, userId, key) ? { ok: true, value: { deleted: true } } : fail(404, 'not_found', 'No such key');
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
