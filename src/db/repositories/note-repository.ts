import { and, desc, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import { getDb } from '../postgres';
import { type NewNote, type Note, notes } from '../schema/notes';

/** The personal workspace rule, or no condition when no workspace is given. */
function inWorkspace(workspaceId: string | undefined): SQL | undefined {
  return workspaceId === undefined ? undefined : sql`(${notes.workspaceId} = ${workspaceId} OR ${notes.workspaceId} IS NULL)`;
}

/**
 * Knowledge-graph Tier 2 — CRUD for `notes`. The link/index side-effects
 * live in `NoteService` (src/core/knowledge/notes.ts); this repository is
 * pure persistence. All reads are tenant-scoped by `userId`.
 *
 * Methods taking an optional `workspaceId` apply the personal workspace
 * rule when it is given: rows of that workspace plus user-level rows
 * (`workspace_id IS NULL`). The note routes always pass the principal's
 * workspace; callers that omit it read across the user's workspaces.
 */
export class NoteRepository {
  private get db() {
    return getDb();
  }

  async create(record: Omit<NewNote, 'id' | 'createdAt' | 'updatedAt'>): Promise<Note> {
    const result = await this.db.insert(notes).values(record).returning();
    if (!result[0]) throw new Error('notes insert returned no row');
    return result[0];
  }

  async update(
    userId: string,
    id: string,
    patch: Partial<Omit<NewNote, 'id' | 'userId' | 'createdAt'>>,
  ): Promise<Note | null> {
    const result = await this.db
      .update(notes)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(notes.id, id), eq(notes.userId, userId)))
      .returning();
    return result[0] ?? null;
  }

  async getById(userId: string, id: string, workspaceId?: string): Promise<Note | null> {
    const rows = await this.db
      .select()
      .from(notes)
      .where(and(eq(notes.id, id), eq(notes.userId, userId), inWorkspace(workspaceId)))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Batch fetch by ids, tenant-scoped. Used by the canvas builder to avoid N+1. */
  async getByIds(userId: string, ids: string[], workspaceId?: string): Promise<Note[]> {
    if (ids.length === 0) return [];
    return this.db
      .select()
      .from(notes)
      .where(and(eq(notes.userId, userId), inArray(notes.id, ids), inWorkspace(workspaceId)));
  }

  /**
   * A slug names one note per scope. With a workspace, the workspace's
   * note wins and a user-level note of that slug is the fallback — so a
   * daily note written before workspaces were wired is found, not
   * duplicated. With `null`, only user-level notes match.
   */
  async getBySlug(userId: string, workspaceId: string | null, slug: string): Promise<Note | null> {
    const rows = await this.db
      .select()
      .from(notes)
      .where(
        and(
          eq(notes.userId, userId),
          workspaceId === null ? isNull(notes.workspaceId) : inWorkspace(workspaceId),
          eq(notes.slug, slug),
        ),
      )
      .orderBy(sql`${notes.workspaceId} IS NULL`)
      .limit(1);
    return rows[0] ?? null;
  }

  async list(
    userId: string,
    opts: { kind?: string; tag?: string; includeArchived?: boolean; limit?: number; offset?: number; workspaceId?: string } = {},
  ): Promise<Note[]> {
    const conditions = [eq(notes.userId, userId), inWorkspace(opts.workspaceId)];
    if (opts.kind) conditions.push(eq(notes.noteKind, opts.kind));
    if (opts.tag) conditions.push(sql`${opts.tag} = ANY(${notes.tags})`);
    if (!opts.includeArchived) conditions.push(isNull(notes.archivedAt));
    return this.db
      .select()
      .from(notes)
      .where(and(...conditions))
      .orderBy(desc(notes.updatedAt))
      .limit(opts.limit ?? 50)
      .offset(opts.offset ?? 0);
  }

  /**
   * Bases-style property query — filter notes by kind, tag, and
   * frontmatter property equality, with a chosen sort. Tenant-scoped.
   * The filter stays structured (field/op/value), not a query DSL.
   */
  async query(
    userId: string,
    opts: {
      kind?: string;
      tag?: string;
      frontmatter?: Record<string, unknown>;
      sort?: 'updated' | 'created' | 'title' | 'date';
      order?: 'asc' | 'desc';
      includeArchived?: boolean;
      limit?: number;
      workspaceId?: string;
    } = {},
  ): Promise<Note[]> {
    const conditions = [eq(notes.userId, userId), inWorkspace(opts.workspaceId)];
    if (opts.kind) conditions.push(eq(notes.noteKind, opts.kind));
    if (opts.tag) conditions.push(sql`${opts.tag} = ANY(${notes.tags})`);
    if (opts.frontmatter && Object.keys(opts.frontmatter).length > 0) {
      conditions.push(sql`${notes.frontmatter} @> ${JSON.stringify(opts.frontmatter)}::jsonb`);
    }
    if (!opts.includeArchived) conditions.push(isNull(notes.archivedAt));
    const col = opts.sort === 'created' ? notes.createdAt
      : opts.sort === 'title' ? notes.title
      : opts.sort === 'date' ? notes.noteDate
      : notes.updatedAt;
    const dir = opts.order === 'asc' ? sql`asc` : sql`desc`;
    return this.db
      .select()
      .from(notes)
      .where(and(...conditions))
      .orderBy(sql`${col} ${dir}`)
      .limit(opts.limit ?? 100);
  }

  /**
   * Lightweight title/slug index for the active notes — the data source
   * for the `[[wikilink]]` autocomplete. Only the columns the picker needs,
   * so it stays cheap to refetch as the vault grows.
   */
  async listIndex(userId: string, workspaceId?: string): Promise<Array<{ id: string; title: string; slug: string; noteKind: string }>> {
    return this.db
      .select({ id: notes.id, title: notes.title, slug: notes.slug, noteKind: notes.noteKind })
      .from(notes)
      .where(and(eq(notes.userId, userId), isNull(notes.archivedAt), inWorkspace(workspaceId)))
      .orderBy(notes.title)
      .limit(2000);
  }

  /**
   * Tag → count across the user's active notes — powers the tag tree and
   * the `#tag` autocomplete (so we suggest existing tags and stop spawning
   * near-duplicate spellings). Aggregated in app code rather than via
   * `unnest`/`GROUP BY` so it behaves identically on Postgres and the
   * embedded PGlite driver. Vaults are bounded, so this is cheap.
   */
  async tagCounts(userId: string, workspaceId?: string): Promise<Array<{ tag: string; count: number }>> {
    const rows = await this.db
      .select({ tags: notes.tags })
      .from(notes)
      .where(and(eq(notes.userId, userId), isNull(notes.archivedAt), inWorkspace(workspaceId)));
    const counts = new Map<string, number>();
    for (const row of rows) {
      for (const tag of row.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  /** Toggle the pin flag. Returns the updated row (null if not owned). */
  async setPinned(userId: string, id: string, pinned: boolean, workspaceId?: string): Promise<Note | null> {
    const result = await this.db
      .update(notes)
      .set({ pinned, updatedAt: new Date() })
      .where(and(eq(notes.id, id), eq(notes.userId, userId), inWorkspace(workspaceId)))
      .returning();
    return result[0] ?? null;
  }

  /** Soft delete — notes archive, they don't vanish. */
  async archive(userId: string, id: string, workspaceId?: string): Promise<boolean> {
    const result = await this.db
      .update(notes)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(notes.id, id), eq(notes.userId, userId), isNull(notes.archivedAt), inWorkspace(workspaceId)))
      .returning({ id: notes.id });
    return result.length > 0;
  }

  async unarchive(userId: string, id: string): Promise<boolean> {
    const result = await this.db
      .update(notes)
      .set({ archivedAt: null, updatedAt: new Date() })
      .where(and(eq(notes.id, id), eq(notes.userId, userId)))
      .returning({ id: notes.id });
    return result.length > 0;
  }

  /** Hard delete — used by the service after it has cleaned up edges + embeddings. */
  async delete(userId: string, id: string): Promise<boolean> {
    const result = await this.db
      .delete(notes)
      .where(and(eq(notes.id, id), eq(notes.userId, userId)))
      .returning({ id: notes.id });
    return result.length > 0;
  }
}

let _instance: NoteRepository | null = null;
export function getNoteRepository(): NoteRepository {
  if (!_instance) _instance = new NoteRepository();
  return _instance;
}
