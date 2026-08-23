import { eq } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { roles } from '@/db/schema/roles';
import { logger } from '@/utils/logger';

/**
 * Seed role records into the database from the file-based registry
 * (`src/core/orchestrator/roles/<name>/{config.ts, prompt.md}`).
 *
 * SOURCE-OF-TRUTH RULES — read before editing:
 *
 *   - The file registry is canonical. Add/remove roles by editing files,
 *     never by writing to the DB directly.
 *   - The DB row exists so users can tweak prompts and tool allowlists
 *     at runtime from the web UI. We fill MISSING rows here; we never
 *     overwrite fields that diverge, so user edits survive restarts.
 *   - New tool IDs added at the registry level are MERGED into the DB
 *     row's toolIds so capabilities stay current without wiping user
 *     customisations.
 *
 * If the DB and registry diverge confusingly, trust the registry — delete
 * the DB row and re-seed.
 */
export async function seedRoles(): Promise<void> {
  // Dynamic import to avoid circular dependency
  const { ROLE_CONFIGS } = await import('@/core/orchestrator/roles');
  const db = getDb();

  for (const [roleName, config] of Object.entries(ROLE_CONFIGS)) {
    const [existing] = await db
      .select()
      .from(roles)
      .where(eq(roles.role, roleName))
      .limit(1);

    if (existing) {
      const updates: Record<string, unknown> = {};

      // Merge any new toolIds from code into the DB record (preserves user
      // additions) — but ONLY while the user hasn't customized this role's
      // toolIds via the UI. Once customized, the row is authoritative so a
      // user's removals survive restarts (otherwise a removed code tool would
      // be re-added on every boot). When not customized, code is the default.
      if (!existing.toolIdsCustomized) {
        const dbToolIds = new Set((existing.toolIds as string[]) || []);
        const codeToolIds = config.toolIds || [];
        const newTools = codeToolIds.filter(id => !dbToolIds.has(id));
        if (newTools.length > 0) {
          updates.toolIds = [...dbToolIds, ...newTools];
        }
      }

      // If the system prompt was never customized (matches an older hardcoded version),
      // update it to the latest from code. Only sync if the existing prompt is the
      // system default (isSystem flag) — user-edited prompts are preserved.
      if (existing.isSystem && config.systemPromptTemplate !== existing.systemPromptTemplate) {
        updates.systemPromptTemplate = config.systemPromptTemplate;
      }

      // defaultTopic is not user-editable via UI — always resync from code for
      // system roles so renames (e.g. analysis → research) propagate.
      if (existing.isSystem && config.defaultTopic !== existing.defaultTopic) {
        updates.defaultTopic = config.defaultTopic;
      }

      if (Object.keys(updates).length > 0) {
        await db.update(roles).set(updates).where(eq(roles.role, roleName));
        logger.info({ role: roleName, updatedFields: Object.keys(updates) }, 'Updated role from code');
      }
      continue;
    }

    await db.insert(roles).values({
      role: roleName,
      toolIds: config.toolIds,
      defaultTopic: config.defaultTopic,
      systemPromptTemplate: config.systemPromptTemplate,
      isSystem: true,
    });

    logger.info({ role: roleName }, 'Seeded role to database');
  }
}

/**
 * Load role configs from the database and update the in-memory ROLE_CONFIGS cache.
 * This allows runtime editing of role prompts via the UI while keeping
 * the synchronous getRoleConfig() API working.
 */
export async function loadRolesFromDb(): Promise<void> {
  const { ROLE_CONFIGS } = await import('@/core/orchestrator/roles');
  const db = getDb();

  const dbRoles = await db.select().from(roles);

  for (const dbRole of dbRoles) {
    const existing = ROLE_CONFIGS[dbRole.role as keyof typeof ROLE_CONFIGS];
    if (existing) {
      // Overlay the three columns the DB owns onto the registry entry. It used
      // to REBUILD the object from those columns, which silently dropped every
      // field the `roles` table has no column for — `readOnly` (the only
      // per-handler write filter in the system), `coreToolIds` (the whole lazy
      // tool-discovery gate) and `liteSystemPromptTemplate`. All three were
      // present in tests and absent in a booted server, which is why nothing
      // caught it.
      ROLE_CONFIGS[dbRole.role as keyof typeof ROLE_CONFIGS] = {
        ...existing,
        role: dbRole.role as any,
        toolIds: dbRole.toolIds as string[],
        defaultTopic: dbRole.defaultTopic,
        systemPromptTemplate: dbRole.systemPromptTemplate,
      };
    }
  }

  logger.info({ count: dbRoles.length }, 'Loaded roles from database');
}
