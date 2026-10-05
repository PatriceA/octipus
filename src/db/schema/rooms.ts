import { boolean, index, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { workspaces } from './organizations';
import { sessions } from './sessions';
import { users } from './users';

/**
 * Rooms (docs/plans/coworking-spec.md §6.1). A room is a `sessions` row with
 * `kind = 'room'` in a shared workspace; these tables hold what a chat does
 * not have.
 */

/** Who may enter a private room. Open rooms (`room_visibility = 'space'`) have no rows here. */
export const roomMembers = pgTable('room_members', {
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  addedBy: uuid('added_by').references(() => users.id, { onDelete: 'set null' }),
  addedAt: timestamp('added_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.sessionId, table.userId] }),
  userIdx: index('room_members_user_idx').on(table.userId),
}));

/** A member's read position and mute in any room. */
export const roomReads = pgTable('room_reads', {
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  lastReadMessageId: uuid('last_read_message_id'),
  muted: boolean('muted').default(false).notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.sessionId, table.userId] }),
}));

/**
 * Space memory (§6.5): short facts members — or the agent for a requester —
 * record for the space's agent. Injected into every turn of a space session,
 * fenced as facts, never instructions. Retracted entries stay for the
 * record and stop being injected.
 */
export const spaceMemory = pgTable('space_memory', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'restrict' }),
  body: text('body').notNull(),
  authorKind: text('author_kind').$type<'member' | 'agent'>().notNull(),
  /** The member, or the requester the agent acted for. */
  authorUserId: uuid('author_user_id').references(() => users.id, { onDelete: 'set null' }),
  sessionId: uuid('session_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  retractedAt: timestamp('retracted_at', { withTimezone: true }),
  retractedBy: uuid('retracted_by').references(() => users.id, { onDelete: 'set null' }),
}, (table) => ({
  wsIdx: index('space_memory_ws_idx').on(table.workspaceId, table.createdAt),
}));

export type RoomMember = typeof roomMembers.$inferSelect;
export type RoomRead = typeof roomReads.$inferSelect;
export type SpaceMemoryEntry = typeof spaceMemory.$inferSelect;
