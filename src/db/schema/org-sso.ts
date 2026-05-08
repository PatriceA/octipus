import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';

/**
 * Per-org SSO + SCIM config. One row per organization. The SCIM
 * bearer token is referenced via vault entry id, not stored
 * inline.
 */
export const orgSsoConfig = pgTable(
  'org_sso_config',
  {
    orgId: uuid('org_id')
      .primaryKey()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    samlEnabled: boolean('saml_enabled').notNull().default(false),
    samlEntityId: text('saml_entity_id'),
    samlSsoUrl: text('saml_sso_url'),
    samlX509Cert: text('saml_x509_cert'),
    samlAttributeMap: jsonb('saml_attribute_map')
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    scimEnabled: boolean('scim_enabled').notNull().default(false),
    scimTokenVaultRef: text('scim_token_vault_ref'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    samlEnabledIdx: index('org_sso_config_saml_enabled_idx').on(table.samlEnabled),
    scimEnabledIdx: index('org_sso_config_scim_enabled_idx').on(table.scimEnabled),
  }),
);

export type OrgSsoConfig = typeof orgSsoConfig.$inferSelect;
export type NewOrgSsoConfig = typeof orgSsoConfig.$inferInsert;
