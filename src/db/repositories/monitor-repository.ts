import { and, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { monitors, type Monitor } from '@/db/schema/monitors';
import type { MonitorStatus, Observation } from '@/core/monitors/types';

export class MonitorRepository {
  constructor(private db = getDb) {}
  async create(row: typeof monitors.$inferInsert): Promise<Monitor> {
    return (await this.db().insert(monitors).values(row).returning())[0];
  }
  async list(userId: string, sessionId: string) {
    return this.db().select().from(monitors).where(and(eq(monitors.userId, userId), eq(monitors.sessionId, sessionId))).orderBy(monitors.createdAt);
  }
  async get(id: string) { return (await this.db().select().from(monitors).where(eq(monitors.id, id)))[0]; }
  async due(now: Date) {
    return this.db().select().from(monitors).where(and(eq(monitors.status, 'armed'), lte(monitors.nextCheckAt, now), or(isNull(monitors.leaseUntil), lte(monitors.leaseUntil, now)))).orderBy(monitors.nextCheckAt).limit(50);
  }
  async pending() { return this.db().select().from(monitors).where(eq(monitors.status, 'ready')).orderBy(monitors.createdAt).limit(50); }
  async eventSources() {
    return this.db().select({ source: monitors.source }).from(monitors).where(eq(monitors.status, 'armed'));
  }
  async eventBaseline(row: Monitor, value: unknown) {
    await this.db().update(monitors).set({ previous: { value }, updatedAt: new Date() })
      .where(and(eq(monitors.id, row.id), eq(monitors.status, 'armed'), eq(monitors.updatedAt, row.updatedAt)));
  }
  async eventCandidates(userId: string) {
    return this.db().select().from(monitors).where(and(eq(monitors.userId, userId), eq(monitors.status, 'armed')));
  }
  async claimCheck(id: string, token: string, now: Date) {
    return (await this.db().update(monitors).set({ leaseToken: token, leaseUntil: new Date(now.getTime() + 60_000) })
      .where(and(eq(monitors.id, id), eq(monitors.status, 'armed'), lte(monitors.nextCheckAt, now), or(isNull(monitors.leaseUntil), lte(monitors.leaseUntil, now)))).returning())[0];
  }
  async checked(row: Monitor, token: string, patch: Partial<Monitor>) {
    return this.db().update(monitors).set({ ...patch, leaseToken: null, leaseUntil: null, updatedAt: new Date() })
      .where(and(eq(monitors.id, row.id), eq(monitors.status, 'armed'), eq(monitors.leaseToken, token))).returning();
  }
  async ready(id: string, observation: Observation) {
    return this.db().update(monitors).set({ status: 'ready', observation, lastError: null, leaseToken: null, leaseUntil: null, updatedAt: new Date() })
      .where(and(eq(monitors.id, id), eq(monitors.status, 'armed'))).returning();
  }
  async transition(id: string, from: MonitorStatus[], status: MonitorStatus, patch: Partial<Monitor> = {}) {
    return (await this.db().update(monitors).set({ ...patch, status, updatedAt: new Date() })
      .where(and(eq(monitors.id, id), inArray(monitors.status, from))).returning())[0];
  }
  async recover(now: Date) {
    // A crashed delivery may already have performed external actions. Never replay blindly.
    await this.db().update(monitors).set({ status: 'blocked', lastError: 'Continuation was interrupted. Review the session before creating another monitor.', leaseToken: null, leaseUntil: null, updatedAt: now })
      .where(and(eq(monitors.status, 'delivering'), lte(monitors.leaseUntil, now)));
  }
  async renew(id: string) {
    await this.db().update(monitors).set({ leaseUntil: new Date(Date.now() + 60_000) }).where(and(eq(monitors.id, id), eq(monitors.status, 'delivering')));
  }
  async retainedTab(tabId: number) {
    const rows = await this.db().select({ source: monitors.source }).from(monitors).where(inArray(monitors.status, ['armed', 'paused', 'ready', 'delivering', 'blocked']));
    return rows.some(r => r.source.kind === 'browser' && r.source.tabId === tabId);
  }
}
export const monitorRepository = new MonitorRepository();
