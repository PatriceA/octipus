import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { getDb } from '../postgres';
import { type NewNote, type Note, notes } from '../schema/notes';

/**
 * Knowledge-graph Tier 2 — CRUD for `notes`. The link/index side-effects
 * live in `NoteService` (src/core/knowledge/notes.ts); this repository is
 * pure persistence. All reads are tenant-scoped by `userId`.
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

  async getById(userId: string, id: string): Promise<Note | null> {
    const rows = await this.db
      .select()
      .from(notes)
      .where(and(eq(notes.id, id), eq(notes.userId, userId)))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Batch fetch by ids, tenant-scoped. Used by the canvas builder to avoid N+1. */
  async getByIds(userId: string, ids: string[]): Promise<Note[]> {
    if (ids.length === 0) return [];
    return this.db
      .select()
      .from(notes)
      .where(and(eq(notes.userId, userId), inArray(notes.id, ids)));
  }

  async getBySlug(userId: string, workspaceId: string | null, slug: string): Promise<Note | null> {
    const rows = await this.db
      .select()
      .from(notes)
      .where(
        and(
          eq(notes.userId, userId),
          workspaceId === null ? isNull(notes.workspaceId) : eq(notes.workspaceId, workspaceId),
          eq(notes.slug, slug),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async list(
    userId: string,
    opts: { kind?: string; tag?: string; includeArchived?: boolean; limit?: number; offset?: number } = {},
  ): Promise<Note[]> {
    const conditions = [eq(notes.userId, userId)];
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
    } = {},
  ): Promise<Note[]> {
    const conditions = [eq(notes.userId, userId)];
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

  /** Soft delete — notes archive, they don't vanish. */
  async archive(userId: string, id: string): Promise<boolean> {
    const result = await this.db
      .update(notes)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(notes.id, id), eq(notes.userId, userId), isNull(notes.archivedAt)))
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
