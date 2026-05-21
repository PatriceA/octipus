import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export interface ProfileFact {
  key: string;       // "location", "birthday", "likes", "email", "phone"
  value: string;     // "Berlin", "March 15", "chocolate", etc.
  source?: string;   // "user told us", "learned from conversation"
  learnedAt?: string; // ISO date when this fact was learned
}

export const profiles = pgTable('profiles', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),                    // "Mom", "Patrice", "Dr. Mueller", "Octipus"
  relationship: text('relationship'),              // "self", "mother", "colleague", "boss", "friend"
  // Categories:
  //   "person"       — humans the user knows
  //   "organization" — companies / teams
  //   "pet"          — animals
  //   "assistant"    — the orchestrator's own profile (persona) for this
  //                    user. Exactly one per user; created on demand and
  //                    seeded from `personas/octipus.yaml`.
  category: text('category').notNull().default('person'),
  facts: jsonb('facts').$type<ProfileFact[]>().default([]),
  userId: uuid('user_id').notNull(),               // owner of this profile
  isUserProfile: boolean('is_user_profile').default(false), // true for the user's own profile
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  userIdx: index('profiles_user_id_idx').on(table.userId),
  nameIdx: index('profiles_name_idx').on(table.name),
  // Frequent lookup: "find this user's assistant profile" / "find this
  // user's profile by category". Composite index supports both.
  userCategoryIdx: index('profiles_user_category_idx').on(table.userId, table.category),
}));

export type Profile = typeof profiles.$inferSelect;
export type NewProfile = typeof profiles.$inferInsert;
