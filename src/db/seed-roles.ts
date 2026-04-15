import { eq } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { roles } from '@/db/schema/roles';
import { logger } from '@/utils/logger';

/**
 * Seed role system prompt templates into the database from the hardcoded ROLE_CONFIGS.
 * Idempotent — skips roles that already exist. Existing DB entries take precedence
 * over hardcoded values (so user edits are preserved).
 *
 * Call this after the hardcoded ROLE_CONFIGS are initialized.
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

      // Merge any new toolIds from code into the DB record (preserves user additions)
      const dbToolIds = new Set((existing.toolIds as string[]) || []);
      const codeToolIds = config.toolIds || [];
      const newTools = codeToolIds.filter(id => !dbToolIds.has(id));
      if (newTools.length > 0) {
        updates.toolIds = [...dbToolIds, ...newTools];
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
    if (ROLE_CONFIGS[dbRole.role as keyof typeof ROLE_CONFIGS]) {
      // Update in-memory config from DB
      ROLE_CONFIGS[dbRole.role as keyof typeof ROLE_CONFIGS] = {
        role: dbRole.role as any,
        toolIds: dbRole.toolIds as string[],
        defaultTopic: dbRole.defaultTopic,
        systemPromptTemplate: dbRole.systemPromptTemplate,
      };
    }
  }

  logger.info({ count: dbRoles.length }, 'Loaded roles from database');
}
