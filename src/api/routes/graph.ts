import { and, eq, isNull } from 'drizzle-orm';
import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { getKnowledgeGraph } from '@/core/knowledge/graph';
import { getDb } from '@/db/postgres';
import { knowledgeLinks } from '@/db/schema/knowledge-links';
import { notes } from '@/db/schema/notes';

/**
 * Knowledge-graph Tier 2 — graph data for the web graph view.
 * Returns `{ nodes, edges }` scoped to the authenticated user. Global
 * mode returns all of the user's notes + resolved edges; local mode
 * (?entryType&entryId&hops) returns the neighbourhood of one entity.
 */
export const graphRoutes = new Elysia({ prefix: '/graph' })
  .use(apiContext)

  .get(
    '/',
    async ({ user, query, set }) => {
      if (!user) { set.status = 401; return { error: 'Not authenticated' }; }
      const db = getDb();

      // Local neighbourhood mode.
      if (query.entryType && query.entryId) {
        const hops = Math.min(5, Math.max(1, parseInt(query.hops ?? '2', 10)));
        const result = await getKnowledgeGraph().traverse(
          user.id,
          [{ type: query.entryType, id: query.entryId }],
          { hops, direction: 'both' },
        );
        const nodeIds = new Set<string>([query.entryId, ...result.nodes.map((n) => n.id)]);
        const noteNodes = await loadNoteNodes(user.id, [...nodeIds]);
        return {
          nodes: noteNodes,
          edges: result.edges.map(edgeView),
          center: { type: query.entryType, id: query.entryId },
        };
      }

      // Global mode — all active notes + their resolved edges.
      const noteRows = await db
        .select({ id: notes.id, slug: notes.slug, title: notes.title, kind: notes.noteKind })
        .from(notes)
        .where(and(eq(notes.userId, user.id), isNull(notes.archivedAt)))
        .limit(2000);
      const edgeRows = await db
        .select()
        .from(knowledgeLinks)
        .where(eq(knowledgeLinks.userId, user.id))
        .limit(5000);
      return {
        nodes: noteRows.map((n) => ({ type: 'note', id: n.id, slug: n.slug, label: n.title, kind: n.kind })),
        edges: edgeRows.map(edgeView),
      };
    },
    {
      query: t.Object({
        entryType: t.Optional(t.String()),
        entryId: t.Optional(t.String()),
        hops: t.Optional(t.String()),
      }),
      detail: { tags: ['graph'] },
    },
  );

function edgeView(e: typeof knowledgeLinks.$inferSelect) {
  return {
    id: e.id,
    from: { type: e.fromType, id: e.fromId },
    to: e.toId ? { type: e.toType, id: e.toId } : null,
    toRef: e.toRef,
    linkType: e.linkType,
    origin: e.origin,
    resolved: e.toId !== null,
  };
}

async function loadNoteNodes(userId: string, ids: string[]) {
  if (ids.length === 0) return [];
  const db = getDb();
  const rows = await db
    .select({ id: notes.id, slug: notes.slug, title: notes.title, kind: notes.noteKind })
    .from(notes)
    .where(eq(notes.userId, userId));
  const wanted = new Set(ids);
  return rows
    .filter((r) => wanted.has(r.id))
    .map((n) => ({ type: 'note', id: n.id, slug: n.slug, label: n.title, kind: n.kind }));
}
