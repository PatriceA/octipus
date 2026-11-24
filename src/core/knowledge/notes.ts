import { assertNoCredentialTemplates } from '@/security/credential-boundary';
import { getConfig } from '@/config';
import { type DocOrigin, type DocumentHub, NoteTooLargeError, StaleWriteError } from '@/core/docs/hub';
import { getDocHub } from '@/core/docs';
import { merge3, normalizeNewlines } from '@/core/docs/text-merge';
import { getKnowledgeLinkRepository, type KnowledgeLinkRepository } from '@/db/repositories/knowledge-link-repository';
import { insertRevision, loadSpaceNote, writeBodyIfUnchanged } from '@/db/repositories/live-documents';
import { withProviderUsageContext } from '@/models/providers/instrumented';
import { assertNoteAccess, getNoteRepository, MOVED_FROM, noteMovedFrom, type NoteRepository, type NoteScope, noteStoreFor, type NoteStore } from '@/db/repositories/note-repository';
import type { Note } from '@/db/schema/notes';
import { capabilityConfigured } from '@/core/capabilities/gates';
import { recordSkipped } from '@/core/rag/index-backlog';
import { coreLogger } from '@/utils/logger';
import { type EmbeddingService, getEmbeddingService, sha256Hex } from '@/core/rag/embeddings';
import { type KnowledgeOwner, noteKnowledgeScope } from '@/core/rag/knowledge-scope';
import { getLinkResolverService, type LinkResolverService } from './link-resolver';
import { NOTE_PURPOSES, notePurposeFor } from './note-purpose';
import { parseLinks, slugify } from './wikilink';

/**
 * Knowledge-graph Tier 2 — the note authoring pipeline.
 * See `docs/KNOWLEDGE-GRAPH.md`.
 *
 * `save()` is the single entry point for creating/updating a note. In
 * order, fail-loud at each step:
 *   1. change-detect via body sha — an unchanged body skips re-link and
 *      re-index entirely;
 *   2. re-link — parse `[[wikilinks]]`/`#tags`, sync `knowledge_links`,
 *      resolve any ghost edges that pointed at this note's slug, then give
 *      the leftovers one similarity guess (`link-resolver.ts`);
 *   3. re-index — chunk the body into `embeddings` under the purpose the
 *      note's kind calls for (`notePurposeFor`: `'lesson'` for a lesson note
 *      a learning review wrote, `'note'` for every other note).
 *
 * Every method takes a `NoteScope` (docs/plans/coworking-spec.md §5.5): a
 * user's personal notes, or one space's notes. Lookups, link resolution and
 * the index all stay inside that scope: a personal `[[link]]` never binds to
 * a space note and the reverse, and a space note's chunks are indexed with
 * the space's workspace id.
 *
 * Space notes are live documents (§7.3): while one is open in an editor,
 * every body write here goes through the document hub
 * (`writeSpaceBody`): the writer's base is merged with the live text, or
 * the write is refused as stale (`StaleWriteError`) — never applied over
 * someone's typing. A body write to an existing space note must name the
 * base it was made from (`baseSha256` / `baseBody`): without one the write
 * would be taken as made from the current text and revert whatever changed
 * since its read, so it is refused (`missing_base`). A closed space note is
 * written by one conditional update on its sha, under the same per-note
 * mutex, with a revision. Reads (`getById`, `getBySlug`) return the live
 * text and its sha while the note is open. Space notes hold at most
 * `spaces.noteMaxBytes`, with `\n` line endings (`normalizeNewlines`).
 *
 * Re-index degradation: indexing needs an embedding model. If none is
 * configured the note + its links are still saved (they don't depend on
 * embeddings); the failure is logged loudly and surfaced as
 * `indexed:false` rather than swallowed or allowed to lose the note.
 */

const SOURCE_PREFIX = 'note';
const sourceIdFor = (id: string) => `${SOURCE_PREFIX}:${id}`;

export interface SaveNoteInput {
  /**
   * Where the note lives. Personal: a new note is created in
   * `scope.workspaceId` (`null` = user-level); an existing note is looked up
   * under the personal rule (this workspace or user-level) and keeps its own
   * workspace. Space: the space's notes; a new note's author is
   * `scope.userId`.
   */
  scope: NoteScope;
  /** Update target. Omit to create (slug derived from `slug` or `title`). */
  id?: string;
  slug?: string;
  title: string;
  /**
   * The new body. Omitted on an existing space note: its body is left as it
   * is (a title or tag change from the live editor, whose text is saved by
   * the document hub).
   */
  body?: string;
  noteKind?: string;
  noteDate?: string | null;
  frontmatter?: Record<string, unknown>;
  /** Explicit tags, unioned with `#tags` parsed from the body. */
  tags?: string[];
  createdByAgentId?: string | null;
  /**
   * Space notes: the sha of the body the writer read (`getById` returns it
   * as `bodySha256`). Required (or `baseBody`) to write the body of an
   * existing space note. A base the hub no longer knows, or a change in the
   * same place, is refused as stale.
   */
  baseSha256?: string;
  /** Space notes: the body the writer read, when it kept it — merges even after the hub forgot the base. */
  baseBody?: string;
  /** Space notes: the member an agent writes for (revision attribution). */
  onBehalfOfUserId?: string | null;
  /**
   * Create only: a note already at the slug is left as it is and
   * `NoteExistsError` is thrown (an agent in suggest mode, whose change to
   * an existing note is a proposal).
   */
  createOnly?: boolean;
  /**
   * Personal notes: write only while the stored body still has this sha
   * (the one the writer read). Otherwise `StaleWriteError` and nothing is
   * written — an autosave from an editor never overwrites text saved since
   * from somewhere else. Space notes merge instead (`baseSha256`).
   */
  ifSha256?: string;
  /**
   * Re-index a moment after the last save of the note instead of inside this
   * one (`INDEX_DEBOUNCE_MS`): an editor that saves on every pause does not
   * re-embed the whole note each time. The result says `indexQueued`.
   */
  deferIndex?: boolean;
  /**
   * The write is a to-do's tick reaching its note line
   * (core/tasks/note-links.ts): the note's to-dos are not reconciled with
   * it again. Every other save completes or reopens the to-dos whose lines
   * it ticked or unticked.
   */
  skipTaskSync?: boolean;
}

/** A deferred re-index (`SaveNoteInput.deferIndex`) runs this long after the note's last save. */
export const INDEX_DEBOUNCE_MS = 5_000;

export interface SaveNoteResult {
  note: Note;
  created: boolean;
  /** False when the body changed but re-indexing was skipped/failed (logged), or was deferred. */
  indexed: boolean;
  /** The re-index was deferred (`deferIndex`): it runs once the note has been quiet for `INDEX_DEBOUNCE_MS`. */
  indexQueued?: boolean;
  links: { added: number; removed: number };
  /** Space notes: other changes were merged into the written body (it differs from the input). */
  merged?: boolean;
}

/** A space-note body write: the writer's change, merged into the live or stored text. */
export interface SpaceBodyWrite {
  base: { sha256: string; text?: string };
  next: string;
  origin: DocOrigin;
  title?: string;
  tags?: string[];
}

export interface SpaceBodyWriteResult {
  note: Note;
  changed: boolean;
  merged: boolean;
  revisionId: string | null;
}

type SpaceScope = NoteScope & { kind: 'space' };

/** A create-only write found a note at its slug (`SaveNoteInput.createOnly`); nothing was written. */
export class NoteExistsError extends Error {
  constructor(readonly noteId: string, readonly slug: string) {
    super(`A note already exists at ${slug}`);
    this.name = 'NoteExistsError';
  }
}

/** A move named a slug that is empty once normalized (`slugify`); nothing was written. */
export class InvalidSlugError extends Error {
  constructor(readonly input: string) {
    super(`Not a usable note slug: ${JSON.stringify(input)}`);
    this.name = 'InvalidSlugError';
  }
}

function withoutMovedFrom(frontmatter: Record<string, unknown>): Record<string, unknown> {
  const { [MOVED_FROM]: _drop, ...rest } = frontmatter;
  void _drop;
  return rest;
}

function withMovedFrom(frontmatter: Record<string, unknown>, movedFrom: string[]): Record<string, unknown> {
  return movedFrom.length > 0 ? { ...frontmatter, [MOVED_FROM]: movedFrom } : frontmatter;
}

/** A new daily note's text. */
const dailyTemplate = (date: string) => `# ${date}\n\n## Notes\n\n## Tasks\n`;

const byteLength = (text: string) => Buffer.byteLength(text, 'utf8');

/** Refuse (`NoteTooLargeError`) a space-note body over `spaces.noteMaxBytes`. */
export function assertSpaceNoteSize(body: string): void {
  const max = getConfig().spaces.noteMaxBytes;
  if (byteLength(body) > max) throw new NoteTooLargeError(byteLength(body), max);
}

/** Who a note's embedding chunks belong to: its author, in its workspace (a space's, for a space note). */
function noteOwner(note: Note): KnowledgeOwner {
  return { ownerUserId: note.userId, workspaceId: note.workspaceId ?? null };
}

/** Strip a leading `--- ... ---` YAML frontmatter block so it isn't parsed for links. */
function stripFrontmatter(body: string): string {
  const m = /^﻿?---\n[\s\S]*?\n---\n?/.exec(body);
  return m ? body.slice(m[0].length) : body;
}

export class NoteService {
  constructor(
    private readonly notes: NoteRepository = getNoteRepository(),
    private readonly links: KnowledgeLinkRepository = getKnowledgeLinkRepository(),
    private readonly embeddings: EmbeddingService = getEmbeddingService(),
    private readonly resolver: LinkResolverService = getLinkResolverService(),
    private readonly hub: () => DocumentHub = getDocHub,
  ) {}

  /** The bound store of a scope (`PersonalNoteRepo` / `SpaceNoteRepo`). */
  store(scope: NoteScope): NoteStore {
    return noteStoreFor(scope, this.notes);
  }

  async save(input: SaveNoteInput): Promise<SaveNoteResult> {
    const { scope, title } = input;
    assertNoCredentialTemplates({ title: input.title, body: input.body, tags: input.tags, frontmatter: input.frontmatter });
    // `movedFrom` is written by `move` alone: a writer cannot claim another
    // note's old slug through its frontmatter.
    const inputFrontmatter = input.frontmatter === undefined ? undefined : withoutMovedFrom(input.frontmatter);
    assertNoteAccess(scope, 'write');
    const store = this.store(scope);
    let body = input.body ?? '';
    if (scope.kind === 'space') {
      body = normalizeNewlines(body);
      assertSpaceNoteSize(body);
    }
    let bodySha = sha256Hex(body);

    // Resolve the existing row (by id, else by derived slug). On create,
    // the slug comes from an explicit `slug` or is derived from the title.
    const desiredSlug = input.slug ? slugify(input.slug) : input.id ? null : slugify(title);
    let existing: Note | null = null;
    if (input.id) {
      existing = await store.getById(input.id);
      if (!existing) throw new Error(`Note ${input.id} not found for this user`);
    } else if (desiredSlug) {
      existing = await store.getBySlug(desiredSlug);
    }
    if (existing && input.createOnly) throw new NoteExistsError(existing.id, existing.slug);
    if (existing && scope.kind !== 'space' && input.ifSha256 !== undefined && existing.bodySha256 !== input.ifSha256) {
      throw new StaleWriteError('unknown_base', existing.bodySha256);
    }

    // A space note's body goes through the hub (or the conditional write):
    // what is saved is the writer's change merged into the current text.
    let merged = false;
    let spaceBodyChanged = false;
    if (existing && scope.kind === 'space' && input.body === undefined) {
      body = existing.body;
      bodySha = existing.bodySha256;
    } else if (existing && scope.kind === 'space') {
      // No base: the writer's text cannot be told apart from a revert of
      // what others wrote since its read.
      if (input.baseSha256 === undefined && input.baseBody === undefined) throw new StaleWriteError('missing_base', existing.bodySha256);
      const write = await this.writeSpaceBody(scope, existing.id, {
        base: { sha256: input.baseSha256 ?? sha256Hex(input.baseBody ?? ''), text: input.baseBody },
        next: body,
        origin: { kind: 'external', userId: scope.userId, onBehalfOfUserId: input.onBehalfOfUserId ?? null },
      });
      body = write.note.body;
      bodySha = write.note.bodySha256;
      merged = write.merged;
      spaceBodyChanged = write.changed;
    }

    const parsed = parseLinks(stripFrontmatter(body));
    const tags = [...new Set([...(input.tags ?? []), ...parsed.tags])];

    // Upsert the row.
    let note: Note;
    let created: boolean;
    if (existing) {
      const bodyUnchanged = scope.kind === 'space' ? !spaceBodyChanged : existing.bodySha256 === bodySha;
      const updated = await store.update(existing.id, {
        title,
        // A space note's body was written above, under the note's mutex.
        ...(scope.kind === 'space' ? {} : { body, bodySha256: bodySha }),
        // Omitted: the stored frontmatter is left as it is, not written back
        // from the read above (a write to it since would be lost).
        // The note's own `movedFrom` stays whatever frontmatter is sent.
        ...(inputFrontmatter !== undefined ? { frontmatter: withMovedFrom(inputFrontmatter, noteMovedFrom(existing.frontmatter)) } : {}),
        tags,
        noteKind: input.noteKind ?? existing.noteKind,
        noteDate: input.noteDate ?? existing.noteDate,
      });
      if (!updated) throw new Error(`Note ${existing.id} vanished during update`);
      note = updated;
      created = false;
      // Unchanged body → metadata refreshed above, but skip the expensive
      // re-link + re-index passes (design: no-op on unchanged content).
      // Report the *actual* index state (a prior save may have failed to
      // index when no embedding model was configured) rather than assuming
      // success — otherwise `indexed:true` would lie about searchability.
      // A kind change that moves the chunks to another purpose re-indexes.
      if (bodyUnchanged && notePurposeFor(existing.noteKind) === notePurposeFor(note.noteKind)) {
        const indexed = body.trim().length === 0 || (await this.embeddings.countBySource(noteKnowledgeScope(scope), notePurposeFor(note.noteKind), sourceIdFor(note.id))) > 0;
        return { note: this.withLive(scope, note), created, indexed, links: { added: 0, removed: 0 }, merged };
      }
    } else {
      note = await store.create({
        slug: desiredSlug ?? slugify(title),
        title,
        body,
        bodySha256: bodySha,
        frontmatter: inputFrontmatter ?? {},
        tags,
        noteKind: input.noteKind ?? 'note',
        noteDate: input.noteDate ?? null,
        createdByAgentId: input.createdByAgentId ?? null,
      });
      created = true;
      if (scope.kind === 'space') {
        await insertRevision({
          noteId: note.id,
          workspaceId: scope.workspaceId,
          body,
          bodySha256: bodySha,
          authors: [scope.userId],
          onBehalfOfUserId: input.onBehalfOfUserId ?? null,
          origin: 'external',
        });
      }
    }

    // A ticked or unticked line made a to-do: the to-do follows (never fails the save).
    if (existing && !input.skipTaskSync && existing.body !== body) {
      const { reconcileNoteTasks } = await import('@/core/tasks/note-links');
      await reconcileNoteTasks(scope, note.id, existing.body, body);
    }

    const links = await this.relink(scope, note, parsed, tags, input.createdByAgentId ?? null);

    // 3. Re-index (degrades loudly if no embedding model).
    if (input.deferIndex) {
      this.scheduleReindex(note);
      return { note: this.withLive(scope, note), created, indexed: false, indexQueued: true, links, merged };
    }
    this.cancelScheduledReindex(note.id);
    const indexed = await this.reindex(note);

    return { note: this.withLive(scope, note), created, indexed, links, merged };
  }

  /** Deferred re-indexes by note id (`deferIndex`): one pending timer per note. */
  private readonly pendingIndex = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Re-index the note once it has been quiet for `INDEX_DEBOUNCE_MS`, from
   * the row as it is then (later saves restart the wait). In-process: a
   * restart inside the window leaves the earlier chunks until the next save.
   */
  private scheduleReindex(note: Note): void {
    this.cancelScheduledReindex(note.id);
    const timer = setTimeout(() => {
      this.pendingIndex.delete(note.id);
      this.notes.getById(note.userId, note.id)
        .then(async (row) => {
          const current = row
            ?? (note.workspaceId ? await this.notes.getById({ kind: 'space', workspaceId: note.workspaceId, userId: note.userId, role: 'editor', archived: false }, note.id) : null);
          if (current) await this.reindex(current);
        })
        .catch((err: unknown) => coreLogger.warn({ err, component: 'notes', noteId: note.id }, 'Deferred re-index of a note failed; it is searchable by its earlier text until the next save'));
    }, INDEX_DEBOUNCE_MS);
    timer.unref?.();
    this.pendingIndex.set(note.id, timer);
  }

  private cancelScheduledReindex(noteId: string): void {
    const timer = this.pendingIndex.get(noteId);
    if (timer) clearTimeout(timer);
    this.pendingIndex.delete(noteId);
  }

  /** Step 2 of `save`: sync the note's `[[links]]` and `#tags` edges, bind ghosts. */
  private async relink(
    scope: NoteScope,
    note: Note,
    parsed: ReturnType<typeof parseLinks>,
    tags: string[],
    createdByAgentId: string | null,
  ): Promise<{ added: number; removed: number }> {
    // 2. Re-link.
    // Edges carry the note's own scope: updating a user-level note from a
    // workspace must not file its links under that workspace. They belong to
    // the note's author, so another member editing a space note keeps
    // one edge set.
    const linkCounts = await this.links.syncWikilinks({
      userId: note.userId,
      workspaceId: note.workspaceId ?? null,
      fromType: SOURCE_PREFIX,
      fromId: note.id,
      wikilinks: parsed.wikilinks,
      tags,
      createdByAgentId,
    });
    // Resolve ghost edges that referenced this note's slug (INCOMING: other
    // notes that linked to this one before it existed).
    await this.links.resolveTo({ scope, toRef: note.slug, toType: SOURCE_PREFIX, toId: note.id });

    // Resolve THIS note's OUTGOING wikilinks against notes that ALREADY exist.
    // syncWikilinks always inserts edges as ghosts (to_id NULL) and the
    // incoming-resolve above only binds edges pointing AT this note — so
    // linking A→B when B already exists left the A→B edge unresolved until B
    // was next saved, and the graph drew no line between two freshly-linked
    // notes (the QA bug). Bind each outgoing ref whose slug matches an
    // existing note now.
    const outgoingRefs = [...new Set(parsed.wikilinks.map((w) => w.ref))];
    for (const ref of outgoingRefs) {
      if (ref === note.slug) continue; // a self-link has nothing to bind
      // A link to a slug a note was moved away from still means that note.
      const target = await this.store(scope).resolveSlug(ref);
      if (target) {
        await this.links.resolveTo({ scope, toRef: ref, toType: SOURCE_PREFIX, toId: target.id });
      }
    }

    // Refs with no note of that exact slug get one similarity guess (see
    // `link-resolver.ts`). Never throws: an unresolved link is a worse graph,
    // a failed save is a lost note.
    try {
      await this.resolver.resolveGhostRefs({
        scope,
        noteId: note.id,
        wikilinks: parsed.wikilinks.filter((w) => w.ref !== note.slug),
      });
    } catch (err) {
      coreLogger.warn({ err, component: 'notes', noteId: note.id }, 'Ghost-link resolution pass failed — links left unresolved');
    }
    return linkCounts;
  }

  /**
   * Write a space note's body (§7.3): through the hub when the note is open,
   * else one conditional update on its sha — both under the note's mutex —
   * with a revision. `base` is what the writer read; its change is merged
   * into the current text (diff3), or the write is refused as stale.
   * Throws `StaleWriteError`, `NoteTooLargeError`, and `SpaceError` for a
   * role that may not write.
   */
  async writeSpaceBody(scope: SpaceScope, noteId: string, input: SpaceBodyWrite): Promise<SpaceBodyWriteResult> {
    assertNoteAccess(scope, 'write');
    const write = { ...input, next: normalizeNewlines(input.next) };
    assertSpaceNoteSize(write.next);
    const store = this.store(scope);
    const hub = this.hub();
    const meta = {
      ...(write.title !== undefined ? { title: write.title } : {}),
      ...(write.tags !== undefined ? { tags: write.tags } : {}),
    };
    const hasMeta = Object.keys(meta).length > 0;
    return hub.exclusive(noteId, async (open) => {
      const row = await store.getById(noteId);
      if (!row) throw new Error(`Note ${noteId} not found for this user`);
      if (open) {
        const result = await hub.applyExternalLocked(noteId, write.base, write.next, write.origin);
        const note = hasMeta ? await store.update(noteId, meta) : await store.getById(noteId);
        if (!note) throw new Error(`Note ${noteId} vanished during update`);
        return { note: { ...note, body: result.text, bodySha256: result.sha256 }, changed: result.changed, merged: result.merged, revisionId: result.revisionId };
      }
      const baseText = write.base.text !== undefined && sha256Hex(write.base.text) === write.base.sha256
        ? write.base.text
        : write.base.sha256 === row.bodySha256 ? row.body : null;
      if (baseText === null) throw new StaleWriteError('unknown_base', row.bodySha256);
      // A stored body from before line endings were normalized merges as `\n`.
      const result = merge3(normalizeNewlines(baseText), normalizeNewlines(row.body), write.next);
      if (!result.ok) throw new StaleWriteError('conflict', row.bodySha256);
      assertSpaceNoteSize(result.text);
      if (result.text === row.body) {
        const note = hasMeta ? await store.update(noteId, meta) : row;
        return { note: note ?? row, changed: false, merged: result.text !== write.next, revisionId: null };
      }
      const sha = sha256Hex(result.text);
      const note = await writeBodyIfUnchanged(noteId, scope.workspaceId, row.bodySha256, result.text, sha, meta);
      // Every writer of this note holds the mutex; a miss is a write from
      // outside this process (or the row's deletion).
      if (!note) throw new StaleWriteError('unknown_base', row.bodySha256);
      const revision = await insertRevision({
        noteId,
        workspaceId: scope.workspaceId,
        body: result.text,
        bodySha256: sha,
        authors: [write.origin.userId],
        onBehalfOfUserId: write.origin.onBehalfOfUserId ?? null,
        origin: write.origin.kind === 'peer' ? 'external' : write.origin.kind,
        restoredFrom: write.origin.restoredFrom ?? null,
      });
      return { note, changed: true, merged: result.text !== write.next, revisionId: revision.id };
    });
  }

  /**
   * Refresh the links, tags and search index of a live space note from its
   * stored body (the hub calls it on last leave and every
   * `spaces.docReindexMinutes`). Embedding calls are billed
   * `funding: 'install'` to `editorUserId`, the space's last editor.
   *
   * Tags that did not come from the body — explicit ones from a save, a
   * meeting's `meeting` / `source/…` — are kept: only the `#tags` of
   * `previousBody` (the body the tags were last derived from) are replaced
   * by the current body's. Returns the body indexed, null when the note is
   * gone.
   */
  async refreshSpaceNote(noteId: string, editorUserId: string, previousBody?: string): Promise<string | null> {
    const row = await loadSpaceNote(noteId);
    if (!row) return null;
    // A system refresh of the space's own note: the scope reads the space
    // and writes only the note's derived tags.
    const scope: SpaceScope = { kind: 'space', workspaceId: row.workspaceId, userId: editorUserId, role: 'editor', archived: false };
    const note = await this.notes.getById(scope, noteId);
    if (!note) return null;
    const parsed = parseLinks(stripFrontmatter(note.body));
    const previousBodyTags = new Set(previousBody === undefined ? [] : parseLinks(stripFrontmatter(previousBody)).tags);
    const tags = [...new Set([...note.tags.filter((tag) => !previousBodyTags.has(tag)), ...parsed.tags])];
    const current = (await this.notes.update(scope, noteId, { tags })) ?? note;
    // Lines ticked by typing in the live text since the last refresh: their to-dos follow.
    if (previousBody !== undefined && previousBody !== note.body) {
      const { reconcileNoteTasks } = await import('@/core/tasks/note-links');
      await reconcileNoteTasks(scope, noteId, previousBody, note.body);
    }
    await withProviderUsageContext(
      { userId: editorUserId, workspaceId: row.workspaceId, funding: 'install', accountingMetadata: { noteId, purpose: 'live-note-reindex' } },
      async () => {
        await this.relink(scope, current, parsed, tags, null);
        await this.reindex(current);
      },
    );
    return note.body;
  }

  /** A space note read while it is open shows the live text and its sha. */
  private withLive(scope: NoteScope, note: Note): Note {
    if (scope.kind !== 'space') return note;
    const live = this.hub().readLive(note.id);
    return live ? { ...note, body: live.text, bodySha256: live.sha256 } : note;
  }

  /**
   * Remove the note's chunks under every note purpose, so a note whose kind
   * changed (a note made a lesson, or back) keeps no rows under the old one.
   */
  private async deleteChunks(note: Note): Promise<void> {
    for (const purpose of NOTE_PURPOSES) await this.embeddings.deleteBySource(noteOwner(note), purpose, sourceIdFor(note.id));
  }

  /** Replace the note's embedding chunks, under the purpose of its kind. Throws on failure. */
  private async indexChunks(note: Note): Promise<void> {
    await this.deleteChunks(note);
    if (note.body.trim().length === 0) return;
    await this.embeddings.indexText(noteOwner(note), notePurposeFor(note.noteKind), sourceIdFor(note.id), note.body, {
      title: note.title,
    });
  }

  /**
   * Refresh the note's embedding chunks. Returns false (logged) on failure.
   * Without an embedding model nothing is chunked: the note is recorded for
   * the catch-up that indexes it once a model is configured.
   */
  private async reindex(note: Note): Promise<boolean> {
    if (!(await capabilityConfigured('embedding'))) {
      // The earlier body's chunks go now (deleting needs no model), so a
      // keyword search never serves text the note no longer has.
      await this.deleteChunks(note)
        .catch((err: unknown) => coreLogger.warn({ err, noteId: note.id }, 'Could not remove the earlier chunks of an edited note'));
      if (note.body.trim().length === 0) return true;
      await recordSkipped({ kind: 'note', sourceId: note.id, ownerUserId: note.userId, workspaceId: note.workspaceId ?? null })
        .catch((err: unknown) => coreLogger.warn({ err, noteId: note.id }, 'Could not record the note for catch-up indexing'));
      return false;
    }
    try {
      await this.indexChunks(note);
      return true;
    } catch (err) {
      coreLogger.warn(
        { err, component: 'notes', noteId: note.id },
        'Note saved and linked, but re-index failed (no embedding model?) — note will not appear in semantic search until re-indexed',
      );
      return false;
    }
  }

  /**
   * The catch-up (src/core/rag/index-backlog.ts): index a note saved while no
   * embedding model was configured. False when the note no longer exists.
   * Throws when indexing fails, so the catch-up keeps the item for a retry.
   */
  async reindexById(noteId: string, ownerUserId: string, workspaceId: string | null): Promise<boolean> {
    // Through the scoped repository, as the backlog row's owner: their own
    // note, or the note of the space it was saved in.
    const repo = this.notes;
    const note = (await repo.getById(ownerUserId, noteId))
      ?? (workspaceId
        ? await repo.getById({ kind: 'space', workspaceId, userId: ownerUserId, role: 'editor', archived: false }, noteId)
        : null);
    if (!note) return false;
    await this.indexChunks(note);
    return true;
  }

  async getById(scope: NoteScope, id: string): Promise<Note | null> {
    const note = await this.store(scope).getById(id);
    return note ? this.withLive(scope, note) : null;
  }

  async getBySlug(scope: NoteScope, slug: string): Promise<Note | null> {
    const note = await this.store(scope).getBySlug(slugify(slug));
    return note ? this.withLive(scope, note) : null;
  }

  /**
   * The note a `[[link]]` to `slug` means: the note at that slug, else one
   * moved away from it (`move`). `getBySlug` matches the slug alone.
   */
  async resolveSlug(scope: NoteScope, slug: string): Promise<Note | null> {
    const note = await this.store(scope).resolveSlug(slugify(slug));
    return note ? this.withLive(scope, note) : null;
  }

  /**
   * Move a note to another slug: another folder (`projects/plan`), or
   * another name in its folder. The id, text and title stay; the old slug
   * is kept in `frontmatter.movedFrom` (taken from any other note that held
   * it: one note per moved slug), so every `[[link]]` to it still
   * resolves (`resolveSlug`: the edges already bound keep their target, a
   * link saved later binds through the alias), and links waiting for the
   * new slug bind now. Null when the scope does not reach the note.
   * Throws `NoteExistsError` when another note holds the slug (an archived
   * one included), `InvalidSlugError` for a slug that is empty once
   * normalized, and `SpaceError` for a role that may not write.
   */
  async move(scope: NoteScope, id: string, slugInput: string): Promise<Note | null> {
    assertNoteAccess(scope, 'write');
    const slug = slugify(slugInput);
    if (!slug) throw new InvalidSlugError(slugInput);
    const store = this.store(scope);
    const note = await store.getById(id);
    if (!note) return null;
    if (note.slug === slug) return this.withLive(scope, note);
    const taken = await store.getBySlug(slug);
    if (taken && taken.id !== note.id) throw new NoteExistsError(taken.id, slug);
    const movedFrom = [...new Set([...noteMovedFrom(note.frontmatter), note.slug])].filter((a) => a !== slug);
    const moved = await store.update(note.id, { slug, frontmatter: { ...note.frontmatter, [MOVED_FROM]: movedFrom } });
    if (!moved) throw new Error(`Note ${note.id} vanished during move`);
    // One note holds a moved slug: this one now holds the slug it left, and
    // the slug it took is its own (an old link to either means this note).
    await store.releaseMovedFrom(note.slug, note.id);
    await store.releaseMovedFrom(slug, note.id);
    await this.links.resolveTo({ scope, toRef: slug, toType: SOURCE_PREFIX, toId: note.id });
    return this.withLive(scope, moved);
  }

  async list(scope: NoteScope, opts?: Parameters<NoteStore['list']>[0]): Promise<Note[]> {
    return this.store(scope).list(opts);
  }

  /** Backlinks for a note (resolved + ghost), by its slug. */
  async backlinks(scope: NoteScope, noteId: string): Promise<Awaited<ReturnType<KnowledgeLinkRepository['getBacklinks']>>> {
    return this.links.getBacklinks(scope, SOURCE_PREFIX, noteId);
  }

  /**
   * Get (or lazily create) the daily note for a calendar day. Slug is
   * `daily/YYYY-MM-DD`; created from a minimal template on first access.
   * With a workspace, the workspace's daily note is used, else an
   * existing user-level one (`getBySlug`'s fallback) — a new one is only
   * created when neither exists. In a space, the space's daily note.
   */
  async getOrCreateDaily(scope: NoteScope, day: string): Promise<Note> {
    const date = normalizeDay(day);
    const slug = `daily/${date}`;
    const existing = await this.store(scope).getBySlug(slug);
    if (existing) return existing;
    try {
      const result = await this.save({
        scope,
        slug,
        title: date,
        body: dailyTemplate(date),
        noteKind: 'daily',
        noteDate: date,
        // Created only while the day has no note: one written meanwhile (another
        // tab, a capture) is never replaced by the template.
        createOnly: true,
      });
      return result.note;
    } catch (err) {
      if (!(err instanceof NoteExistsError)) throw err;
      const found = await this.store(scope).getById(err.noteId);
      if (!found) throw new Error(`Daily note ${slug} vanished while opening it`);
      return found;
    }
  }

  /**
   * Quick capture — append a timestamped bullet to today's daily note.
   * The capture/journal surface; goes through the same save pipeline so
   * links/tags in the captured text are wired immediately. In a space, a
   * day without a note gets one created with the line in it (one write: a
   * refused line leaves no new note behind); with `createOnly` an existing
   * daily note is left as it is (`NoteExistsError`).
   */
  async capture(scope: NoteScope, text: string, day?: string, opts: { createOnly?: boolean } = {}): Promise<Note> {
    const date = normalizeDay(day ?? new Date().toISOString());
    const time = new Date().toISOString().slice(11, 16);
    if (scope.kind === 'space') {
      assertNoteAccess(scope, 'write');
      const slug = `daily/${date}`;
      let found = await this.store(scope).getBySlug(slug);
      if (!found) {
        try {
          const created = await this.save({
            scope, slug, title: date, body: `${dailyTemplate(date).replace(/\s+$/, '')}\n- ${time} ${text}\n`,
            noteKind: 'daily', noteDate: date, createOnly: true,
          });
          return created.note;
        } catch (err) {
          // Someone created the day's note meanwhile: the line goes into it.
          if (!(err instanceof NoteExistsError) || opts.createOnly) throw err;
          found = await this.store(scope).getById(err.noteId);
          if (!found) throw new Error(`Daily note ${slug} vanished while capturing`);
        }
      } else if (opts.createOnly) {
        throw new NoteExistsError(found.id, slug);
      }
      // An open daily note: appended at the end of the live text, which
      // never conflicts with someone typing there (a merge would).
      const opened = found;
      const hub = this.hub();
      const line = `- ${time} ${text}\n`;
      const appended = await hub.exclusive(opened.id, (open) => (open
        ? hub.appendLocked(opened.id, (current) => (current === '' || current.endsWith('\n') ? line : `\n${line}`), { kind: 'external', userId: scope.userId })
        : Promise.resolve(null)));
      if (appended) return { ...opened, body: appended.text, bodySha256: appended.sha256 };
    }
    const daily = this.withLive(scope, await this.getOrCreateDaily(scope, date));
    const body = `${daily.body.replace(/\s+$/, '')}\n- ${time} ${text}\n`;
    // Based on the text just read: a space note's capture merges with
    // whatever members typed meanwhile.
    const result = await this.save({
      scope, id: daily.id, title: daily.title, body, noteKind: 'daily', noteDate: date,
      baseSha256: daily.bodySha256, baseBody: daily.body,
    });
    return result.note;
  }

  /**
   * Hard delete — clean up the note's embeddings and edges first
   * (polymorphic, so no FK cascade), then drop the row. For soft delete
   * use `archive`.
   */
  async remove(scope: NoteScope, id: string): Promise<boolean> {
    assertNoteAccess(scope, 'write');
    const store = this.store(scope);
    const note = await store.getById(id);
    if (!note) return false;
    if (scope.kind === 'space') await this.hub().closeNote(id, 'deleted');
    await this.deleteChunks(note);
    await this.links.deleteForEntity(SOURCE_PREFIX, id);
    return store.delete(id);
  }

  /**
   * Undo `archive`: the note is active again, and its chunks (kept while it
   * was archived, only hidden from search) are found again. False when the
   * scope does not reach the note.
   */
  async restore(scope: NoteScope, id: string): Promise<boolean> {
    assertNoteAccess(scope, 'write');
    const store = this.store(scope);
    const note = await store.getById(id);
    if (!note) return false;
    // Already active: nothing to undo (and nothing rewritten).
    if (!note.archivedAt) return true;
    return store.unarchive(id);
  }

  /**
   * Soft delete. An open space note's pending edits are saved first (under
   * its mutex) and its editors are told it was archived: an archive never
   * drops what someone typed. With `baseSha256` (an accepted archive
   * proposal) a space note is archived only while its text is still that
   * one: false otherwise, and nothing changes.
   */
  async archive(scope: NoteScope, id: string, opts: { baseSha256?: string } = {}): Promise<boolean> {
    if (scope.kind !== 'space') return this.store(scope).archive(id);
    assertNoteAccess(scope, 'write');
    const hub = this.hub();
    const archived = await hub.exclusive(id, async (open) => {
      if (open) await hub.flushLocked(id);
      if (opts.baseSha256 !== undefined && (await this.store(scope).getById(id))?.bodySha256 !== opts.baseSha256) return false;
      return this.store(scope).archive(id);
    });
    if (archived) await hub.closeNote(id, 'archived');
    return archived;
  }
}

/**
 * Coerce a date-ish string to `YYYY-MM-DD`.
 *
 * NOTE: this is UTC. A capture made late in the day in a UTC− timezone
 * lands on the next day's daily note. Timezone is not yet plumbed from
 * the channel/browser; callers that need local-day behaviour should pass
 * an explicit `day` derived in the user's timezone. Tracked for Tier 3.
 */
export function normalizeDay(day: string): string {
  // A calendar day as written must exist: `2026-02-31` is refused, not rolled into March.
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (ymd) {
    const [y, m, dd] = [Number(ymd[1]), Number(ymd[2]), Number(ymd[3])];
    const check = new Date(Date.UTC(y, m - 1, dd));
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== dd) throw new Error(`Invalid date for daily note: ${day}`);
    return day;
  }
  const d = new Date(day);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date for daily note: ${day}`);
  return d.toISOString().slice(0, 10);
}

let _instance: NoteService | null = null;
export function getNoteService(): NoteService {
  if (!_instance) _instance = new NoteService();
  return _instance;
}
