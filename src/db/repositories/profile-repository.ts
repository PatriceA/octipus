import { and, desc, eq, ilike, sql } from 'drizzle-orm';
import { getDb } from '../postgres';
import { type NewProfile, type Profile, type ProfileFact, profiles } from '../schema/profiles';

export class ProfileRepository {
  private get db() { return getDb(); }

  async findByUserId(userId: string): Promise<Profile[]> {
    return this.db
      .select()
      .from(profiles)
      .where(eq(profiles.userId, userId))
      .orderBy(desc(profiles.updatedAt));
  }

  /** A profile by id, only when `userId` owns it: ids are never enough to reach another user's profile. */
  async findById(userId: string, id: string): Promise<Profile | null> {
    const result = await this.db
      .select()
      .from(profiles)
      .where(this.owned(userId, id))
      .limit(1);
    return result[0] ?? null;
  }

  async findByName(userId: string, name: string): Promise<Profile[]> {
    return this.db
      .select()
      .from(profiles)
      .where(and(eq(profiles.userId, userId), ilike(profiles.name, `%${name}%`)));
  }

  async findUserProfile(userId: string): Promise<Profile | null> {
    const result = await this.db
      .select()
      .from(profiles)
      .where(and(eq(profiles.userId, userId), eq(profiles.isUserProfile, true)))
      .limit(1);
    return result[0] ?? null;
  }

  async create(data: NewProfile): Promise<Profile> {
    const result = await this.db.insert(profiles).values(data).returning();
    return result[0];
  }

  async update(userId: string, id: string, data: Partial<Omit<NewProfile, 'id' | 'userId'>>): Promise<Profile | null> {
    const result = await this.db
      .update(profiles)
      .set({ ...data, updatedAt: new Date() })
      .where(this.owned(userId, id))
      .returning();
    return result[0] ?? null;
  }

  async addFact(userId: string, id: string, fact: ProfileFact): Promise<Profile | null> {
    const profile = await this.findById(userId, id);
    if (!profile) return null;

    const existingFacts = (profile.facts as ProfileFact[]) || [];
    // Replace if same key exists, otherwise append
    const filtered = existingFacts.filter(f => f.key !== fact.key);
    const updatedFacts = [...filtered, { ...fact, learnedAt: fact.learnedAt || new Date().toISOString() }];

    const result = await this.db
      .update(profiles)
      .set({ facts: updatedFacts, updatedAt: new Date() })
      .where(this.owned(userId, id))
      .returning();
    return result[0] ?? null;
  }

  async removeFact(userId: string, id: string, key: string): Promise<Profile | null> {
    const profile = await this.findById(userId, id);
    if (!profile) return null;

    const existingFacts = (profile.facts as ProfileFact[]) || [];
    const updatedFacts = existingFacts.filter(f => f.key !== key);

    const result = await this.db
      .update(profiles)
      .set({ facts: updatedFacts, updatedAt: new Date() })
      .where(this.owned(userId, id))
      .returning();
    return result[0] ?? null;
  }

  async delete(userId: string, id: string): Promise<boolean> {
    const result = await this.db.delete(profiles).where(this.owned(userId, id)).returning();
    return result.length > 0;
  }

  private owned(userId: string, id: string) {
    return and(eq(profiles.userId, userId), eq(profiles.id, id));
  }

  async search(userId: string, query: string): Promise<Profile[]> {
    // Search across name, relationship, category, and fact values
    return this.db
      .select()
      .from(profiles)
      .where(
        and(
          eq(profiles.userId, userId),
          sql`(${profiles.name} ILIKE ${'%' + query + '%'} OR ${profiles.relationship} ILIKE ${'%' + query + '%'} OR ${profiles.category} ILIKE ${'%' + query + '%'} OR ${profiles.facts}::text ILIKE ${'%' + query + '%'})`,
        ),
      )
      .orderBy(desc(profiles.updatedAt));
  }
}

export const profileRepository = new ProfileRepository();
