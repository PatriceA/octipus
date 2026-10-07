import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
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
