/**
 * The per-user plugin store (docs/PLUGIN-PACKAGES.md#store): every read and
 * write of `plugin_store` (and its running totals, `plugin_store_usage`)
 * goes through here.
 *
 * Every method that reads or writes entries takes a `StoreScope`: the
 * package, the user and the workspace (null: the user's personal one), and
 * every query is bound to all three. There is no method that reads or writes
 * entries across users (the usage sums for the admin view return sizes and
 * counts per user, never a key or a value). The callers take the user and the
 * workspace from the call's token or the signed-in session, never from the
 * request.
 *
 * A write is atomic with its quota check: it holds a transaction-scoped
 * advisory lock on (package, user), so two concurrent writes cannot both fit
 * in the space that only one of them fits in. The quota and the entry cap are
 * per user and package, across workspaces; the running totals per (package,
 * user, workspace) are updated in the same transaction as the write.
 *
 * Protection levels: an entry above the caller's `maxProtection` is not
 * there for the caller: a get, a list, a write and a delete treat it as
 * missing, and nothing they answer depends on it (no version, no level).
 * A write over an entry keeps the higher of its level and the call's, and
 * every answer about an existing entry carries its level (`previousLevel`),
 * so the caller is raised to what the answer tells it.
 */
import { and, asc, eq, gt, isNull, like, lte, sql } from 'drizzle-orm';
import { getDb } from '../postgres';
import { pluginStore, pluginStoreUsage } from '../schema/plugin-packages';
import { PLUGIN_STORE_ENTRY_OVERHEAD_BYTES, PLUGIN_STORE_MAX_ENTRIES, PLUGIN_STORE_MAX_VALUE_BYTES } from '@/shared/plugin-package';

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Exec = Db | Tx;

/** Whose entries: one package, one user, one workspace (null: the user's personal one). */
export interface StoreScope {
  pkg: string;
  userId: string;
  workspaceId: string | null;
}

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
  | { ok: true; version: number; size: number; previousLevel: number | null }
  /** There is an entry above `maxProtection` (to the caller: nothing there it may touch). */
  | { ok: false; code: 'hidden' }
  /** `ifVersion` did not match: the entry is at `current` (0: it does not exist). */
  | { ok: false; code: 'version_conflict'; current: number; previousLevel: number | null }
  /** The write would take the user's entries of this package over the quota. */
  | { ok: false; code: 'quota'; quota: number; previousLevel: number | null }
  /** The write would add an entry beyond `PLUGIN_STORE_MAX_ENTRIES`. */
  | { ok: false; code: 'too_many_entries'; max: number; previousLevel: number | null }
  /** The value, as the database serialises it, is larger than `PLUGIN_STORE_MAX_VALUE_BYTES`. */
  | { ok: false; code: 'too_large'; previousLevel: number | null };

export type StoreDeleteResult =
  | { deleted: true; previousLevel: number }
  /** No entry, or one above `maxProtection`. */
  | { deleted: false };

export interface StoreUsageTotals {
  bytes: number;
  entries: number;
  byUser: Array<{ userId: string; bytes: number; entries: number }>;
}

const escapeLike = (s: string) => s.replace(/[%_\\]/g, '\\$&');

const workspaceIs = (column: typeof pluginStore.workspaceId | typeof pluginStoreUsage.workspaceId, workspaceId: string | null) =>
  workspaceId === null ? isNull(column) : eq(column, workspaceId);

const scoped = (s: StoreScope) => and(eq(pluginStore.packageName, s.pkg), eq(pluginStore.userId, s.userId), workspaceIs(pluginStore.workspaceId, s.workspaceId));

/** Add `bytes` and `entries` (either may be negative) to the running total of `s`. */
async function addUsage(tx: Exec, s: StoreScope, bytes: number, entries: number): Promise<void> {
  if (bytes === 0 && entries === 0) return;
  await tx.insert(pluginStoreUsage)
    .values({ packageName: s.pkg, userId: s.userId, workspaceId: s.workspaceId, bytes: Math.max(0, bytes), entries: Math.max(0, entries) })
    .onConflictDoUpdate({
      target: [pluginStoreUsage.packageName, pluginStoreUsage.userId, pluginStoreUsage.workspaceId],
      set: {
        bytes: sql`greatest(0, ${pluginStoreUsage.bytes} + ${bytes})`,
        entries: sql`greatest(0, ${pluginStoreUsage.entries} + ${entries})`,
      },
    });
}

/** Recompute the running totals of `pkg` from its entries (after a bulk delete). */
async function recountPackage(tx: Exec, pkg: string): Promise<void> {
  await tx.delete(pluginStoreUsage).where(eq(pluginStoreUsage.packageName, pkg));
  await tx.execute(sql`
    INSERT INTO plugin_store_usage (package_name, user_id, workspace_id, bytes, entries)
    SELECT package_name, user_id, workspace_id, coalesce(sum(size_bytes), 0), count(*)::int
    FROM plugin_store WHERE package_name = ${pkg}
    GROUP BY package_name, user_id, workspace_id`);
}

/** The rows of a raw `execute` (an array, or `{ rows }`, by driver). */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] } | null)?.rows) ?? [];
}

const lockUser = (tx: Tx, pkg: string, userId: string) => tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`plugin-store:${pkg}:${userId}`}))`);

export const pluginStoreRepository = {
  /** One entry of `s`, or null. */
  async get(s: StoreScope, key: string): Promise<StoreEntry | null> {
    const [row] = await getDb().select({
      value: pluginStore.value, version: pluginStore.version, protectionLevel: pluginStore.protectionLevel,
      size: pluginStore.sizeBytes, updatedAt: pluginStore.updatedAt,
    }).from(pluginStore).where(and(scoped(s), eq(pluginStore.key, key))).limit(1);
    return row ?? null;
  },

  /**
   * The keys of `s` (sorted) at or below `maxProtection`, starting with
   * `prefix`, at most `limit`. No values. An entry above `maxProtection` is
   * not counted, not even towards `limit`.
   */
  async list(s: StoreScope, opts: { prefix?: string; limit: number; maxProtection: number }): Promise<StoreKeyRow[]> {
    const where = and(scoped(s), lte(pluginStore.protectionLevel, opts.maxProtection),
      opts.prefix ? like(pluginStore.key, `${escapeLike(opts.prefix)}%`) : undefined);
    return getDb().select({
      key: pluginStore.key, size: pluginStore.sizeBytes, version: pluginStore.version,
      protectionLevel: pluginStore.protectionLevel, updatedAt: pluginStore.updatedAt,
    }).from(pluginStore).where(where).orderBy(asc(pluginStore.key)).limit(opts.limit);
  },

  /**
   * Write one entry of `s`: insert it at version 1 or replace it at the next
   * version, at `protectionLevel` or the entry's own level if higher. An
   * entry above `maxProtection` is refused as `hidden`. With `ifVersion`
   * only if the entry is at that version now (0: only if it does not exist).
   * Refused when it would take the user's entries of `pkg` (every workspace)
   * over `quotaBytes` or beyond `PLUGIN_STORE_MAX_ENTRIES`; a write that does
   * not grow the entry is always allowed (a quota lowered by an upgrade
   * leaves room to shrink). The size counted is the overhead, the key and
   * the value as the database serialises it.
   */
  async put(s: StoreScope, key: string, json: string, opts: { protectionLevel: number; maxProtection: number; quotaBytes: number; ifVersion?: number }): Promise<StorePutResult> {
    const callLevel = Math.min(4, Math.max(1, Math.ceil(opts.protectionLevel)));
    return getDb().transaction(async (tx) => {
      await lockUser(tx, s.pkg, s.userId);
      const [current] = await tx.select({ version: pluginStore.version, size: pluginStore.sizeBytes, level: pluginStore.protectionLevel })
        .from(pluginStore).where(and(scoped(s), eq(pluginStore.key, key))).limit(1);
      if (current && current.level > opts.maxProtection) return { ok: false as const, code: 'hidden' as const };
      const previousLevel = current?.level ?? null;
      if (opts.ifVersion !== undefined && (current?.version ?? 0) !== opts.ifVersion) {
        return { ok: false as const, code: 'version_conflict' as const, current: current?.version ?? 0, previousLevel };
      }
      // The value as the database keeps it: `1e400` is a 401-digit number there.
      const measured = await tx.execute(sql`SELECT octet_length((${json}::jsonb)::text)::int AS serialised`);
      const serialised = Number(rowsOf<{ serialised: number }>(measured)[0]?.serialised ?? 0);
      if (serialised > PLUGIN_STORE_MAX_VALUE_BYTES) return { ok: false as const, code: 'too_large' as const, previousLevel };
      const size = PLUGIN_STORE_ENTRY_OVERHEAD_BYTES + Buffer.byteLength(key, 'utf8') + serialised;
      const [totals] = await tx.select({
        bytes: sql<number>`coalesce(sum(${pluginStoreUsage.bytes}), 0)::bigint`,
        entries: sql<number>`coalesce(sum(${pluginStoreUsage.entries}), 0)::int`,
      }).from(pluginStoreUsage).where(and(eq(pluginStoreUsage.packageName, s.pkg), eq(pluginStoreUsage.userId, s.userId)));
      if (!current && Number(totals?.entries ?? 0) >= PLUGIN_STORE_MAX_ENTRIES) {
        return { ok: false as const, code: 'too_many_entries' as const, max: PLUGIN_STORE_MAX_ENTRIES, previousLevel };
      }
      const after = Number(totals?.bytes ?? 0) - (current?.size ?? 0) + size;
      if (after > opts.quotaBytes && size > (current?.size ?? 0)) {
        return { ok: false as const, code: 'quota' as const, quota: opts.quotaBytes, previousLevel };
      }
      const value = sql`${json}::jsonb`;
      // An overwrite never lowers the entry's level: what it held may still be in it.
      const level = Math.max(callLevel, previousLevel ?? 1);
      if (current) {
        const [row] = await tx.update(pluginStore)
          .set({ value, sizeBytes: size, protectionLevel: level, version: sql`${pluginStore.version} + 1`, updatedAt: new Date() })
          .where(and(scoped(s), eq(pluginStore.key, key)))
          .returning({ version: pluginStore.version });
        await addUsage(tx, s, size - current.size, 0);
        return { ok: true as const, version: row.version, size, previousLevel };
      }
      const [row] = await tx.insert(pluginStore)
        .values({ packageName: s.pkg, userId: s.userId, workspaceId: s.workspaceId, key, value, sizeBytes: size, protectionLevel: level, version: 1 })
        .returning({ version: pluginStore.version });
      await addUsage(tx, s, size, 1);
      return { ok: true as const, version: row.version, size, previousLevel };
    });
  },

  /** Delete one entry of `s` at or below `maxProtection`; with the level it had. */
  async delete(s: StoreScope, key: string, maxProtection: number): Promise<StoreDeleteResult> {
    return getDb().transaction(async (tx) => {
      await lockUser(tx, s.pkg, s.userId);
      const rows = await tx.delete(pluginStore)
        .where(and(scoped(s), eq(pluginStore.key, key), lte(pluginStore.protectionLevel, maxProtection)))
        .returning({ size: pluginStore.sizeBytes, level: pluginStore.protectionLevel });
      if (rows.length === 0) return { deleted: false as const };
      await addUsage(tx, s, -rows[0].size, -1);
      return { deleted: true as const, previousLevel: rows[0].level };
    });
  },

  /**
   * Delete the entries of `userId` for `pkg` ("Delete my data"): of one
   * workspace (null: the personal one), or of every workspace when
   * `workspaceId` is undefined. How many and how large.
   */
  async deleteUser(pkg: string, userId: string, workspaceId?: string | null): Promise<{ entries: number; bytes: number }> {
    return getDb().transaction(async (tx) => {
      await lockUser(tx, pkg, userId);
      const ws = workspaceId === undefined ? undefined : workspaceIs(pluginStore.workspaceId, workspaceId);
      const rows = await tx.delete(pluginStore).where(and(eq(pluginStore.packageName, pkg), eq(pluginStore.userId, userId), ws))
        .returning({ size: pluginStore.sizeBytes });
      const wsUsage = workspaceId === undefined ? undefined : workspaceIs(pluginStoreUsage.workspaceId, workspaceId);
      await tx.delete(pluginStoreUsage).where(and(eq(pluginStoreUsage.packageName, pkg), eq(pluginStoreUsage.userId, userId), wsUsage));
      return { entries: rows.length, bytes: rows.reduce((n, r) => n + r.size, 0) };
    });
  },

  /** Delete every entry `userId` keeps in shared workspace `workspaceId`, of any package (they left the space). How many. */
  async deleteUserInWorkspace(userId: string, workspaceId: string, db: Exec = getDb()): Promise<number> {
    const rows = await db.delete(pluginStore).where(and(eq(pluginStore.userId, userId), eq(pluginStore.workspaceId, workspaceId)))
      .returning({ key: pluginStore.key });
    await db.delete(pluginStoreUsage).where(and(eq(pluginStoreUsage.userId, userId), eq(pluginStoreUsage.workspaceId, workspaceId)));
    return rows.length;
  },

  /** Delete every user's entries of `pkg` (uninstall, a store dropped or handed to another publisher); how many, of how many users, how large. */
  async deletePackage(pkg: string, db: Exec = getDb()): Promise<{ entries: number; users: number; bytes: number }> {
    const rows = await db.delete(pluginStore).where(eq(pluginStore.packageName, pkg)).returning({ userId: pluginStore.userId, size: pluginStore.sizeBytes });
    await db.delete(pluginStoreUsage).where(eq(pluginStoreUsage.packageName, pkg));
    return { entries: rows.length, users: new Set(rows.map((r) => r.userId)).size, bytes: rows.reduce((n, r) => n + r.size, 0) };
  },

  /** Delete every user's entries of `pkg` above `level` (its `maxProtection` dropped); how many, of how many users. */
  async deleteAbove(pkg: string, level: number, db: Exec = getDb()): Promise<{ entries: number; users: number }> {
    const rows = await db.delete(pluginStore).where(and(eq(pluginStore.packageName, pkg), gt(pluginStore.protectionLevel, level)))
      .returning({ userId: pluginStore.userId });
    if (rows.length > 0) await recountPackage(db, pkg);
    return { entries: rows.length, users: new Set(rows.map((r) => r.userId)).size };
  },

  /** Bytes and entries of `pkg`: of every user, by user (admins), or of `userId` only (every workspace). Sizes and counts, never keys or values. */
  async usage(pkg: string, userId?: string, db: Exec = getDb()): Promise<StoreUsageTotals> {
    const rows = await db.select({
      userId: pluginStoreUsage.userId,
      bytes: sql<number>`coalesce(sum(${pluginStoreUsage.bytes}), 0)::bigint`,
      entries: sql<number>`coalesce(sum(${pluginStoreUsage.entries}), 0)::int`,
    }).from(pluginStoreUsage)
      .where(and(eq(pluginStoreUsage.packageName, pkg), userId ? eq(pluginStoreUsage.userId, userId) : undefined, gt(pluginStoreUsage.entries, 0)))
      .groupBy(pluginStoreUsage.userId);
    const byUser = rows.map((r) => ({ userId: r.userId, bytes: Number(r.bytes), entries: Number(r.entries) }))
      .sort((a, b) => b.bytes - a.bytes || a.userId.localeCompare(b.userId));
    return { bytes: byUser.reduce((n, r) => n + r.bytes, 0), entries: byUser.reduce((n, r) => n + r.entries, 0), byUser };
  },

  /** What `userId` keeps in each package's store (every workspace): package name → bytes and entries. */
  async usageOfUser(userId: string): Promise<Map<string, { bytes: number; entries: number }>> {
    const rows = await getDb().select({
      pkg: pluginStoreUsage.packageName,
      bytes: sql<number>`coalesce(sum(${pluginStoreUsage.bytes}), 0)::bigint`,
      entries: sql<number>`coalesce(sum(${pluginStoreUsage.entries}), 0)::int`,
    }).from(pluginStoreUsage).where(and(eq(pluginStoreUsage.userId, userId), gt(pluginStoreUsage.entries, 0))).groupBy(pluginStoreUsage.packageName);
    return new Map(rows.map((r) => [r.pkg, { bytes: Number(r.bytes), entries: Number(r.entries) }]));
  },
};
