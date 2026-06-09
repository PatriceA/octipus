import { getKnowledgeLinkRepository, type KnowledgeLinkRepository } from '@/db/repositories/knowledge-link-repository';
import { getNoteRepository, type NoteRepository } from '@/db/repositories/note-repository';
import type { Note } from '@/db/schema/notes';
import { coreLogger } from '@/utils/logger';
import { type EmbeddingService, getEmbeddingService, sha256Hex } from '@/core/rag/embeddings';
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
 *      and resolve any ghost edges that pointed at this note's slug;
 *   3. re-index — chunk the body into `embeddings` (`purpose='note'`).
 *
 * Re-index degradation: indexing needs an embedding model. If none is
 * configured the note + its links are still saved (they don't depend on
 * embeddings); the failure is logged loudly and surfaced as
 * `indexed:false` rather than swallowed or allowed to lose the note.
 */

const SOURCE_PREFIX = 'note';
const sourceIdFor = (id: string) => `${SOURCE_PREFIX}:${id}`;

export interface SaveNoteInput {
  userId: string;
  workspaceId?: string | null;
  /** Update target. Omit to create (slug derived from `slug` or `title`). */
  id?: string;
  slug?: string;
  title: string;
  body?: string;
  noteKind?: string;
  noteDate?: string | null;
  frontmatter?: Record<string, unknown>;
  /** Explicit tags, unioned with `#tags` parsed from the body. */
  tags?: string[];
  createdByAgentId?: string | null;
}

export interface SaveNoteResult {
  note: Note;
  created: boolean;
  /** False when the body changed but re-indexing was skipped/failed (logged). */
  indexed: boolean;
  links: { added: number; removed: number };
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
  ) {}

  async save(input: SaveNoteInput): Promise<SaveNoteResult> {
    const { userId, title } = input;
    const workspaceId = input.workspaceId ?? null;
    const body = input.body ?? '';
    const bodySha = sha256Hex(body);

    // Resolve the existing row (by id, else by derived slug). On create,
    // the slug comes from an explicit `slug` or is derived from the title.
    const desiredSlug = input.slug ? slugify(input.slug) : input.id ? null : slugify(title);
    let existing: Note | null = null;
    if (input.id) {
      existing = await this.notes.getById(userId, input.id);
      if (!existing) throw new Error(`Note ${input.id} not found for this user`);
    } else if (desiredSlug) {
      existing = await this.notes.getBySlug(userId, workspaceId, desiredSlug);
    }

    const parsed = parseLinks(stripFrontmatter(body));
    const tags = [...new Set([...(input.tags ?? []), ...parsed.tags])];

    // Upsert the row.
    let note: Note;
    let created: boolean;
    if (existing) {
      const bodyUnchanged = existing.bodySha256 === bodySha;
      const updated = await this.notes.update(userId, existing.id, {
        title,
        body,
        bodySha256: bodySha,
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
        const indexed = body.trim().length === 0 || (await this.embeddings.countBySource('note', sourceIdFor(note.id))) > 0;
        return { note, created, indexed, links: { added: 0, removed: 0 } };
      }
    } else {
      note = await this.notes.create({
        userId,
        workspaceId,
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
    }

    // 2. Re-link.
    const linkCounts = await this.links.syncWikilinks({
      userId,
      workspaceId,
      fromType: SOURCE_PREFIX,
      fromId: note.id,
      wikilinks: parsed.wikilinks,
      tags,
      createdByAgentId: input.createdByAgentId ?? null,
    });
    // Resolve ghost edges that referenced this note's slug.
    await this.links.resolveTo({ userId, toRef: note.slug, toType: SOURCE_PREFIX, toId: note.id });

    // 3. Re-index (degrades loudly if no embedding model).
    const indexed = await this.reindex(note);

    return { note, created, indexed, links: linkCounts };
  }

  /** Refresh the note's embedding chunks. Returns false (logged) on failure. */
  private async reindex(note: Note): Promise<boolean> {
    try {
      await this.embeddings.deleteBySource('note', sourceIdFor(note.id));
      if (note.body.trim().length === 0) return true;
      await this.embeddings.indexText('note', sourceIdFor(note.id), note.body, {
        title: note.title,
      }, undefined, note.userId);
      return true;
    } catch (err) {
      coreLogger.warn(
        { err, component: 'notes', noteId: note.id },
        'Note saved and linked, but re-index failed (no embedding model?) — note will not appear in semantic search until re-indexed',
      );
      return false;
    }
  }

  async getById(userId: string, id: string): Promise<Note | null> {
    return this.notes.getById(userId, id);
  }

  async getBySlug(userId: string, workspaceId: string | null, slug: string): Promise<Note | null> {
    return this.notes.getBySlug(userId, workspaceId, slugify(slug));
  }

  async list(userId: string, opts?: Parameters<NoteRepository['list']>[1]): Promise<Note[]> {
    return this.notes.list(userId, opts);
  }

  /** Backlinks for a note (resolved + ghost), by its slug. */
  async backlinks(userId: string, noteId: string): Promise<Awaited<ReturnType<KnowledgeLinkRepository['getBacklinks']>>> {
    return this.links.getBacklinks(userId, SOURCE_PREFIX, noteId);
  }

  /**
   * Get (or lazily create) the daily note for a calendar day. Slug is
   * `daily/YYYY-MM-DD`; created from a minimal template on first access.
   */
  async getOrCreateDaily(userId: string, workspaceId: string | null, day: string): Promise<Note> {
    const date = normalizeDay(day);
    const slug = `daily/${date}`;
    const existing = await this.notes.getBySlug(userId, workspaceId, slug);
    if (existing) return existing;
    const result = await this.save({
      userId,
      workspaceId,
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
  async capture(userId: string, workspaceId: string | null, text: string, day?: string): Promise<Note> {
    const date = normalizeDay(day ?? new Date().toISOString());
    const daily = await this.getOrCreateDaily(userId, workspaceId, date);
    const time = new Date().toISOString().slice(11, 16);
    const body = `${daily.body.replace(/\s+$/, '')}\n- ${time} ${text}\n`;
    const result = await this.save({ userId, workspaceId, id: daily.id, title: daily.title, body, noteKind: 'daily', noteDate: date });
    return result.note;
  }

  /**
   * Hard delete — clean up the note's embeddings and edges first
   * (polymorphic, so no FK cascade), then drop the row. For soft delete
   * use `archive`.
   */
  async remove(userId: string, id: string): Promise<boolean> {
    const note = await this.notes.getById(userId, id);
    if (!note) return false;
    await this.embeddings.deleteBySource('note', sourceIdFor(id));
    await this.links.deleteForEntity(SOURCE_PREFIX, id);
    return this.notes.delete(userId, id);
  }

  async archive(userId: string, id: string): Promise<boolean> {
    return this.notes.archive(userId, id);
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
