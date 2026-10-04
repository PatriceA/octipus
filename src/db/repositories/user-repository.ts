import { and, eq } from 'drizzle-orm';
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
  async findAuthState(id: string): Promise<{ username: string; isAdmin: boolean; isActive: boolean } | null> {
    const result = await this.db
      .select({ username: users.username, isAdmin: users.isAdmin, isActive: users.isActive })
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

  async listActive(): Promise<User[]> {
    return this.db.select().from(users).where(eq(users.isActive, true));
  }

  async listAdmins(): Promise<User[]> {
    return this.db.select().from(users).where(and(eq(users.isAdmin, true), eq(users.isActive, true)));
  }
}

export const userRepository = new UserRepository();
