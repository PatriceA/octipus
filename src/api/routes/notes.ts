import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { getNoteService } from '@/core/knowledge/notes';
import { getSuggestionService } from '@/core/knowledge/suggestions';
import { getKnowledgeLinkRepository } from '@/db/repositories/knowledge-link-repository';
import { apiLogger } from '@/utils/logger';

const logger = apiLogger.child({ component: 'notes-route' });

/**
 * Knowledge-graph Tier 2 — notes authoring API. All reads/writes are
 * scoped to the authenticated user. Cross-tenant access surfaces as 404
 * (not 403) to avoid id enumeration, matching the documents route.
 */
export const noteRoutes = new Elysia({ prefix: '/notes' })
  .use(apiContext)

  .get(
    '/',
    async ({ user, query, set }) => {
      if (!user) { set.status = 401; return { error: 'Not authenticated' }; }
      const notes = await getNoteService().list(user.id, {
        kind: query.kind,
        tag: query.tag,
        includeArchived: query.includeArchived === 'true',
        limit: Math.min(500, Math.max(1, parseInt(query.limit ?? '100', 10))),
      });
      return { notes, total: notes.length };
    },
    {
      query: t.Object({
        kind: t.Optional(t.String()),
        tag: t.Optional(t.String()),
        includeArchived: t.Optional(t.String()),
        limit: t.Optional(t.String()),
      }),
      detail: { tags: ['notes'] },
    },
  )

  .post(
    '/',
    async ({ user, body, set }) => {
      if (!user) { set.status = 401; return { error: 'Not authenticated' }; }
      try {
        const result = await getNoteService().save({
          userId: user.id,
          workspaceId: body.workspaceId ?? null,
          id: body.id,
          slug: body.slug,
          title: body.title,
          body: body.body ?? '',
          noteKind: body.noteKind,
          tags: body.tags,
          frontmatter: body.frontmatter,
        });
        return result;
      } catch (err) {
        // Update of a non-existent / non-owned note → 404 (no enumeration).
        if (err instanceof Error && /not found/.test(err.message)) { set.status = 404; return { error: 'Note not found' }; }
        // Concurrent create racing the same slug → 409, not a 500.
        if (err instanceof Error && /unique constraint|duplicate key/i.test(err.message)) { set.status = 409; return { error: 'A note with this slug already exists' }; }
        throw err;
      }
    },
    {
      body: t.Object({
        id: t.Optional(t.String()),
        slug: t.Optional(t.String()),
        title: t.String(),
        body: t.Optional(t.String()),
        noteKind: t.Optional(t.String()),
        tags: t.Optional(t.Array(t.String())),
        frontmatter: t.Optional(t.Record(t.String(), t.Unknown())),
        workspaceId: t.Optional(t.String()),
      }),
      detail: { tags: ['notes'] },
    },
  )

  .post(
    '/capture',
    async ({ user, body, set }) => {
      if (!user) { set.status = 401; return { error: 'Not authenticated' }; }
      try {
        const note = await getNoteService().capture(user.id, body.workspaceId ?? null, body.text, body.date);
        return { id: note.id, slug: note.slug };
      } catch (err) {
        if (err instanceof Error && /invalid date/i.test(err.message)) { set.status = 400; return { error: err.message }; }
        throw err;
      }
    },
    { body: t.Object({ text: t.String(), date: t.Optional(t.String()), workspaceId: t.Optional(t.String()) }), detail: { tags: ['notes'] } },
  )

  .get(
    '/:id',
    async ({ user, params, set }) => {
      if (!user) { set.status = 401; return { error: 'Not authenticated' }; }
      const note = await getNoteService().getById(user.id, params.id);
      if (!note) { set.status = 404; return { error: 'Note not found' }; }
      const backlinks = await getKnowledgeLinkRepository().getBacklinks(user.id, 'note', note.id);
      const outgoing = await getKnowledgeLinkRepository().getOutgoing(user.id, 'note', note.id);
      return { ...note, backlinks, outgoing };
    },
    { detail: { tags: ['notes'] } },
  )

  .get(
    '/:id/suggestions',
    async ({ user, params, set }) => {
      if (!user) { set.status = 401; return { error: 'Not authenticated' }; }
      try {
        const suggestions = await getSuggestionService().suggestForNote(user.id, params.id);
        return { suggestions };
      } catch (err) {
        if (err instanceof Error && /not found/.test(err.message)) { set.status = 404; return { error: 'Note not found' }; }
        throw err;
      }
    },
    { detail: { tags: ['notes'] } },
  )

  .delete(
    '/:id',
    async ({ user, params, query, set }) => {
      if (!user) { set.status = 401; return { error: 'Not authenticated' }; }
      const hard = query.hard === 'true';
      const ok = hard
        ? await getNoteService().remove(user.id, params.id)
        : await getNoteService().archive(user.id, params.id);
      if (!ok) { set.status = 404; return { error: 'Note not found' }; }
      logger.info({ noteId: params.id, userId: user.id, hard }, hard ? 'note removed via API' : 'note archived via API');
      return { deleted: true, hard };
    },
    { query: t.Object({ hard: t.Optional(t.String()) }), detail: { tags: ['notes'] } },
  );
