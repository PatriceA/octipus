import { coreLogger } from '@/utils/logger';

/**
 * Resolve a gateway userId to a real DB user ID.
 *
 * Local auth gives 'local', system auth gives 'system' — neither is a UUID, so
 * anything that reaches a `uuid` column (or filters on one) must translate
 * first or it either errors on the cast or silently matches nothing.
 */
export async function resolveUserId(userId: string): Promise<string> {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
    return userId; // Already a UUID
  }
  // Resolve to the first admin user (same as MASTER_KEY auth in REST API)
  try {
    const { getDb } = await import('@/db/postgres');
    const { users } = await import('@/db/schema/users');
    const { eq } = await import('drizzle-orm');
    const db = getDb();
    const [admin] = await db.select({ id: users.id }).from(users).where(eq(users.isAdmin, true)).limit(1);
    if (admin) return admin.id;
  } catch (err) { coreLogger.error({ err }, 'silent failure in resolveUserId'); }
  return userId; // Fallback
}
