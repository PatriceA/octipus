import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * `capabilities` — the persisted state of every optional tool / external
 * binary Octipus knows how to use (Playwright, MCP server, ripgrep, …).
 *
 * Source of truth for orchestrator gating decisions: instead of each
 * agent re-probing on spawn, the orchestrator reads from this table.
 * `octi setup` and a periodic boot probe write the rows.
 *
 * Why a table and not just memory: Docker / multi-machine deployments
 * need to surface capabilities via API to the user's local CLI so
 * `octi capabilities` works against a remote backend identically.
 *
 * Per-row uniqueness on `toolId` matches `src/tools/registry.ts`
 * naming (`browser`, `mcp`, `docker`, `shell`, …).
 */
export const capabilities = pgTable('capabilities', {
  id: uuid('id').primaryKey().defaultRandom(),
  toolId: text('tool_id').notNull().unique(),
  available: boolean('available').notNull().default(false),
  /** Available but with reduced functionality (e.g. browser missing headless deps). */
  degraded: boolean('degraded').notNull().default(false),
  /** Reason string for the current status (probe error or version mismatch). */
  reason: text('reason'),
  /** Detected version when probe surfaces one (e.g. `playwright@1.49.0`). */
  version: text('version'),
  /** Absolute path / endpoint where the capability was found. */
  path: text('path'),
  /**
   * Installer dispatch kind for `octi capabilities install <id>`.
   *   - `bun-exec`: runs `npx <pkg> install` style
   *   - `shell`: runs an arbitrary shell script (curl|bash, etc.)
   *   - `npm-build`: cd into a path, npm install + npm run build
   *   - `copy`: filesystem copy (e.g. browser extension)
   *   - `manual`: no auto-install; print docs URL
   */
  installerKind: text('installer_kind').notNull().default('manual'),
  /** Optional metadata: install hints, doc URL, command output, etc. */
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  checkedAt: timestamp('checked_at', { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  availableIdx: index('capabilities_available_idx').on(table.available),
}));

export type CapabilityRow = typeof capabilities.$inferSelect;
export type NewCapabilityRow = typeof capabilities.$inferInsert;
