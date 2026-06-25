import { asc, eq, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import {
  type NewSwarmLedgerRecord,
  type SwarmLedgerRecord,
  swarmLedger,
} from '@/db/schema/swarm-ledger';

/**
 * Thin Drizzle repository for the append-only `swarm_ledger`. Keeps raw SQL
 * out of the `SwarmLedger` orchestration logic. Rows are only ever inserted
 * or read — never updated/deleted.
 */
export class SwarmLedgerRepository {
  private get db() {
    return getDb();
  }

  /** Append one event. Returns the assigned `seq`. */
  async append(record: NewSwarmLedgerRecord): Promise<number> {
    const [row] = await this.db
      .insert(swarmLedger)
      .values(record)
      .returning({ seq: swarmLedger.seq });
    return row.seq;
  }

  /** All events for a root, in append (seq) order — the replay input. */
  async findByRoot(rootSessionId: string): Promise<SwarmLedgerRecord[]> {
    return this.db
      .select()
      .from(swarmLedger)
      .where(eq(swarmLedger.rootSessionId, rootSessionId))
      .orderBy(asc(swarmLedger.seq));
  }

  /**
   * Roots that have at least one node which was spawned but never reached a
   * terminal event (`result` / `cancel` / `reconcile`) — i.e. swarms left
   * in-flight by a crash. Used by the boot-time resume to know which roots to
   * reconcile, without scanning every root ever recorded.
   */
  async findRootsWithIncomplete(): Promise<string[]> {
    const rows = await this.db.execute(sql`
      SELECT DISTINCT s.root_session_id AS root
      FROM ${swarmLedger} s
      WHERE s.event = 'spawn'
        AND NOT EXISTS (
          SELECT 1 FROM ${swarmLedger} t
          WHERE t.node_id = s.node_id
            AND t.root_session_id = s.root_session_id
            AND t.event IN ('result', 'cancel', 'reconcile')
        )
    `);
    // Normalize the driver-shaped result: postgres-js returns an array-like
    // RowList, PGlite (embedded mode) returns `{ rows }`. Both are handled so
    // boot reconcile works in either deployment.
    const list = (Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows) ?? [];
    return (list as Array<{ root: string }>).map((r) => r.root).filter(Boolean);
  }
}

export const swarmLedgerRepository = new SwarmLedgerRepository();
