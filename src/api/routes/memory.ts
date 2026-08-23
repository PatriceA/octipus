import { and, desc, eq, isNull } from 'drizzle-orm';
import { Elysia, t } from '@/api/http';
import { apiContext } from '@/api/context';
import { getDb } from '@/db/postgres';
import { memories } from '@/db/schema/memories';
import { apiLogger } from '@/utils/logger';

const logger = apiLogger.child({ component: 'memory-route' });

/**
 * Operator-facing memory API. List, inspect, and delete entries in
 * the `memories` table for the authenticated user. Read-only for the
 * underlying supersession chain — DELETE soft-deletes by setting
 * valid_until, never destructive — so the audit trail survives.
 *
 * Active rows = supersededBy IS NULL AND (validUntil IS NULL OR validUntil > now()).
 * The list endpoint can include superseded rows via ?includeHistory=true
 * for the UI's "show update chain" view.
 */
export const memoryRoutes = new Elysia({ prefix: '/memory' })
  .use(apiContext)

  .get(
    '/',
    async ({ user, query, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }
      const includeHistory = query.includeHistory === 'true';
      const factType = query.factType as string | undefined;
      const limit = Math.min(500, Math.max(1, parseInt(query.limit ?? '100', 10)));

      const db = getDb();
      const filters = [eq(memories.userId, user.id)];
      if (!includeHistory) filters.push(isNull(memories.supersededBy));
      if (factType) filters.push(eq(memories.factType, factType));

      const rows = await db
        .select({
          id: memories.id,
          factType: memories.factType,
          agentScope: memories.agentScope,
          content: memories.content,
          confidence: memories.confidence,
          supersededBy: memories.supersededBy,
          validUntil: memories.validUntil,
          accessCount: memories.accessCount,
          lastAccessedAt: memories.lastAccessedAt,
          createdAt: memories.createdAt,
          updatedAt: memories.updatedAt,
        })
        .from(memories)
        .where(and(...filters))
        .orderBy(desc(memories.updatedAt))
        .limit(limit);

      return {
        memories: rows,
        total: rows.length,
        includeHistory,
      };
    },
    {
      query: t.Object({
        includeHistory: t.Optional(t.String()),
        factType: t.Optional(t.String()),
        limit: t.Optional(t.String()),
      }),
      detail: { tags: ['memory'] },
    },
  )

  .get(
    '/:id',
    async ({ user, params, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }
      const db = getDb();
      const rows = await db
        .select()
        .from(memories)
        .where(and(eq(memories.id, params.id), eq(memories.userId, user.id)))
        .limit(1);
      if (rows.length === 0) {
        set.status = 404;
        return { error: 'Memory not found' };
      }
      return rows[0];
    },
    { detail: { tags: ['memory'] } },
  )

  .delete(
    '/:id',
    async ({ user, params, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }
      // Soft delete: set valid_until = now(). Active retrieval drops
      // the row on the next read; the audit trail (and superseded_by
      // chain) survives. The judge can still see "this fact existed
      // and was removed" when deciding future ADD/UPDATE actions.
      const db = getDb();
      const result = await db
        .update(memories)
        .set({ validUntil: new Date(), updatedAt: new Date() })
        .where(and(eq(memories.id, params.id), eq(memories.userId, user.id)))
        .returning({ id: memories.id });
      if (result.length === 0) {
        set.status = 404;
        return { error: 'Memory not found' };
      }
      logger.info({ memoryId: params.id, userId: user.id }, 'memory soft-deleted via API');
      return { deleted: true, id: params.id };
    },
    { detail: { tags: ['memory'] } },
  )

  .get(
    '/:id/chain',
    async ({ user, params, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }
      // Walk the supersession chain backwards from the given id until
      // we hit a row whose supersededBy is NULL or the head we started
      // at. Bounded at 64 to defend against a corrupt cycle.
      const db = getDb();
      const out: Array<typeof memories.$inferSelect> = [];
      let currentId: string | null = params.id;
      for (let depth = 0; depth < 64 && currentId !== null; depth++) {
        const rows = await db
          .select()
          .from(memories)
          .where(and(eq(memories.id, currentId), eq(memories.userId, user.id)))
          .limit(1);
        if (rows.length === 0) break;
        out.push(rows[0]);
        // Walk back: find the row that points at this one.
        const ancestor = await db
          .select()
          .from(memories)
          .where(and(eq(memories.supersededBy, currentId), eq(memories.userId, user.id)))
          .limit(1);
        currentId = ancestor.length > 0 ? ancestor[0].id : null;
      }
      return { chain: out };
    },
    { detail: { tags: ['memory'] } },
  );
