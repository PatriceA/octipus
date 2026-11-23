import { eq } from 'drizzle-orm';
import type { RoleConfig } from '@/core/agent/types';
import { getDb } from '@/db/postgres';
import { type Role, roles } from '@/db/schema/roles';
import { withoutRetiredToolIds } from '@/core/agent/retired-tools';
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
  const { listRegisteredRoles } = await import('@/core/agent/role-registry');
  const db = getDb();

  // Built-ins only: a runtime role (an operator's row, a plugin's contribution)
  // is not seeded as a system row — `isSystem` is what stops a role from being
  // deleted, and a plugin's role is not even persisted.
  for (const { config } of listRegisteredRoles().filter((r) => r.source.kind === 'builtin')) {
    const roleName = config.role;
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
        // Merge any new toolIds from code (preserves user additions), and
        // drop the ids of removed built-in tools the merge once put there.
        const stored = (existing.toolIds as string[]) || [];
        const dbToolIds = new Set(withoutRetiredToolIds(stored));
        const newTools = (config.toolIds || []).filter(id => !dbToolIds.has(id));
        if (newTools.length > 0 || dbToolIds.size !== stored.length) {
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
  const { isBuiltinRole, registerRuntimeRole } = await import('@/core/agent/role-registry');
  const db = getDb();

  const dbRoles = await db.select().from(roles);

  for (const dbRole of dbRoles) {
    if (!isBuiltinRole(dbRole.role)) {
      // No folder. `isSystem` says which kind of orphan this is: a row the
      // seeder wrote for a role that has since been RETIRED (`orchestrator`,
      // removed in Phase 9, is still sitting in every existing database), or a
      // role the user created. Admitting the first kind would resurrect a
      // deleted role into the spawn menu, so only the second is registered.
      if (dbRole.isSystem) continue;
      // Through the registry, so a stored row is held to the rules a new one
      // is: a fresh id, tools a built-in role holds, a text lane. The tool
      // REGISTRY is not consulted — it is empty this early in boot, and the row
      // was checked against it when it was written. A row that fails is
      // skipped, loudly, rather than registered as something wider.
      try {
        registerRuntimeRole(roleDefinitionOfRow(dbRole), { kind: 'admin' }, { checkRegisteredTools: false });
      } catch (err) {
        logger.warn({ role: dbRole.role, err: (err as Error).message }, 'Skipping stored role that is not a valid runtime role');
      }
      continue;
    }
    const existing = ROLE_CONFIGS[dbRole.role];
    if (!existing) continue;
    {
      // Overlay the three columns the DB owns onto the registry entry. It used
      // to REBUILD the object from those columns, which silently dropped every
      // field the `roles` table has no column for — `readOnly` (the only
      // per-handler write filter in the system), `coreToolIds` (the whole lazy
      // tool-discovery gate) and `liteSystemPromptTemplate`. All three were
      // present in tests and absent in a booted server, which is why nothing
      // caught it.
      // A customized row can still name a removed tool; it is dropped here.
      const toolIds = withoutRetiredToolIds((dbRole.toolIds as string[]) ?? []);
      ROLE_CONFIGS[dbRole.role] = {
        ...existing,
        role: dbRole.role,
        toolIds,
        defaultTopic: dbRole.defaultTopic,
        systemPromptTemplate: dbRole.systemPromptTemplate,
        ...dbOwnedFields(dbRole, toolIds),
      };
    }
  }

  logger.info({ count: dbRoles.length }, 'Loaded roles from database');
}

/** An operator's row as a runtime role definition (`role-registry.ts`). */
export function roleDefinitionOfRow(row: Role): Record<string, unknown> {
  const list = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.map(String) : undefined);
  const toolIds = withoutRetiredToolIds(list(row.toolIds) ?? []);
  // Kept a subset of toolIds even when an edit removed one of them.
  const core = (list(row.coreToolIds) ?? []).filter((id) => toolIds.includes(id));
  const rules = list(row.criticalRules) ?? [];
  const limits = row.limits && typeof row.limits === 'object' ? row.limits : undefined;
  return {
    id: row.role,
    systemPrompt: row.systemPromptTemplate,
    toolIds,
    lane: row.defaultTopic,
    ...(row.displayName ? { displayName: row.displayName } : {}),
    ...(row.description ? { description: row.description } : {}),
    ...(core.length ? { coreToolIds: core } : {}),
    ...(rules.length ? { criticalRules: rules } : {}),
    ...(row.readOnly ? { readOnly: true } : {}),
    ...(list(row.spawns) ? { spawns: list(row.spawns) } : {}),
    ...(list(row.spawnedBy) ? { spawnedBy: list(row.spawnedBy) } : {}),
    ...(limits && (limits.maxTokens || limits.maxWallClockMs) ? { limits } : {}),
  };
}
