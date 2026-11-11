/**
 * The per-user plugin store (docs/PLUGIN-PACKAGES.md#store): every read and
 * write of `plugin_store` goes through here.
 *
 * Every method takes the package and the user, and every query is bound to
 * both: there is no method that reads or writes across users (the usage sums
 * for the admin view return sizes and counts per user, never a key or a
 * value). The callers take the user from the call's token or the signed-in
 * session, never from the request.
 *
 * A write is atomic with its quota check: it holds a transaction-scoped
 * advisory lock on (package, user), so two concurrent writes cannot both fit
 * in the space that only one of them fits in.
 */
import { and, asc, eq, like, sql } from 'drizzle-orm';
import { getDb } from '../postgres';
import { pluginStore } from '../schema/plugin-packages';

export interface StoreEntry {
  value: unknown;
  version: number;
  protectionLevel: number;
  size: number;
  updatedAt: Date;
}

export interface StoreKeyRow {
  key: string;
  size: number;
  version: number;
  protectionLevel: number;
  updatedAt: Date;
}

export type StorePutResult =
  | { ok: true; version: number; size: number }
  /** `ifVersion` did not match: the entry is at `current` (0: it does not exist). */
  | { ok: false; code: 'version_conflict'; current: number }
  /** The write would take the user's entries of this package over the quota. */
  | { ok: false; code: 'quota'; used: number; quota: number };

export interface StoreUsageTotals {
  bytes: number;
  entries: number;
  byUser: Array<{ userId: string; bytes: number; entries: number }>;
}

/** The bytes an entry counts against the quota: its key and its JSON, UTF-8. */
export function storeEntrySize(key: string, json: string): number {
  return Buffer.byteLength(key, 'utf8') + Buffer.byteLength(json, 'utf8');
}

const escapeLike = (s: string) => s.replace(/[%_\\]/g, '\\$&');

const scope = (pkg: string, userId: string) => and(eq(pluginStore.packageName, pkg), eq(pluginStore.userId, userId));

export const pluginStoreRepository = {
  /** One entry of `userId` for `pkg`, or null. */
  async get(pkg: string, userId: string, key: string): Promise<StoreEntry | null> {
    const [row] = await getDb().select({
      value: pluginStore.value, version: pluginStore.version, protectionLevel: pluginStore.protectionLevel,
      size: pluginStore.sizeBytes, updatedAt: pluginStore.updatedAt,
    }).from(pluginStore).where(and(scope(pkg, userId), eq(pluginStore.key, key))).limit(1);
    return row ?? null;
  },

  /** The keys of `userId` for `pkg` (sorted), starting with `prefix`, at most `limit`. No values. */
  async list(pkg: string, userId: string, opts: { prefix?: string; limit: number }): Promise<StoreKeyRow[]> {
    const where = opts.prefix
      ? and(scope(pkg, userId), like(pluginStore.key, `${escapeLike(opts.prefix)}%`))
      : scope(pkg, userId);
    return getDb().select({
      key: pluginStore.key, size: pluginStore.sizeBytes, version: pluginStore.version,
      protectionLevel: pluginStore.protectionLevel, updatedAt: pluginStore.updatedAt,
    }).from(pluginStore).where(where).orderBy(asc(pluginStore.key)).limit(opts.limit);
  },

  /**
   * Write one entry of `userId` for `pkg`: insert it at version 1 or replace
   * it at the next version, at `protectionLevel`. With `ifVersion` only if the
   * entry is at that version now (0: only if it does not exist). Refused when
   * it would take the user's entries over `quotaBytes`; a write that does not
   * grow the entry is always allowed (a quota lowered by an upgrade leaves
   * room to shrink).
   */
  async put(pkg: string, userId: string, key: string, json: string, opts: { protectionLevel: number; quotaBytes: number; ifVersion?: number }): Promise<StorePutResult> {
    const size = storeEntrySize(key, json);
    const level = Math.min(4, Math.max(1, Math.ceil(opts.protectionLevel)));
    return getDb().transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`plugin-store:${pkg}:${userId}`}))`);
      const [current] = await tx.select({ version: pluginStore.version, size: pluginStore.sizeBytes })
        .from(pluginStore).where(and(scope(pkg, userId), eq(pluginStore.key, key))).limit(1);
      if (opts.ifVersion !== undefined && (current?.version ?? 0) !== opts.ifVersion) {
        return { ok: false as const, code: 'version_conflict' as const, current: current?.version ?? 0 };
      }
      const [{ used }] = await tx.select({ used: sql<number>`coalesce(sum(${pluginStore.sizeBytes}), 0)::int` })
        .from(pluginStore).where(scope(pkg, userId));
      const after = Number(used) - (current?.size ?? 0) + size;
      if (after > opts.quotaBytes && size > (current?.size ?? 0)) {
        return { ok: false as const, code: 'quota' as const, used: Number(used), quota: opts.quotaBytes };
      }
      const value = sql`${json}::jsonb`;
      if (current) {
        const [row] = await tx.update(pluginStore)
          .set({ value, sizeBytes: size, protectionLevel: level, version: sql`${pluginStore.version} + 1`, updatedAt: new Date() })
          .where(and(scope(pkg, userId), eq(pluginStore.key, key)))
          .returning({ version: pluginStore.version });
        return { ok: true as const, version: row.version, size };
      }
      const [row] = await tx.insert(pluginStore)
        .values({ packageName: pkg, userId, key, value, sizeBytes: size, protectionLevel: level, version: 1 })
        .returning({ version: pluginStore.version });
      return { ok: true as const, version: row.version, size };
    });
  },

  /** Delete one entry of `userId` for `pkg`; whether there was one. */
  async delete(pkg: string, userId: string, key: string): Promise<boolean> {
    const rows = await getDb().delete(pluginStore).where(and(scope(pkg, userId), eq(pluginStore.key, key))).returning({ key: pluginStore.key });
    return rows.length > 0;
  },

  /** Delete every entry of `userId` for `pkg` ("Delete my data"); how many and how large. */
  async deleteUser(pkg: string, userId: string): Promise<{ entries: number; bytes: number }> {
    const rows = await getDb().delete(pluginStore).where(scope(pkg, userId)).returning({ size: pluginStore.sizeBytes });
    return { entries: rows.length, bytes: rows.reduce((n, r) => n + r.size, 0) };
  },

  /** Delete every user's entries of `pkg` (uninstall); how many. */
  async deletePackage(pkg: string): Promise<number> {
    const rows = await getDb().delete(pluginStore).where(eq(pluginStore.packageName, pkg)).returning({ key: pluginStore.key });
    return rows.length;
  },

  /** Bytes and entries of `pkg`: of every user, by user (admins), or of `userId` only. Sizes and counts, never keys or values. */
  async usage(pkg: string, userId?: string): Promise<StoreUsageTotals> {
    const rows = await getDb().select({
      userId: pluginStore.userId,
      bytes: sql<number>`coalesce(sum(${pluginStore.sizeBytes}), 0)::int`,
      entries: sql<number>`count(*)::int`,
    }).from(pluginStore)
      .where(userId ? scope(pkg, userId) : eq(pluginStore.packageName, pkg))
      .groupBy(pluginStore.userId);
    const byUser = rows.map((r) => ({ userId: r.userId, bytes: Number(r.bytes), entries: Number(r.entries) }))
      .sort((a, b) => b.bytes - a.bytes || a.userId.localeCompare(b.userId));
    return { bytes: byUser.reduce((n, r) => n + r.bytes, 0), entries: byUser.reduce((n, r) => n + r.entries, 0), byUser };
  },

  /** What `userId` keeps in each package's store: package name → bytes and entries. */
  async usageOfUser(userId: string): Promise<Map<string, { bytes: number; entries: number }>> {
    const rows = await getDb().select({
      pkg: pluginStore.packageName,
      bytes: sql<number>`coalesce(sum(${pluginStore.sizeBytes}), 0)::int`,
      entries: sql<number>`count(*)::int`,
    }).from(pluginStore).where(eq(pluginStore.userId, userId)).groupBy(pluginStore.packageName);
    return new Map(rows.map((r) => [r.pkg, { bytes: Number(r.bytes), entries: Number(r.entries) }]));
  },
};
