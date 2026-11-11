/**
 * Store requests audited in aggregate (docs/PLUGIN-PACKAGES.md#store): a tool
 * or a page may read and write its store many times a minute, so its
 * answered requests are counted per kind (package, user, op, status, code)
 * and written as one row per kind and minute, carrying the requests counted
 * since the previous row: the pattern of the host API's refusals
 * (src/api/routes/plugin-host.ts). Never a key or a value in the row.
 */

/** One row per kind per this window. */
export const STORE_AUDIT_WINDOW_MS = 60_000;
const MAX_KINDS = 5000;

export interface StoreAuditAggregator {
  /** Count one request of `kind`; `write(count)` is called when a row is due, with the requests it stands for. */
  count(kind: string, write: (count: number) => Promise<void>, now?: number): Promise<void>;
  /** Test-only. */
  reset(): void;
}

export function storeAuditAggregator(windowMs = STORE_AUDIT_WINDOW_MS): StoreAuditAggregator {
  const kinds = new Map<string, { count: number; since: number }>();
  return {
    async count(kind, write, now = Date.now()) {
      const entry = kinds.get(kind);
      if (entry && now - entry.since < windowMs) {
        entry.count += 1;
        return;
      }
      // A new window: one row for this request and those counted since the last row, then count afresh.
      const count = 1 + (entry?.count ?? 0);
      kinds.set(kind, { count: 0, since: now });
      if (kinds.size > MAX_KINDS) kinds.clear();
      await write(count);
    },
    reset() {
      kinds.clear();
    },
  };
}
