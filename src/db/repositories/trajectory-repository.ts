import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { type NewTrajectoryRunRecord, type TrajectoryRunRecord, trajectoryRuns } from '@/db/schema/trajectory-runs';

export interface TrajectoryListFilter {
  userId?: string;
  outcome?: 'success' | 'failure' | 'partial' | 'cancelled';
  from?: Date;
  to?: Date;
  limit?: number;
}

export const trajectoryRepository = {
  async create(input: NewTrajectoryRunRecord): Promise<TrajectoryRunRecord> {
    const db = getDb();
    const [row] = await db.insert(trajectoryRuns).values(input).returning();
    return row!;
  },

  async list(filter: TrajectoryListFilter = {}): Promise<TrajectoryRunRecord[]> {
    const db = getDb();
    const conds = [];
    if (filter.userId) conds.push(eq(trajectoryRuns.userId, filter.userId));
    if (filter.outcome) conds.push(eq(trajectoryRuns.outcome, filter.outcome));
    if (filter.from) conds.push(gte(trajectoryRuns.startedAt, filter.from));
    if (filter.to) conds.push(lte(trajectoryRuns.startedAt, filter.to));
    const q = db.select().from(trajectoryRuns)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(trajectoryRuns.startedAt))
      .limit(filter.limit ?? 100);
    return q;
  },

  async findById(id: string): Promise<TrajectoryRunRecord | null> {
    const db = getDb();
    const [row] = await db.select().from(trajectoryRuns).where(eq(trajectoryRuns.id, id)).limit(1);
    return row ?? null;
  },
};
