import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { workspaces } from './organizations';
import { users } from './users';

/**
 * Contacts ("Personen", docs/CASES.md): the people and organisations business
 * is done with — clients, relatives, referrers, suppliers, applicants. Unlike
 * `profiles` (the assistant's personal memory of the people in one user's
 * life), contacts are business records: in a space every member reads them
 * and editors write them, and cases link to them.
 *
 * Scoped like `tasks` and `cases`: `user_id` is the author, `workspace_id`
 * decides personal or space.
 */
export const contacts = pgTable('contacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
  /** 'person' | 'organization'. */
  kind: text('kind').default('person').notNull(),
  name: text('name').notNull(),
  email: text('email'),
  phone: text('phone'),
  address: jsonb('address').$type<ContactAddress>(),
  /** The organisation a person belongs to (a contact of kind 'organization' in the same scope). */
  organizationId: uuid('organization_id'),
  /** What the contact is to the business ("client", "relative", "referrer"). Free text. */
  tags: text('tags').array().default([]).notNull(),
  notes: text('notes'),
  /** Further fields a module or plugin keeps (customer number, date of birth…). String values only. */
  attributes: jsonb('attributes').$type<Record<string, string>>().default({}).notNull(),
  /** The id of the contact in the system it came from; unique per scope (`ContactRepo.createOnce`). */
  externalKey: text('external_key'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  userNameIdx: index('contacts_user_name_idx').on(table.userId, table.name),
  workspaceNameIdx: index('contacts_workspace_name_idx').on(table.workspaceId, table.name),
  organizationIdx: index('contacts_organization_idx').on(table.organizationId),
  externalKeyIdx: uniqueIndex('contacts_external_key_idx')
    .on(sql`coalesce(${table.workspaceId}::text, ${table.userId}::text)`, table.externalKey)
    .where(sql`${table.externalKey} IS NOT NULL`),
}));

export interface ContactAddress {
  street?: string;
  postalCode?: string;
  city?: string;
  country?: string;
}

export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
