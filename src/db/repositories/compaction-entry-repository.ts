import { desc, eq } from 'drizzle-orm';
import { getDb } from '../postgres';
import {
  type CompactionEntryRecord,
  compactionEntries,
  type NewCompactionEntryRecord,
} from '../schema/compaction-entries';

/**
 * Append-only access to per-session compaction history.
 * High-level orchestrator code uses this via session-compaction.ts;
 * never reach into `getDb()` directly from compaction logic.
 */
export class CompactionEntryRepository {
  private get db() { return getDb(); }

  async insert(entry: NewCompactionEntryRecord): Promise<CompactionEntryRecord> {
    const [row] = await this.db.insert(compactionEntries).values(entry).returning();
    return row;
  }

  /** Newest entry first. Used to seed iterative chaining + cumulative file ops. */
  async findLatest(sessionId: string): Promise<CompactionEntryRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(compactionEntries)
      .where(eq(compactionEntries.sessionId, sessionId))
      .orderBy(desc(compactionEntries.createdAt))
      .limit(1);
    return row;
  }

  /** Full history, newest first. Used by `/compact --history` style debugging. */
  async findBySession(sessionId: string, limit = 50): Promise<CompactionEntryRecord[]> {
    return this.db
      .select()
      .from(compactionEntries)
      .where(eq(compactionEntries.sessionId, sessionId))
      .orderBy(desc(compactionEntries.createdAt))
      .limit(limit);
  }

  async deleteBySession(sessionId: string): Promise<number> {
    const rows = await this.db
      .delete(compactionEntries)
      .where(eq(compactionEntries.sessionId, sessionId))
      .returning({ id: compactionEntries.id });
    return rows.length;
  }
}

export const compactionEntryRepository = new CompactionEntryRepository();
