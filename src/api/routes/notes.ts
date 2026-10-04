import { Elysia, t } from '@/api/http';
import { apiContext } from '@/api/context';
import { getNoteService } from '@/core/knowledge/notes';
import { getSuggestionService } from '@/core/knowledge/suggestions';
import { getKnowledgeLinkRepository } from '@/db/repositories/knowledge-link-repository';
import { getNoteRepository } from '@/db/repositories/note-repository';
import type { Principal } from '@/security/principal';
import { apiLogger } from '@/utils/logger';

const logger = apiLogger.child({ component: 'notes-route' });

/**
 * The request's workspace. Every authenticated request carries one (the
 * server derive resolves it, creating the default lazily); reaching a
 * note route without it is a wiring bug, not a reason to read unscoped.
 */
function noteWorkspace(principal: Principal): string {
  if (!principal.workspaceId) throw new Error('notes route reached without a resolved workspace');
  return principal.workspaceId;
}

/**
 * Knowledge-graph Tier 2 — notes authoring API. All reads/writes are
 * scoped to the authenticated user and to the request's workspace under
 * the personal rule: that workspace's notes plus user-level ones
 * (`workspace_id IS NULL`). New notes land in the request's workspace;
 * the workspace never comes from the body. Cross-tenant and
 * other-workspace access surfaces as 404 (not 403) to avoid id
 * enumeration, matching the documents route.
 */
export const noteRoutes = new Elysia({ prefix: '/notes' })
  .use(apiContext)

  .get(
    '/',
    async ({ user, principal, query, set }) => {
      if (!user) { set.status = 401; return { error: 'Not authenticated' }; }
      const notes = await getNoteService().list(user.id, {
        workspaceId: noteWorkspace(principal),
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
    async ({ user, principal, body, set }) => {
      if (!user) { set.status = 401; return { error: 'Not authenticated' }; }
      try {
        const result = await getNoteService().save({
          userId: user.id,
          workspaceId: noteWorkspace(principal),
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
      }),
      detail: { tags: ['notes'] },
    },
  )

  // Bases-style property query — table/card/list views are built on this.
  .post(
    '/query',
    async ({ user, principal, body, set }) => {
      if (!user) { set.status = 401; return { error: 'Not authenticated' }; }
      const rows = await getNoteRepository().query(user.id, {
        workspaceId: noteWorkspace(principal),
        kind: body.kind,
        tag: body.tag,
        frontmatter: body.frontmatter,
        sort: body.sort,
        order: body.order,
        limit: Math.min(1000, Math.max(1, body.limit ?? 100)),
      });
      return { notes: rows, total: rows.length };
    },
    {
      body: t.Object({
        kind: t.Optional(t.String()),
        tag: t.Optional(t.String()),
        frontmatter: t.Optional(t.Record(t.String(), t.Unknown())),
        sort: t.Optional(t.Union([t.Literal('updated'), t.Literal('created'), t.Literal('title'), t.Literal('date')])),
        order: t.Optional(t.Union([t.Literal('asc'), t.Literal('desc')])),
        limit: t.Optional(t.Number()),
      }),
      detail: { tags: ['notes'] },
    },
  )

  // Lightweight {id,title,slug,kind} index — the source for `[[` autocomplete.
  .get(
    '/index',
    async ({ user, principal, set }) => {
      if (!user) { set.status = 401; return { error: 'Not authenticated' }; }
      const notes = await getNoteRepository().listIndex(user.id, noteWorkspace(principal));
      return { notes };
    },
    { detail: { tags: ['notes'] } },
  )

  // Tag → count across active notes — powers the tag tree + `#tag` autocomplete.
  .get(
    '/tags',
    async ({ user, principal, set }) => {
      if (!user) { set.status = 401; return { error: 'Not authenticated' }; }
      const tags = await getNoteRepository().tagCounts(user.id, noteWorkspace(principal));
      return { tags };
    },
    { detail: { tags: ['notes'] } },
  )

  .post(
    '/capture',
    async ({ user, principal, body, set }) => {
      if (!user) { set.status = 401; return { error: 'Not authenticated' }; }
      try {
        const note = await getNoteService().capture(user.id, noteWorkspace(principal), body.text, body.date);
        return { id: note.id, slug: note.slug };
      } catch (err) {
        if (err instanceof Error && /invalid date/i.test(err.message)) { set.status = 400; return { error: err.message }; }
        throw err;
      }
    },
    { body: t.Object({ text: t.String(), date: t.Optional(t.String()) }), detail: { tags: ['notes'] } },
  )

  .get(
    '/:id',
    async ({ user, principal, params, set }) => {
      if (!user) { set.status = 401; return { error: 'Not authenticated' }; }
      const workspaceId = noteWorkspace(principal);
      const note = await getNoteService().getById(user.id, params.id, workspaceId);
      if (!note) { set.status = 404; return { error: 'Note not found' }; }
      const links = getKnowledgeLinkRepository();
      const backlinks = await links.getBacklinks(user.id, 'note', note.id, workspaceId);
      // `tagged` edges are shown via the tag list, not the outgoing-links list.
      const outgoing = (await links.getOutgoing(user.id, 'note', note.id, workspaceId)).filter((e) => e.linkType !== 'tagged');

      // Resolve note endpoints to real titles/slugs in one batch so the UI
      // renders "← Roadmap" (clickable) instead of "← note:1a2b3c4".
      const noteIds = new Set<string>();
      for (const e of backlinks) if (e.fromType === 'note') noteIds.add(e.fromId);
      for (const e of outgoing) if (e.toType === 'note' && e.toId) noteIds.add(e.toId);
      const titleRows = await getNoteRepository().getByIds(user.id, [...noteIds], workspaceId);
      const titleMap = new Map(titleRows.map((r) => [r.id, { title: r.title, slug: r.slug }]));

      // `resolved` means "a note we loaded a title for" (i.e. clickable). A
      // real but non-note endpoint (document/memory) is shown by type:id, not
      // as a ghost — only true ghost edges (a ref with no bound id) are ghosts.
      const backlinksView = backlinks.map((e) => ({
        id: e.id,
        linkType: e.linkType,
        label: e.label,
        origin: e.origin,
        endpoint: { type: e.fromType, id: e.fromId, resolved: e.fromType === 'note' && titleMap.has(e.fromId), ...(titleMap.get(e.fromId) ?? {}) },
      }));
      const outgoingView = outgoing.map((e) => {
        if (e.toId) {
          return {
            id: e.id,
            linkType: e.linkType,
            label: e.label,
            origin: e.origin,
            endpoint: { type: e.toType ?? 'note', id: e.toId, resolved: e.toType === 'note' && titleMap.has(e.toId), ...(titleMap.get(e.toId) ?? {}) },
          };
        }
        // Ghost edge — the target note doesn't exist yet; show the ref.
        return {
          id: e.id,
          linkType: e.linkType,
          label: e.label,
          origin: e.origin,
          endpoint: { type: e.toType ?? 'note', ref: e.toRef, resolved: false },
        };
      });
      return { ...note, backlinks: backlinksView, outgoing: outgoingView };
    },
    { detail: { tags: ['notes'] } },
  )

  .get(
    '/:id/suggestions',
    async ({ user, principal, params, set }) => {
      if (!user) { set.status = 401; return { error: 'Not authenticated' }; }
      if (!(await getNoteService().getById(user.id, params.id, noteWorkspace(principal)))) {
        set.status = 404; return { error: 'Note not found' };
      }
      try {
        const suggestions = await getSuggestionService().suggestForNote(user.id, params.id, noteWorkspace(principal));
        return { suggestions };
      } catch (err) {
        if (err instanceof Error && /not found/.test(err.message)) { set.status = 404; return { error: 'Note not found' }; }
        throw err;
      }
    },
    { detail: { tags: ['notes'] } },
  )

  .patch(
    '/:id/pin',
    async ({ user, principal, params, body, set }) => {
      if (!user) { set.status = 401; return { error: 'Not authenticated' }; }
      const updated = await getNoteRepository().setPinned(user.id, params.id, body.pinned, noteWorkspace(principal));
      if (!updated) { set.status = 404; return { error: 'Note not found' }; }
      return { id: updated.id, pinned: updated.pinned };
    },
    { body: t.Object({ pinned: t.Boolean() }), detail: { tags: ['notes'] } },
  )

  .delete(
    '/:id',
    async ({ user, principal, params, query, set }) => {
      if (!user) { set.status = 401; return { error: 'Not authenticated' }; }
      const hard = query.hard === 'true';
      const workspaceId = noteWorkspace(principal);
      const ok = hard
        ? await getNoteService().remove(user.id, params.id, workspaceId)
        : await getNoteService().archive(user.id, params.id, workspaceId);
      if (!ok) { set.status = 404; return { error: 'Note not found' }; }
      logger.info({ noteId: params.id, userId: user.id, hard }, hard ? 'note removed via API' : 'note archived via API');
      return { deleted: true, hard };
    },
    { query: t.Object({ hard: t.Optional(t.String()) }), detail: { tags: ['notes'] } },
  );
