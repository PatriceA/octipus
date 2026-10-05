import { getConfig } from '@/config';
import { type DocOrigin, type DocumentHub, NoteTooLargeError, StaleWriteError } from '@/core/docs/hub';
import { getDocHub } from '@/core/docs';
import { merge3 } from '@/core/docs/text-merge';
import { getKnowledgeLinkRepository, type KnowledgeLinkRepository } from '@/db/repositories/knowledge-link-repository';
import { insertRevision, loadSpaceNote, writeBodyIfUnchanged } from '@/db/repositories/live-documents';
import { withProviderUsageContext } from '@/models/providers/instrumented';
import { assertNoteAccess, getNoteRepository, type NoteRepository, type NoteScope, noteStoreFor, type NoteStore } from '@/db/repositories/note-repository';
import type { Note } from '@/db/schema/notes';
import { coreLogger } from '@/utils/logger';
import { type EmbeddingService, getEmbeddingService, sha256Hex } from '@/core/rag/embeddings';
import { type KnowledgeOwner, noteKnowledgeScope } from '@/core/rag/knowledge-scope';
import { getLinkResolverService, type LinkResolverService } from './link-resolver';
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
 *   3. re-index — chunk the body into `embeddings` (`purpose='note'`).
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
 * someone's typing. A closed space note is written by one conditional
 * update on its sha, under the same per-note mutex, with a revision. Reads
 * (`getById`, `getBySlug`) return the live text and its sha while the note
 * is open. Space notes hold at most `spaces.noteMaxBytes`.
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
   * as `bodySha256`). Omitted: the note's stored sha. A base the hub no
   * longer knows, or a change in the same place, is refused as stale.
   */
  baseSha256?: string;
  /** Space notes: the body the writer read, when it kept it — merges even after the hub forgot the base. */
  baseBody?: string;
  /** Space notes: the member an agent writes for (revision attribution). */
  onBehalfOfUserId?: string | null;
}

export interface SaveNoteResult {
  note: Note;
  created: boolean;
  /** False when the body changed but re-indexing was skipped/failed (logged). */
  indexed: boolean;
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

const byteLength = (text: string) => Buffer.byteLength(text, 'utf8');

function assertSpaceNoteSize(body: string): void {
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
    assertNoteAccess(scope, 'write');
    const store = this.store(scope);
    let body = input.body ?? '';
    if (scope.kind === 'space') assertSpaceNoteSize(body);
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

    // A space note's body goes through the hub (or the conditional write):
    // what is saved is the writer's change merged into the current text.
    let merged = false;
    let spaceBodyChanged = false;
    if (existing && scope.kind === 'space' && input.body === undefined) {
      body = existing.body;
      bodySha = existing.bodySha256;
    } else if (existing && scope.kind === 'space') {
      const write = await this.writeSpaceBody(scope, existing.id, {
        base: { sha256: input.baseSha256 ?? existing.bodySha256, text: input.baseBody },
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
        frontmatter: input.frontmatter ?? existing.frontmatter,
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
      if (bodyUnchanged) {
        const indexed = body.trim().length === 0 || (await this.embeddings.countBySource(noteKnowledgeScope(scope), 'note', sourceIdFor(note.id))) > 0;
        return { note: this.withLive(scope, note), created, indexed, links: { added: 0, removed: 0 }, merged };
      }
    } else {
      note = await store.create({
        slug: desiredSlug ?? slugify(title),
        title,
        body,
        bodySha256: bodySha,
        frontmatter: input.frontmatter ?? {},
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

    const links = await this.relink(scope, note, parsed, tags, input.createdByAgentId ?? null);

    // 3. Re-index (degrades loudly if no embedding model).
    const indexed = await this.reindex(note);

    return { note: this.withLive(scope, note), created, indexed, links, merged };
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
      const target = await this.store(scope).getBySlug(ref);
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
  async writeSpaceBody(scope: SpaceScope, noteId: string, write: SpaceBodyWrite): Promise<SpaceBodyWriteResult> {
    assertNoteAccess(scope, 'write');
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
      const result = merge3(baseText, row.body, write.next);
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
   */
  async refreshSpaceNote(noteId: string, editorUserId: string): Promise<void> {
    const row = await loadSpaceNote(noteId);
    if (!row) return;
    // A system refresh of the space's own note: the scope reads the space
    // and writes only the note's derived tags.
    const scope: SpaceScope = { kind: 'space', workspaceId: row.workspaceId, userId: editorUserId, role: 'editor', archived: false };
    const note = await this.notes.getById(scope, noteId);
    if (!note) return;
    const parsed = parseLinks(stripFrontmatter(note.body));
    const current = (await this.notes.update(scope, noteId, { tags: parsed.tags })) ?? note;
    await withProviderUsageContext(
      { userId: editorUserId, accountingMetadata: { funding: 'install', workspaceId: row.workspaceId, noteId, purpose: 'live-note-reindex' } },
      async () => {
        await this.relink(scope, current, parsed, parsed.tags, null);
        await this.reindex(current);
      },
    );
  }

  /** A space note read while it is open shows the live text and its sha. */
  private withLive(scope: NoteScope, note: Note): Note {
    if (scope.kind !== 'space') return note;
    const live = this.hub().readLive(note.id);
    return live ? { ...note, body: live.text, bodySha256: live.sha256 } : note;
  }

  /** Refresh the note's embedding chunks. Returns false (logged) on failure. */
  private async reindex(note: Note): Promise<boolean> {
    try {
      const owner = noteOwner(note);
      await this.embeddings.deleteBySource(owner, 'note', sourceIdFor(note.id));
      if (note.body.trim().length === 0) return true;
      await this.embeddings.indexText(owner, 'note', sourceIdFor(note.id), note.body, {
        title: note.title,
      });
      return true;
    } catch (err) {
      coreLogger.warn(
        { err, component: 'notes', noteId: note.id },
        'Note saved and linked, but re-index failed (no embedding model?) — note will not appear in semantic search until re-indexed',
      );
      return false;
    }
  }

  async getById(scope: NoteScope, id: string): Promise<Note | null> {
    const note = await this.store(scope).getById(id);
    return note ? this.withLive(scope, note) : null;
  }

  async getBySlug(scope: NoteScope, slug: string): Promise<Note | null> {
    const note = await this.store(scope).getBySlug(slugify(slug));
    return note ? this.withLive(scope, note) : null;
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
    const result = await this.save({
      scope,
      slug,
      title: date,
      body: `# ${date}\n\n## Notes\n\n## Tasks\n`,
      noteKind: 'daily',
      noteDate: date,
    });
    return result.note;
  }

  /**
   * Quick capture — append a timestamped bullet to today's daily note.
   * The capture/journal surface; goes through the same save pipeline so
   * links/tags in the captured text are wired immediately.
   */
  async capture(scope: NoteScope, text: string, day?: string): Promise<Note> {
    const date = normalizeDay(day ?? new Date().toISOString());
    const daily = this.withLive(scope, await this.getOrCreateDaily(scope, date));
    const time = new Date().toISOString().slice(11, 16);
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
    await this.embeddings.deleteBySource(noteOwner(note), 'note', sourceIdFor(id));
    await this.links.deleteForEntity(SOURCE_PREFIX, id);
    return store.delete(id);
  }

  /**
   * Soft delete. An open space note's pending edits are saved first (under
   * its mutex) and its editors are told it was archived: an archive never
   * drops what someone typed.
   */
  async archive(scope: NoteScope, id: string): Promise<boolean> {
    if (scope.kind !== 'space') return this.store(scope).archive(id);
    assertNoteAccess(scope, 'write');
    const hub = this.hub();
    const archived = await hub.exclusive(id, async (open) => {
      if (open) await hub.flushLocked(id);
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
function normalizeDay(day: string): string {
  const d = new Date(day);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date for daily note: ${day}`);
  return d.toISOString().slice(0, 10);
}

let _instance: NoteService | null = null;
export function getNoteService(): NoteService {
  if (!_instance) _instance = new NoteService();
  return _instance;
}
