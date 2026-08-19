import { and, asc, eq, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { type NewRunEventRecord, runEvents } from '@/db/schema/run-events';

/** The four event kinds a swarm node goes through. A subset of `run_event_type`. */
export type SwarmLedgerEventType = 'spawn' | 'result' | 'cancel' | 'reconcile';

/** One swarm-node event in the swarm's own vocabulary. */
export interface SwarmLedgerRow {
  seq: number;
  nodeId: string;
  parentNodeId: string | null;
  event: SwarmLedgerEventType;
  payload: unknown;
  createdAt: Date;
}

/**
 * Thin Drizzle repository for the append-only `run_events`. Keeps raw SQL out
 * of the `SwarmLedger` orchestration logic. Rows are only ever inserted or
 * read — never updated/deleted.
 *
 * Every read here filters `subject = 'swarm_node'`: the table now carries
 * pipeline and tool events too, and swarm replay must fold ONLY swarm node
 * transitions. Without the filter a pipeline event would be replayed as a node
 * with no spawn and reconciled into existence.
 */
export class SwarmLedgerRepository {
  private get db() {
    return getDb();
  }

  /**
   * Append one swarm-node event. Returns the assigned `seq`.
   *
   * The swarm's vocabulary (root session, node, parent node) is kept at this
   * boundary and translated to the log's generic columns here, so generalizing
   * the table did not force a rename through the replay/reconcile logic that
   * reads it.
   */
  async append(record: {
    rootSessionId: string;
    nodeId: string;
    parentNodeId?: string | null;
    event: SwarmLedgerEventType;
    payload?: unknown;
  }): Promise<number> {
    const [row] = await this.db
      .insert(runEvents)
      .values({
        runId: record.rootSessionId,
        subject: 'swarm_node',
        subjectId: record.nodeId,
        parentSubjectId: record.parentNodeId ?? null,
        event: record.event,
        payload: (record.payload ?? null) as NewRunEventRecord['payload'],
      })
      .returning({ seq: runEvents.seq });
    return row.seq;
  }

  /** A run's swarm-node events, in append (seq) order — the replay input. */
  async findByRoot(rootSessionId: string): Promise<SwarmLedgerRow[]> {
    const rows = await this.db
      .select()
      .from(runEvents)
      .where(and(eq(runEvents.runId, rootSessionId), eq(runEvents.subject, 'swarm_node')))
      .orderBy(asc(runEvents.seq));
    return rows.map((r) => ({
      seq: r.seq,
      nodeId: r.subjectId,
      parentNodeId: r.parentSubjectId,
      event: r.event as SwarmLedgerEventType,
      payload: r.payload,
      createdAt: r.createdAt,
    }));
  }

  /**
   * Roots that have at least one node which was spawned but never reached a
   * terminal event (`result` / `cancel` / `reconcile`) — i.e. swarms left
   * in-flight by a crash. Used by the boot-time resume to know which roots to
   * reconcile, without scanning every root ever recorded.
   */
  async findRootsWithIncomplete(): Promise<string[]> {
    const rows = await this.db.execute(sql`
      SELECT DISTINCT s.run_id AS root
      FROM ${runEvents} s
      WHERE s.event = 'spawn'
        AND s.subject = 'swarm_node'
        AND NOT EXISTS (
          SELECT 1 FROM ${runEvents} t
          WHERE t.subject_id = s.subject_id
            AND t.run_id = s.run_id
            AND t.subject = 'swarm_node'
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
