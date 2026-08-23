import { eq } from 'drizzle-orm';
import { Elysia, t } from '@/api/http';
import { apiContext } from '@/api/context';
import { ROLE_CONFIGS, setRoleToolIdsInMemory } from '@/core/orchestrator/roles';
import type { AgentRole } from '@/core/orchestrator/types';
import { getDb } from '@/db/postgres';
import { roles } from '@/db/schema/roles';
import { apiLogger } from '@/utils/logger';

/**
 * Role routes — read role↔tool bindings and (admin) edit them at runtime.
 *
 * The file registry (`roles/<name>/config.ts`) is the default/fallback; the DB
 * row is the runtime override (loaded into ROLE_CONFIGS at boot). PATCH writes
 * the DB row, marks it customized (so the boot seed stops re-merging code tool
 * ids over a user's removals), and updates the in-memory ROLE_CONFIGS so a
 * freshly spawned worker of that role sees the new toolset immediately —
 * getToolsForRole reads ROLE_CONFIGS synchronously, so that mutation IS the
 * cache invalidation.
 */
export const roleRoutes = new Elysia({ prefix: '/roles' })
  .use(apiContext)

  // List roles with their current tool bindings (DB-backed, with the
  // customized flag so the UI can show "overridden vs default").
  .get(
    '/',
    async ({ user, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }
      const db = getDb();
      const rows = await db.select().from(roles);
      return {
        roles: rows
          // The file registry is canonical (see `seedRoles`), and it never
          // deletes: a role whose folder was removed leaves its row behind, and
          // listing it offers an edit that PATCH then rejects. Filtering here
          // keeps the surface honest for any retired role, not just the
          // `orchestrator` one Phase 9 removed.
          .filter((r) => ROLE_CONFIGS[r.role as AgentRole] !== undefined)
          .map((r) => ({
            role: r.role,
            defaultTopic: r.defaultTopic,
            toolIds: (r.toolIds as string[]) ?? [],
            customized: r.toolIdsCustomized,
            isSystem: r.isSystem,
          }))
          .sort((a, b) => a.role.localeCompare(b.role)),
      };
    },
    { detail: { tags: ['roles'] } },
  )

  // Set a role's tool allowlist (admin-only).
  .patch(
    '/:role',
    async ({ params, body, user, set }) => {
      if (!user?.isAdmin) {
        set.status = 403;
        return { error: 'Admin access required' };
      }

      const roleName = params.role;
      if (!ROLE_CONFIGS[roleName as AgentRole]) {
        set.status = 404;
        return { error: `Unknown role: ${roleName}` };
      }

      // Normalize: trim, drop empties, dedupe — fail loud on a non-array.
      const raw = body.toolIds;
      if (!Array.isArray(raw)) {
        set.status = 400;
        return { error: 'toolIds must be an array of strings' };
      }
      const toolIds = [...new Set(raw.map((s) => String(s).trim()).filter(Boolean))];

      const db = getDb();
      const [updated] = await db
        .update(roles)
        .set({ toolIds, toolIdsCustomized: true, updatedAt: new Date() })
        .where(eq(roles.role, roleName))
        .returning();

      if (!updated) {
        set.status = 404;
        return { error: `Role row not found: ${roleName}` };
      }

      // Invalidate the in-memory cache so the next spawn picks it up.
      setRoleToolIdsInMemory(roleName as AgentRole, toolIds);

      apiLogger.info({ role: roleName, toolCount: toolIds.length, by: user.id }, 'Role toolIds updated');
      return { role: roleName, toolIds, customized: true };
    },
    {
      params: t.Object({ role: t.String() }),
      body: t.Object({ toolIds: t.Array(t.String()) }),
      detail: { tags: ['roles'] },
    },
  );
