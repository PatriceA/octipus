import { and, eq, sql } from 'drizzle-orm';
import { assertDeletable } from '@/security/user-deletion';
import { dbLogger } from '@/utils/logger';
import { getDb } from '../postgres';
import { type ChannelBinding, type NewUser, type User, users } from '../schema/users';
import { sessionsRemoved } from './session-lifecycle';

export class UserRepository {
  private get db() { return getDb(); }

  async findById(id: string): Promise<User | null> {
    const result = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return result[0] ?? null;
  }

  /**
   * The three columns every authenticated request re-reads (session and API
   * token validation): a session's own copy is a snapshot from login time.
   */
  async findAuthState(id: string): Promise<{ username: string; isAdmin: boolean; isActive: boolean; kind: User['kind'] } | null> {
    const result = await this.db
      .select({ username: users.username, isAdmin: users.isAdmin, isActive: users.isActive, kind: users.kind })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    return result[0] ?? null;
  }

  async findByUsername(username: string): Promise<User | null> {
    const result = await this.db.select().from(users).where(eq(users.username, username)).limit(1);
    return result[0] ?? null;
  }

  async findByEmail(email: string): Promise<User | null> {
    const result = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
    return result[0] ?? null;
  }

  async findByChannelBinding(channelType: string, channelUserId: string): Promise<User | null> {
    const result = await this.db.select().from(users);

    // Filter in application code since channelBindings is JSONB
    for (const user of result) {
      let bindings = user.channelBindings as ChannelBinding[] | string;
      // Handle double-encoded JSON strings from JSONB
      if (typeof bindings === 'string') {
        try { bindings = JSON.parse(bindings); } catch { continue; }
      }
      if (Array.isArray(bindings) && bindings.some((b) => b.channelType === channelType && b.channelUserId === channelUserId)) {
        return user;
      }
    }

    return null;
  }

  async create(data: NewUser): Promise<User> {
    const result = await this.db.insert(users).values(data).returning();
    dbLogger.info({ userId: result[0].id }, 'User created');
    return result[0];
  }

  async update(id: string, data: Partial<NewUser>): Promise<User | null> {
    const result = await this.db
      .update(users)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();

    if (result[0]) {
      dbLogger.info({ userId: id }, 'User updated');
    }

    return result[0] ?? null;
  }

  /** Set this personal policy without overwriting unrelated preference edits. */
  async setAutomaticRecovery(id: string, enabled: boolean): Promise<User | null> {
    const [user] = await this.db.update(users).set({
      preferences: sql`jsonb_set(COALESCE(${users.preferences}, '{}'::jsonb), '{autoApproveRecovery}', ${JSON.stringify(enabled)}::jsonb)`,
      updatedAt: new Date(),
    }).where(eq(users.id, id)).returning();
    return user ?? null;
  }

  /** Turn the post-task distil offer on or off for this user (`preferences.distillNudge`). */
  /** Set the user's zone and who set it (core/tasks/timezone.ts decides when). */
  async setTimezone(id: string, timezone: string, source: 'device' | 'user'): Promise<User | null> {
    const [user] = await this.db.update(users).set({
      preferences: sql`COALESCE(${users.preferences}, '{}'::jsonb) || ${JSON.stringify({ timezone, timezoneSource: source })}::jsonb`,
      updatedAt: new Date(),
    }).where(eq(users.id, id)).returning();
    return user ?? null;
  }

  /**
   * A zone a device reported, written only under the rules of
   * `rememberDeviceTimezone`, checked in the same UPDATE (a zone the user sets
   * in Settings meanwhile is never overwritten): not over a zone the user
   * chose, not the same zone again, and a fixed offset (`fixed`) never over a
   * named zone. Whether it wrote.
   */
  async setDeviceTimezone(id: string, timezone: string, fixed: boolean): Promise<boolean> {
    const stored = sql`(${users.preferences}->>'timezone')`;
    const rows = await this.db.update(users).set({
      preferences: sql`COALESCE(${users.preferences}, '{}'::jsonb) || ${JSON.stringify({ timezone, timezoneSource: 'device' })}::jsonb`,
      updatedAt: new Date(),
    }).where(and(
      eq(users.id, id),
      sql`(${stored} IS NULL OR ${users.preferences}->>'timezoneSource' IS DISTINCT FROM 'user')`,
      sql`${stored} IS DISTINCT FROM ${timezone}`,
      fixed ? sql`(${stored} IS NULL OR ${stored} ~* '^(etc/.*|utc|gmt|z|zulu|universal|uct|greenwich)$')` : sql`TRUE`,
    )).returning({ id: users.id });
    return rows.length > 0;
  }

  async setDistillNudge(id: string, enabled: boolean): Promise<User | null> {
    const [user] = await this.db.update(users).set({
      preferences: sql`jsonb_set(COALESCE(${users.preferences}, '{}'::jsonb), '{distillNudge}', ${JSON.stringify(enabled)}::jsonb)`,
      updatedAt: new Date(),
    }).where(eq(users.id, id)).returning();
    return user ?? null;
  }

  /**
   * Every user deletion goes through `assertDeletable`; see security/user-deletion.ts.
   * The user's sessions are reported to `sessionsRemoved` once the user is
   * gone, so the gateway drops their replay buffers. (Today a user who still
   * has sessions cannot be deleted: `sessions.user_id` does not cascade.)
   */
  async delete(id: string): Promise<boolean> {
    await assertDeletable(id);
    // Leave every space first, each with its audit row and membership
    // follow-up (I5, I10), rather than letting the cascade drop the rows.
    const { leaveAllSpaces } = await import('@/core/spaces/service');
    await leaveAllSpaces(id);
    const { sessionRepository } = await import('./session-repository');
    const owned = await sessionRepository.idsByUser(id);
    const result = await this.db.delete(users).where(eq(users.id, id)).returning();
    if (result.length > 0) {
      dbLogger.info({ userId: id }, 'User deleted');
      sessionsRemoved(owned);
      return true;
    }
    return false;
  }

  /** The legacy `users.channelBindings` column as an array (it may be stored as a JSON string). */
  parseBindings(raw: unknown): ChannelBinding[] {
    let v = raw;
    if (typeof v === 'string') {
      try { v = JSON.parse(v); } catch { return []; }
    }
    return Array.isArray(v) ? (v as ChannelBinding[]) : [];
  }

  async addChannelBinding(userId: string, binding: ChannelBinding): Promise<User | null> {
    const user = await this.findById(userId);
    if (!user) return null;

    const bindings = [...this.parseBindings(user.channelBindings), binding];
    return this.update(userId, { channelBindings: bindings });
  }

  async removeChannelBinding(userId: string, channelType: string, channelUserId: string): Promise<User | null> {
    const user = await this.findById(userId);
    if (!user) return null;

    const bindings = this.parseBindings(user.channelBindings).filter(
      (b) => !(b.channelType === channelType && b.channelUserId === channelUserId)
    );
    return this.update(userId, { channelBindings: bindings });
  }

  async updateLastLogin(id: string): Promise<void> {
    await this.db
      .update(users)
      .set({ lastLoginAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, id));
  }

  async listAll(): Promise<User[]> {
    return this.db.select().from(users);
  }

  /** The install's own accounts: every user but remote members (S7), for admin lists and SCIM. */
  async listLocal(): Promise<User[]> {
    return this.db.select().from(users).where(eq(users.kind, 'local'));
  }

  async listActive(): Promise<User[]> {
    return this.db.select().from(users).where(eq(users.isActive, true));
  }

  async listAdmins(): Promise<User[]> {
    return this.db.select().from(users).where(and(eq(users.isAdmin, true), eq(users.isActive, true)));
  }
}

export const userRepository = new UserRepository();
