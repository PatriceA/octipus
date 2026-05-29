/**
 * Org membership lookup — Phase 4 follow-up.
 *
 * Centralizes the "which orgs does this user belong to" query so
 * scoped repositories don't reimplement it. Visibility rule for any
 * org-scoped row (e.g. `model_config.org_id`, `skills.org_id`):
 *
 *   visible to U  iff  org_id IS NULL                  (system)
 *                       OR user_id = U                 (personal)
 *                       OR org_id IN userOrgIds(U)     (org-shared)
 *
 * The result is small (a user belongs to a handful of orgs) so a
 * per-request lookup is fine. Add a request-scoped cache if it shows
 * up in profiles.
 */
import { eq } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { orgMembers } from '@/db/schema/organizations';

export async function getUserOrgIds(userId: string): Promise<string[]> {
  if (!userId || userId === 'system') return [];
  const rows = await getDb()
    .select({ orgId: orgMembers.orgId })
    .from(orgMembers)
    .where(eq(orgMembers.userId, userId));
  return rows.map((r) => r.orgId);
}
