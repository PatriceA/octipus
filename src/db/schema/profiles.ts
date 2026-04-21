import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export interface ProfileFact {
  key: string;       // "location", "birthday", "likes", "email", "phone"
  value: string;     // "Berlin", "March 15", "chocolate", etc.
  source?: string;   // "user told us", "learned from conversation"
  learnedAt?: string; // ISO date when this fact was learned
}

export const profiles = pgTable('profiles', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),                    // "Mom", "Patrice", "Dr. Mueller"
  relationship: text('relationship'),              // "self", "mother", "colleague", "boss", "friend"
  category: text('category').notNull().default('person'),  // "person", "organization", "pet"
  facts: jsonb('facts').$type<ProfileFact[]>().default([]),
  userId: uuid('user_id').notNull(),               // owner of this profile
  isUserProfile: boolean('is_user_profile').default(false), // true for the user's own profile
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  userIdx: index('profiles_user_id_idx').on(table.userId),
  nameIdx: index('profiles_name_idx').on(table.name),
}));

export type Profile = typeof profiles.$inferSelect;
export type NewProfile = typeof profiles.$inferInsert;
