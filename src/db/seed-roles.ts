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
    const existing = await db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.role, roleName))
      .limit(1);

    if (existing.length > 0) continue;

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
