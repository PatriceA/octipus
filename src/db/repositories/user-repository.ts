import { and, eq } from 'drizzle-orm';
import { dbLogger } from '@/utils/logger';
import { getDb } from '../postgres';
import { type ChannelBinding, type NewUser, type User, users } from '../schema/users';

export class UserRepository {
  private get db() { return getDb(); }

  async findById(id: string): Promise<User | null> {
    const result = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
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

  async delete(id: string): Promise<boolean> {
    const result = await this.db.delete(users).where(eq(users.id, id)).returning();
    if (result.length > 0) {
      dbLogger.info({ userId: id }, 'User deleted');
      return true;
    }
    return false;
  }

  private parseBindings(raw: unknown): ChannelBinding[] {
    if (typeof raw === 'string') {
      try { return JSON.parse(raw); } catch { return []; }
    }
    return (raw as ChannelBinding[]) || [];
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
