import { and, desc, eq, isNull, sql } from 'drizzle-orm';
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
