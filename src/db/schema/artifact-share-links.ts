import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { artifacts } from './artifacts';
import { users } from './users';

/**
 * Signed share link — `tokenHash = sha256(token)`. Raw token only ever exists
 * in the response that mints the link. `revokedAt` is checked on every read
 * so revocation is immediate.
 */
export const artifactShareLinks = pgTable(
  'artifact_share_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    artifactId: uuid('artifact_id')
      .notNull()
      .references(() => artifacts.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    scopeJson: jsonb('scope_json').$type<Record<string, unknown>>().notNull().default({}),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    tokenHashIdx: index('artifact_share_links_token_hash_idx').on(table.tokenHash),
    artifactIdx: index('artifact_share_links_artifact_id_idx').on(table.artifactId),
  }),
);

export type ArtifactShareLink = typeof artifactShareLinks.$inferSelect;
export type NewArtifactShareLink = typeof artifactShareLinks.$inferInsert;
