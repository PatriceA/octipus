import { eq } from 'drizzle-orm';
import type { RoleConfig } from '@/core/agent/types';
import { getDb } from '@/db/postgres';
import { type Role, roles } from '@/db/schema/roles';
import { logger } from '@/utils/logger';

/**
 * Seed role records into the database from the file-based registry
 * (`src/core/agent/roles/<name>/{config.ts, prompt.md}`).
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
  const { ROLE_CONFIGS } = await import('@/core/agent/roles');
  const db = getDb();

  for (const [roleName, config] of Object.entries(ROLE_CONFIGS)) {
    const [existing] = await db
      .select()
      .from(roles)
      .where(eq(roles.role, roleName))
      .limit(1);

    if (existing) {
      const updates: Record<string, unknown> = {};

      // `customized` is the whole gate: once a user has edited this role, the
      // row is authoritative and NOTHING below runs. `loadRolesFromDb` reads
      // the row back over the file config, so a resync here would undo the edit
      // on the next boot — which is exactly what it did to every field the flag
      // did not yet cover (prompt, read-only, critical rules, core tool set):
      // the edit took effect until the next restart and no further.
      //
      // `defaultTopic` is the one exception, resynced below, because a role's
      // lane is not user-editable for a system role — a rename in code
      // (analysis → research) has to propagate.
      if (!existing.customized) {
        // Merge any new toolIds from code (preserves user additions).
        const dbToolIds = new Set((existing.toolIds as string[]) || []);
        const newTools = (config.toolIds || []).filter(id => !dbToolIds.has(id));
        if (newTools.length > 0) {
          updates.toolIds = [...dbToolIds, ...newTools];
        }
        if (existing.isSystem) {
          if (config.systemPromptTemplate !== existing.systemPromptTemplate) {
            updates.systemPromptTemplate = config.systemPromptTemplate;
          }
          // Columns added with user-defined roles: a system role's row carries
          // what its folder says until someone edits it.
          const core = (existing.coreToolIds as string[] | null) ?? [];
          if (core.join() !== (config.coreToolIds ?? []).join()) {
            updates.coreToolIds = config.coreToolIds ?? [];
          }
          const rules = (existing.criticalRules as string[] | null) ?? [];
          if (rules.join('\u0000') !== (config.criticalRules ?? []).join('\u0000')) {
            updates.criticalRules = config.criticalRules ?? [];
          }
          if (existing.readOnly !== Boolean(config.readOnly)) {
            updates.readOnly = Boolean(config.readOnly);
          }
          if ((existing.description ?? '') !== (config.description ?? '')) {
            updates.description = config.description ?? null;
          }
        }
      }

      // Not gated on `customized`: see above.
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
      coreToolIds: config.coreToolIds ?? [],
      criticalRules: config.criticalRules ?? [],
      readOnly: Boolean(config.readOnly),
      description: config.description ?? null,
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
 *
 * It also admits roles that exist ONLY in the database. A role used to be a
 * folder and nothing else, so the sixteen shipped ones were the sixteen there
 * would ever be; the table could adjust one but never add one. A row with no
 * folder is a role the user created, and it joins the registry here — which is
 * why every field a folder can set now has a column beside it.
 */
/**
 * The fields the row owns outright, as a patch to spread over the file config.
 *
 * Empty is absent: a column left at its `[]` default means "the file decides",
 * not "this role has no critical rules" — otherwise seeding a column would wipe
 * sixteen roles' behaviour the first time it shipped.
 */
function dbOwnedFields(row: Role, toolIds: string[]): Partial<RoleConfig> {
  const core = ((row.coreToolIds as string[] | null) ?? []).filter((id) => toolIds.includes(id));
  const rules = (row.criticalRules as string[] | null) ?? [];
  return {
    // Kept a subset of toolIds even when an edit removed one of them — the
    // load-time invariant in roles/index.ts is a promise, not a hope.
    ...(core.length ? { coreToolIds: core } : {}),
    ...(rules.length ? { criticalRules: rules } : {}),
    ...(row.readOnly ? { readOnly: true } : {}),
    ...(row.description ? { description: row.description } : {}),
  };
}

export async function loadRolesFromDb(): Promise<void> {
  const { ROLE_CONFIGS } = await import('@/core/agent/roles');
  const db = getDb();

  const dbRoles = await db.select().from(roles);

  for (const dbRole of dbRoles) {
    const existing = ROLE_CONFIGS[dbRole.role as keyof typeof ROLE_CONFIGS];
    if (!existing) {
      // No folder. `isSystem` says which kind of orphan this is: a row the
      // seeder wrote for a role that has since been RETIRED (`orchestrator`,
      // removed in Phase 9, is still sitting in every existing database), or a
      // role the user created. Admitting the first kind would resurrect a
      // deleted role into the spawn menu, so only the second is registered.
      if (dbRole.isSystem) continue;
      // The same bar `loadRoles` holds the built-ins to: a row with no prompt
      // or no tools is skipped rather than registered as something that would
      // fail at spawn time.
      const toolIds = (dbRole.toolIds as string[]) ?? [];
      if (!dbRole.systemPromptTemplate?.trim() || toolIds.length === 0) {
        logger.warn({ role: dbRole.role }, 'Skipping user role with no prompt or no tools');
        continue;
      }
      ROLE_CONFIGS[dbRole.role as keyof typeof ROLE_CONFIGS] = {
        role: dbRole.role as any,
        toolIds,
        defaultTopic: dbRole.defaultTopic,
        systemPromptTemplate: dbRole.systemPromptTemplate,
        ...dbOwnedFields(dbRole, toolIds),
      };
      continue;
    }
    {
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
        ...dbOwnedFields(dbRole, (dbRole.toolIds as string[]) ?? []),
      };
    }
  }

  logger.info({ count: dbRoles.length }, 'Loaded roles from database');
}
