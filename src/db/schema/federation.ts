import { sql } from 'drizzle-orm';
import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Spaces across installs (docs/plans/federation-spec.md §8.1) — migration
 * `0137_federation.sql`.
 */

export type FederationInstanceStatus = 'active' | 'blocked';

/**
 * Host side: another install whose members joined a space here. Written on
 * the first successful `space.join` from it, never on a bare handshake. A
 * `blocked` row is refused at the handshake (4403) and by the data door.
 */
export const federationInstances = pgTable('federation_instances', {
  /** `base32(sha256(spki))[:26]` (`federation_instances_id_chk`). */
  instanceId: text('instance_id').primaryKey(),
  /** Its Ed25519 public key, SPKI DER base64. */
  publicKey: text('public_key').notNull(),
  status: text('status').$type<FederationInstanceStatus>().default('active').notNull(),
  firstSeen: timestamp('first_seen', { withTimezone: true }).defaultNow().notNull(),
  lastSeen: timestamp('last_seen', { withTimezone: true }).defaultNow().notNull(),
  blockedBy: uuid('blocked_by').references(() => users.id, { onDelete: 'set null' }),
  blockedAt: timestamp('blocked_at', { withTimezone: true }),
});

export type FederationInstance = typeof federationInstances.$inferSelect;
export type NewFederationInstance = typeof federationInstances.$inferInsert;

/** A visitor's role in a space on another install: never owner (§7.1). */
export type RemoteSpaceRole = 'editor' | 'commenter' | 'viewer' | 'guest';

/**
 * Visitor side (§6.2, §8.1): a space a user of this install joined on
 * another install. Metadata only — the host, the space's id and name, the
 * member's role and handle there — never the space's content (F-D11).
 * `leftAt` is the leave tombstone (§6.3): while it is set, `space.leave`
 * goes to the host every time the link opens, and the row is deleted once
 * the host acknowledges it.
 */
export const remoteSpaces = pgTable('remote_spaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** The host's instance id, pinned from the invite's fingerprint (`remote_spaces_host_chk`). */
  hostInstanceId: text('host_instance_id').notNull(),
  /** The host's Ed25519 public key the handshake verified, SPKI DER base64. */
  hostPublicKey: text('host_public_key').notNull(),
  /** The host's peer endpoint, `wss://<host>/federation`. */
  hostUrl: text('host_url').notNull(),
  /** The space's id on the host. */
  spaceId: uuid('space_id').notNull(),
  spaceName: text('space_name').notNull(),
  role: text('role').$type<RemoteSpaceRole>().notNull(),
  /** The member's handle on the host (`~name@fp8`): the `as` of every frame. */
  memberHandle: text('member_handle').notNull(),
  /** The member's own agent answers room posts that address it (§9), off by default. */
  agentAnswersWhenAddressed: boolean('agent_answers_when_addressed').default(false).notNull(),
  joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
  leftAt: timestamp('left_at', { withTimezone: true }),
}, (table) => [
  uniqueIndex('remote_spaces_live_uidx').on(table.userId, table.hostInstanceId, table.spaceId).where(sql`${table.leftAt} IS NULL`),
  index('remote_spaces_host_idx').on(table.hostInstanceId),
]);

export type RemoteSpace = typeof remoteSpaces.$inferSelect;
export type NewRemoteSpace = typeof remoteSpaces.$inferInsert;
