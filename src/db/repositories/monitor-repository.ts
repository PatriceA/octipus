import { and, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { monitors, type Monitor } from '@/db/schema/monitors';
import { users } from '@/db/schema/users';
import type { MonitorStatus, Observation } from '@/core/monitors/types';

/** How long "no monitor needs a tick" is trusted before it is read again. */
const IDLE_RECHECK_MS = 30_000;

export class MonitorRepository {
  /**
   * `hasWork` found nothing to do and the tick may skip until then. A write
   * through this repository that can make a monitor armed or ready resets
   * it, so a monitor created here is checked on the very next tick; one
   * created on another instance (which ticks it itself) is seen here within
   * IDLE_RECHECK_MS.
   */
  private idleUntil = 0;
  /** Bumped by those writes: an idle verdict read across one is not kept. */
  private writes = 0;

  constructor(private db = getDb) {}

  private touched(): void {
    this.writes++;
    this.idleUntil = 0;
  }

  /**
   * Is any monitor armed (a check may be due) or ready (a wake-up to deliver)?
   * One indexed probe instead of the tick's three queries, and none at all
   * while a recent probe found nothing.
   */
  async hasWork(now: Date): Promise<boolean> {
    if (now.getTime() < this.idleUntil) return false;
    const writes = this.writes;
    const [row] = await this.db().select({ id: monitors.id }).from(monitors)
      .where(inArray(monitors.status, ['armed', 'ready'])).limit(1);
    if (row) return true;
    if (writes === this.writes) this.idleUntil = now.getTime() + IDLE_RECHECK_MS;
    return false;
  }

  async create(row: typeof monitors.$inferInsert): Promise<Monitor> {
    const created = (await this.db().insert(monitors).values(row).returning())[0];
    this.touched();
    return created;
  }
  async list(userId: string, sessionId: string) {
    return this.db().select().from(monitors).where(and(eq(monitors.userId, userId), eq(monitors.sessionId, sessionId))).orderBy(monitors.createdAt);
  }
  async get(id: string) { return (await this.db().select().from(monitors).where(eq(monitors.id, id)))[0]; }
  /** Owners whose monitors may run: a deactivated user's are skipped at fire time. */
  private activeOwners() { return inArray(monitors.userId, this.db().select({ id: users.id }).from(users).where(eq(users.isActive, true))); }
  async due(now: Date) {
    return this.db().select().from(monitors).where(and(eq(monitors.status, 'armed'), lte(monitors.nextCheckAt, now), or(isNull(monitors.leaseUntil), lte(monitors.leaseUntil, now)), this.activeOwners())).orderBy(monitors.nextCheckAt).limit(50);
  }
  async pending() { return this.db().select().from(monitors).where(and(eq(monitors.status, 'ready'), this.activeOwners())).orderBy(monitors.createdAt).limit(50); }
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
    const rows = await this.db().update(monitors).set({ status: 'ready', observation, lastError: null, leaseToken: null, leaseUntil: null, updatedAt: new Date() })
      .where(and(eq(monitors.id, id), eq(monitors.status, 'armed'))).returning();
    this.touched();
    return rows;
  }
  async transition(id: string, from: MonitorStatus[], status: MonitorStatus, patch: Partial<Monitor> = {}) {
    const row = (await this.db().update(monitors).set({ ...patch, status, updatedAt: new Date() })
      .where(and(eq(monitors.id, id), inArray(monitors.status, from))).returning())[0];
    if (status === 'armed' || status === 'ready') this.touched();
    return row;
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
