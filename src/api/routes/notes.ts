import { Elysia, t } from '@/api/http';
import { apiContext } from '@/api/context';
import { acceptProposal, listNoteProposals, rejectProposal } from '@/core/docs/edit-proposals';
import { getConfig } from '@/config';
import { NoteTooLargeError, StaleWriteError, sha256Hex } from '@/core/docs/hub';
import { getNoteService } from '@/core/knowledge/notes';
import { getSuggestionService } from '@/core/knowledge/suggestions';
import { type ContentRepos, contentRepos } from '@/db/repositories/content';
import { getRevision, listRevisions } from '@/db/repositories/live-documents';
import type { Principal } from '@/security/principal';
import { SpaceError } from '@/security/space-access';
import { apiLogger } from '@/utils/logger';

const logger = apiLogger.child({ component: 'notes-route' });

/**
 * The request's content scope: the personal workspace rule, or the space
 * the member acts in (a space route, docs/plans/coworking-spec.md §5.4).
 * Every authenticated request carries a workspace (the server derive
 * resolves it, creating the default lazily); reaching a note route without
 * it is a wiring bug, not a reason to read unscoped.
 */
function noteRepos(principal: Principal): ContentRepos {
  if (!principal.workspaceId) throw new Error('notes route reached without a resolved workspace');
  return contentRepos(principal);
}

type StatusSetter = { status?: number | string };

/**
 * A space-note write refused by the document hub: 409 when the note changed
 * in a way the write cannot merge with (read it again), 400 when a body
 * write to an existing space note names no base, 413 when it would exceed
 * `spaces.noteMaxBytes`. Null for any other error (rethrown).
 */
function liveWriteError(err: unknown, set: StatusSetter): { error: string; code: string; currentSha256?: string } | null {
  if (err instanceof StaleWriteError && err.reason === 'missing_base') {
    set.status = 400;
    return { error: err.message, code: 'base_required', currentSha256: err.currentSha256 };
  }
  if (err instanceof StaleWriteError) {
    set.status = 409;
    return { error: err.message, code: 'stale', currentSha256: err.currentSha256 };
  }
  if (err instanceof NoteTooLargeError) {
    set.status = 413;
    return { error: err.message, code: 'too_large' };
  }
  return null;
}

/**
 * The space scope of the request, or a 404 (revisions and proposals exist
 * in spaces only). A guest's scope carries their folders (S6): they reach
 * the revisions and proposals of the notes those folders hold, as the
 * document hub does.
 */
function spaceNoteScope(principal: Principal, set: StatusSetter) {
  const { noteScope } = noteRepos(principal);
  if (noteScope.kind !== 'space') {
    set.status = 404;
    return null;
  }
  return noteScope;
}

/**
 * Knowledge-graph Tier 2 — notes authoring API. All reads/writes are
 * scoped to the authenticated user and to the request's workspace under
 * the personal rule: that workspace's notes plus user-level ones
 * (`workspace_id IS NULL`). In a space, every member's notes of the space,
 * written by the roles that may write (a viewer's write is a 403). New notes land in the request's workspace;
 * the workspace never comes from the body. Cross-tenant and
 * other-workspace access surfaces as 404 (not 403) to avoid id
 * enumeration, matching the documents route.
 *
 * Space notes are live documents (docs/plans/coworking-spec.md §7.3): a
 * save names the `baseSha256` it read (`GET /:id` returns the live text and
 * its sha while the note is open in an editor) and is merged with what
 * others typed meanwhile, or refused with 409 `stale`. Their revisions
 * (history, restore) and the agent's edit proposals (accept, reject) are
 * here too.
 */
export const noteRoutes = new Elysia({ prefix: '/notes' })
  .use(apiContext)

  .get(
    '/',
    async ({ user, principal, query, set }) => {
      if (!user) { set.status = 401; return { error: 'Not authenticated' }; }
      const notes = await noteRepos(principal).notes.list({
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
          scope: noteRepos(principal).noteScope,
          id: body.id,
          slug: body.slug,
          title: body.title,
          // Omitted on an existing space note: a metadata-only save.
          body: body.body,
          noteKind: body.noteKind,
          tags: body.tags,
          frontmatter: body.frontmatter,
          baseSha256: body.baseSha256,
        });
        return result;
      } catch (err) {
        if (err instanceof SpaceError) throw err;
        const refused = liveWriteError(err, set);
        if (refused) return refused;
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
        /** Space notes: the sha of the body this edit was made from. */
        baseSha256: t.Optional(t.String({ pattern: '^[0-9a-f]{64}$' })),
      }),
      detail: { tags: ['notes'] },
    },
  )

  // Bases-style property query — table/card/list views are built on this.
  .post(
    '/query',
    async ({ user, principal, body, set }) => {
      if (!user) { set.status = 401; return { error: 'Not authenticated' }; }
      const rows = await noteRepos(principal).notes.query({
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
      const notes = await noteRepos(principal).notes.listIndex();
      return { notes };
    },
    { detail: { tags: ['notes'] } },
  )

  // Tag → count across active notes — powers the tag tree + `#tag` autocomplete.
  .get(
    '/tags',
    async ({ user, principal, set }) => {
      if (!user) { set.status = 401; return { error: 'Not authenticated' }; }
      const tags = await noteRepos(principal).notes.tagCounts();
      return { tags };
    },
    { detail: { tags: ['notes'] } },
  )

  .post(
    '/capture',
    async ({ user, principal, body, set }) => {
      if (!user) { set.status = 401; return { error: 'Not authenticated' }; }
      try {
        const note = await getNoteService().capture(noteRepos(principal).noteScope, body.text, body.date);
        return { id: note.id, slug: note.slug };
      } catch (err) {
        const refused = liveWriteError(err, set);
        if (refused) return refused;
        if (err instanceof Error && /invalid date/i.test(err.message)) { set.status = 400; return { error: err.message }; }
        throw err;
      }
    },
    { body: t.Object({ text: t.String(), date: t.Optional(t.String()) }), detail: { tags: ['notes'] } },
  )

  // ── Edit proposals (space notes, §7.4) ────────────────────────────

  .get(
    '/proposals',
    async ({ user, principal, query, set }) => {
      if (!user) { set.status = 401; return { error: 'Not authenticated' }; }
      const scope = spaceNoteScope(principal, set);
      if (!scope) return { error: 'Not found' };
      const proposals = await listNoteProposals(scope, { noteId: query.noteId, status: query.status });
      return { proposals };
    },
    {
      query: t.Object({
        noteId: t.Optional(t.String({ format: 'uuid' })),
        status: t.Optional(t.Union([t.Literal('pending'), t.Literal('accepted'), t.Literal('rejected'), t.Literal('stale')])),
      }),
      detail: { tags: ['notes'] },
    },
  )

  .post(
    '/proposals/:proposalId/accept',
    async ({ user, principal, params, set }) => {
      if (!user) { set.status = 401; return { error: 'Not authenticated' }; }
      const scope = spaceNoteScope(principal, set);
      if (!scope) return { error: 'Not found' };
      try {
        const result = await acceptProposal(scope, params.proposalId);
        // A stale proposal is an answer, not a failure: the client shows the three texts.
        if (result.status === 'stale') set.status = 409;
        return result;
      } catch (err) {
        const refused = liveWriteError(err, set);
        if (refused) return refused;
        throw err;
      }
    },
    { detail: { tags: ['notes'] } },
  )

  .post(
    '/proposals/:proposalId/reject',
    async ({ user, principal, params, set }) => {
      if (!user) { set.status = 401; return { error: 'Not authenticated' }; }
      const scope = spaceNoteScope(principal, set);
      if (!scope) return { error: 'Not found' };
      return { proposal: await rejectProposal(scope, params.proposalId) };
    },
    { detail: { tags: ['notes'] } },
  )

  .get(
    '/:id',
    async ({ user, principal, params, set }) => {
      if (!user) { set.status = 401; return { error: 'Not authenticated' }; }
      const repos = noteRepos(principal);
      // A space note open in an editor reads as its live text and sha (§7.3).
      const note = await getNoteService().getById(repos.noteScope, params.id);
      if (!note) { set.status = 404; return { error: 'Note not found' }; }
      const backlinks = await repos.links.getBacklinks('note', note.id);
      // `tagged` edges are shown via the tag list, not the outgoing-links list.
      const outgoing = (await repos.links.getOutgoing('note', note.id)).filter((e) => e.linkType !== 'tagged');

      // Resolve note endpoints to real titles/slugs in one batch so the UI
      // renders "← Roadmap" (clickable) instead of "← note:1a2b3c4".
      const noteIds = new Set<string>();
      for (const e of backlinks) if (e.fromType === 'note') noteIds.add(e.fromId);
      for (const e of outgoing) if (e.toType === 'note' && e.toId) noteIds.add(e.toId);
      const titleRows = await repos.notes.getByIds([...noteIds]);
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

  // ── Revisions (space notes, §7.6) ─────────────────────────────────

  .get(
    '/:id/revisions',
    async ({ user, principal, params, set }) => {
      if (!user) { set.status = 401; return { error: 'Not authenticated' }; }
      const scope = spaceNoteScope(principal, set);
      if (!scope) return { error: 'Not found' };
      if (!(await noteRepos(principal).notes.getById(params.id))) { set.status = 404; return { error: 'Note not found' }; }
      return { revisions: await listRevisions(scope.workspaceId, params.id) };
    },
    { detail: { tags: ['notes'] } },
  )

  .get(
    '/:id/revisions/:revisionId',
    async ({ user, principal, params, set }) => {
      if (!user) { set.status = 401; return { error: 'Not authenticated' }; }
      const scope = spaceNoteScope(principal, set);
      if (!scope) return { error: 'Not found' };
      if (!(await noteRepos(principal).notes.getById(params.id))) { set.status = 404; return { error: 'Note not found' }; }
      const revision = await getRevision(scope.workspaceId, params.id, params.revisionId);
      if (!revision) { set.status = 404; return { error: 'Revision not found' }; }
      return { revision };
    },
    { detail: { tags: ['notes'] } },
  )

  // Restore an older revision: written as a new revision over the current
  // text (the live one, when the note is open), never by rewinding history.
  .post(
    '/:id/revisions/:revisionId/restore',
    async ({ user, principal, params, set }) => {
      if (!user) { set.status = 401; return { error: 'Not authenticated' }; }
      const scope = spaceNoteScope(principal, set);
      if (!scope) return { error: 'Not found' };
      const revision = await getRevision(scope.workspaceId, params.id, params.revisionId);
      if (!revision) { set.status = 404; return { error: 'Revision not found' }; }
      const notes = getNoteService();
      try {
        // Restoring replaces the text: the base is whatever it is now.
        for (let attempt = 0; ; attempt++) {
          const current = await notes.getById(scope, params.id);
          if (!current) { set.status = 404; return { error: 'Note not found' }; }
          try {
            const write = await notes.writeSpaceBody(scope, params.id, {
              base: { sha256: current.bodySha256, text: current.body },
              next: revision.body,
              origin: { kind: 'restore', userId: scope.userId, restoredFrom: revision.id },
            });
            return { revisionId: write.revisionId, changed: write.changed, sha256: write.note.bodySha256 };
          } catch (err) {
            // Someone typed into the same lines between the read and the
            // write: read again (a restore always means "this text").
            if (err instanceof StaleWriteError && attempt < 2) continue;
            throw err;
          }
        }
      } catch (err) {
        const refused = liveWriteError(err, set);
        if (refused) return refused;
        throw err;
      }
    },
    { detail: { tags: ['notes'] } },
  )

  // A live editor's text the server never got (typed offline, or unsent
  // when the document was rebuilt under a new epoch): merged into the note
  // through the document hub like any writer's change (diff3 of the last
  // server text the editor synced, the current text and the editor's), as
  // the member's own typing. 409 `stale` when it clashes with a change made
  // meanwhile: nothing is applied and the editor keeps its text to copy.
  .post(
    '/:id/merge',
    async ({ user, principal, params, body, set }) => {
      if (!user) { set.status = 401; return { error: 'Not authenticated' }; }
      const scope = spaceNoteScope(principal, set);
      if (!scope) return { error: 'Not found' };
      if (!(await noteRepos(principal).notes.getById(params.id))) { set.status = 404; return { error: 'Note not found' }; }
      if (Buffer.byteLength(body.base, 'utf8') > getConfig().spaces.noteMaxBytes) {
        set.status = 413;
        return { error: 'The base text is larger than a space note can be', code: 'too_large' };
      }
      try {
        const write = await getNoteService().writeSpaceBody(scope, params.id, {
          base: { sha256: sha256Hex(body.base), text: body.base },
          next: body.text,
          origin: { kind: 'peer', userId: scope.userId },
        });
        return { changed: write.changed, merged: write.merged, sha256: write.note.bodySha256, revisionId: write.revisionId };
      } catch (err) {
        const refused = liveWriteError(err, set);
        if (refused) return refused;
        throw err;
      }
    },
    {
      body: t.Object({
        /** The last server text the editor synced. */
        base: t.String(),
        /** The editor's text. */
        text: t.String(),
      }),
      detail: { tags: ['notes'] },
    },
  )

  .get(
    '/:id/suggestions',
    async ({ user, principal, params, set }) => {
      if (!user) { set.status = 401; return { error: 'Not authenticated' }; }
      const repos = noteRepos(principal);
      if (!(await repos.notes.getById(params.id))) {
        set.status = 404; return { error: 'Note not found' };
      }
      try {
        const suggestions = await getSuggestionService().suggestForNote(repos.noteScope, params.id);
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
      const updated = await noteRepos(principal).notes.setPinned(params.id, body.pinned);
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
      const { noteScope } = noteRepos(principal);
      const ok = hard
        ? await getNoteService().remove(noteScope, params.id)
        : await getNoteService().archive(noteScope, params.id);
      if (!ok) { set.status = 404; return { error: 'Note not found' }; }
      logger.info({ noteId: params.id, userId: user.id, hard }, hard ? 'note removed via API' : 'note archived via API');
      return { deleted: true, hard };
    },
    { query: t.Object({ hard: t.Optional(t.String()) }), detail: { tags: ['notes'] } },
  );
