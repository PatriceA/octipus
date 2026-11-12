/**
 * Store requests audited in aggregate (docs/PLUGIN-PACKAGES.md#store): a tool
 * or a page may read and write its store many times a minute, so its
 * answered requests are counted per kind (package, user, op, status, code)
 * and written as one row per kind and minute, carrying the requests counted
 * since the previous row: the pattern of the host API's refusals
 * (src/api/routes/plugin-host.ts). Never a key or a value in the row.
 *
 * No count is lost: the first request of a kind writes its row at once, the
 * ones after it within the window are counted and written by a timer once
 * the window ends (unref'd, so it never keeps the process alive), and at
 * shutdown (`flushStoreAudits`, src/index.ts). When too many kinds are held,
 * they are written before the map is cleared.
 */

/** One row per kind per this window. */
export const STORE_AUDIT_WINDOW_MS = 60_000;
const MAX_KINDS = 5000;

export interface StoreAuditAggregator {
  /** Count one request of `kind`; `write(count)` is called when a row is due, with the requests it stands for. */
  count(kind: string, write: (count: number) => Promise<void>, now?: number): Promise<void>;
  /** Write a row for every kind with requests counted since its last row; `onlyDue`: only those whose window ended. */
  flush(opts?: { now?: number; onlyDue?: boolean }): Promise<void>;
  /** Test-only: forget every count. */
  reset(): void;
}

interface Pending {
  /** Requests counted since the last row. */
  count: number;
  /** When the last row was written. */
  since: number;
  write: (count: number) => Promise<void>;
}

const aggregators = new Set<StoreAuditAggregator>();
let timer: ReturnType<typeof setInterval> | null = null;

function ensureTimer(windowMs: number): void {
  if (timer) return;
  timer = setInterval(() => {
    for (const a of aggregators) void a.flush({ onlyDue: true });
  }, windowMs);
  timer.unref?.();
}

/** Write every aggregator's pending counts (at shutdown). */
export async function flushStoreAudits(): Promise<void> {
  await Promise.all([...aggregators].map((a) => a.flush()));
}

export function storeAuditAggregator(windowMs = STORE_AUDIT_WINDOW_MS): StoreAuditAggregator {
  const kinds = new Map<string, Pending>();
  const writeOut = async (entry: Pending, now: number) => {
    const count = entry.count;
    if (count === 0) return;
    entry.count = 0;
    entry.since = now;
    await entry.write(count);
  };
  const aggregator: StoreAuditAggregator = {
    async count(kind, write, now = Date.now()) {
      const entry = kinds.get(kind);
      if (entry && now - entry.since < windowMs) {
        entry.count += 1;
        entry.write = write;
        ensureTimer(windowMs);
        return;
      }
      // A new window: one row for this request and those counted since the last row, then count afresh.
      const count = 1 + (entry?.count ?? 0);
      if (!entry && kinds.size >= MAX_KINDS) {
        // Written, never dropped, before the map is cleared.
        await aggregator.flush({ now });
        kinds.clear();
      }
      kinds.set(kind, { count: 0, since: now, write });
      await write(count);
    },
    async flush(opts = {}) {
      const now = opts.now ?? Date.now();
      const due = [...kinds.values()].filter((e) => e.count > 0 && (!opts.onlyDue || now - e.since >= windowMs));
      for (const entry of due) {
        try {
          await writeOut(entry, now);
        } catch {
          // The writer logs its own failure; the next row starts afresh.
        }
      }
    },
    reset() {
      kinds.clear();
    },
  };
  aggregators.add(aggregator);
  return aggregator;
}
