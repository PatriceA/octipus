import { and, desc, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import { getDb } from '../postgres';
import { type NewNote, type Note, notes } from '../schema/notes';
import { requireCan, SpaceError, type SpaceAction, type SpaceRole } from '@/security/space-access';
import { notInSharedWorkspace } from './scoped';

/**
 * Where a note (and its links) lives — the knowledge graph's scope
 * (docs/plans/coworking-spec.md §5.5):
 *
 *   - `personal`: the user's notes. `workspaceId` is the caller's workspace:
 *     new notes are created there (`null` = user-level), lookups by id read
 *     across the user's personal workspaces, and a slug names the
 *     workspace's note with a user-level fallback (`null` = user-level only).
 *     Never a space's notes.
 *   - `space`: every member's notes of one shared workspace. `userId` is the
 *     acting member, the author of what they create (D4); it grants nothing.
 *     Built only by the access layer after a membership check (`spaceRepos`).
 *
 * Link resolution runs inside one scope: a personal link never binds to a
 * space note, and a space link never binds to a personal one.
 */
export type NoteScope =
  | { kind: 'personal'; userId: string; workspaceId: string | null }
  | { kind: 'space'; workspaceId: string; userId: string; role: SpaceRole; archived: boolean };

/**
 * Throws `SpaceError` when the scope may not `action` (a space member whose
 * role lacks it, or an archived space for anything but reading); the
 * personal scope may do everything.
 */
export function assertNoteAccess(scope: NoteScope, action: SpaceAction): void {
  if (scope.kind !== 'space') return;
  if (scope.archived && action !== 'read') throw new SpaceError('archived', 'This space is archived');
  requireCan({ workspaceId: scope.workspaceId, userId: scope.userId, role: scope.role, scope: null }, action);
}

/** The personal scope of a user with no workspace narrowing (user-level creates). */
export function personalNoteScope(userId: string, workspaceId: string | null = null): NoteScope {
  return { kind: 'personal', userId, workspaceId };
}

/**
 * The owner condition on `notes` for a raw repository call: a bare user id
 * is that user's personal notes (never a space's, I2); a space scope is the
 * space's notes, whoever wrote them.
 */
function owner(scope: NoteScope | string): SQL[] {
  if (typeof scope !== 'string' && scope.kind === 'space') return [eq(notes.workspaceId, scope.workspaceId)];
  const userId = typeof scope === 'string' ? scope : scope.userId;
  return [eq(notes.userId, userId), notInSharedWorkspace(notes.workspaceId)];
}

/** The personal workspace rule, or no condition when no workspace is given (or in a space). */
function inWorkspace(scope: NoteScope | string, workspaceId: string | undefined): SQL | undefined {
  if (typeof scope !== 'string' && scope.kind === 'space') return undefined;
  return workspaceId === undefined ? undefined : sql`(${notes.workspaceId} = ${workspaceId} OR ${notes.workspaceId} IS NULL)`;
}

/**
 * Knowledge-graph Tier 2 — CRUD for `notes`. The link/index side-effects
 * live in `NoteService` (src/core/knowledge/notes.ts); this repository is
 * pure persistence. Every read is scoped by its first argument: a user id
 * (personal) or a `NoteScope`.
 *
 * Methods taking an optional `workspaceId` apply the personal workspace
 * rule when it is given: rows of that workspace plus user-level rows
 * (`workspace_id IS NULL`). The note routes always pass the principal's
 * workspace; callers that omit it read across the user's workspaces. In a
 * space the workspace is the scope's and the argument is ignored.
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
    scope: NoteScope | string,
    id: string,
    patch: Partial<Omit<NewNote, 'id' | 'userId' | 'createdAt'>>,
  ): Promise<Note | null> {
    // Neither the author nor the workspace changes on an edit.
    const { workspaceId: _ws, ...safe } = patch;
    void _ws;
    const result = await this.db
      .update(notes)
      .set({ ...safe, updatedAt: new Date() })
      .where(and(eq(notes.id, id), ...owner(scope)))
      .returning();
    return result[0] ?? null;
  }

  async getById(scope: NoteScope | string, id: string, workspaceId?: string): Promise<Note | null> {
    const rows = await this.db
      .select()
      .from(notes)
      .where(and(eq(notes.id, id), ...owner(scope), inWorkspace(scope, workspaceId)))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Batch fetch by ids, tenant-scoped. Used by the canvas builder to avoid N+1. */
  async getByIds(scope: NoteScope | string, ids: string[], workspaceId?: string): Promise<Note[]> {
    if (ids.length === 0) return [];
    return this.db
      .select()
      .from(notes)
      .where(and(...owner(scope), inArray(notes.id, ids), inWorkspace(scope, workspaceId)));
  }

  /**
   * A slug names one note per scope. With a workspace, the workspace's
   * note wins and a user-level note of that slug is the fallback — so a
   * daily note written before workspaces were wired is found, not
   * duplicated. With `null`, only user-level notes match. In a space, the
   * space's note of that slug.
   */
  async getBySlug(scope: NoteScope | string, workspaceId: string | null, slug: string): Promise<Note | null> {
    const space = typeof scope !== 'string' && scope.kind === 'space';
    const rows = await this.db
      .select()
      .from(notes)
      .where(
        and(
          ...owner(scope),
          space ? undefined : workspaceId === null ? isNull(notes.workspaceId) : inWorkspace(scope, workspaceId),
          eq(notes.slug, slug),
        ),
      )
      .orderBy(sql`${notes.workspaceId} IS NULL`)
      .limit(1);
    return rows[0] ?? null;
  }

  async list(
    scope: NoteScope | string,
    opts: { kind?: string; tag?: string; includeArchived?: boolean; limit?: number; offset?: number; workspaceId?: string } = {},
  ): Promise<Note[]> {
    const conditions = [...owner(scope), inWorkspace(scope, opts.workspaceId)];
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
    scope: NoteScope | string,
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
    const conditions = [...owner(scope), inWorkspace(scope, opts.workspaceId)];
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
  async listIndex(scope: NoteScope | string, workspaceId?: string): Promise<Array<{ id: string; title: string; slug: string; noteKind: string }>> {
    return this.db
      .select({ id: notes.id, title: notes.title, slug: notes.slug, noteKind: notes.noteKind })
      .from(notes)
      .where(and(...owner(scope), isNull(notes.archivedAt), inWorkspace(scope, workspaceId)))
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
  async tagCounts(scope: NoteScope | string, workspaceId?: string): Promise<Array<{ tag: string; count: number }>> {
    const rows = await this.db
      .select({ tags: notes.tags })
      .from(notes)
      .where(and(...owner(scope), isNull(notes.archivedAt), inWorkspace(scope, workspaceId)));
    const counts = new Map<string, number>();
    for (const row of rows) {
      for (const tag of row.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  /** Toggle the pin flag. Returns the updated row (null if not in scope). */
  async setPinned(scope: NoteScope | string, id: string, pinned: boolean, workspaceId?: string): Promise<Note | null> {
    const result = await this.db
      .update(notes)
      .set({ pinned, updatedAt: new Date() })
      .where(and(eq(notes.id, id), ...owner(scope), inWorkspace(scope, workspaceId)))
      .returning();
    return result[0] ?? null;
  }

  /** Soft delete — notes archive, they don't vanish. */
  async archive(scope: NoteScope | string, id: string, workspaceId?: string): Promise<boolean> {
    const result = await this.db
      .update(notes)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(notes.id, id), ...owner(scope), isNull(notes.archivedAt), inWorkspace(scope, workspaceId)))
      .returning({ id: notes.id });
    return result.length > 0;
  }

  async unarchive(scope: NoteScope | string, id: string): Promise<boolean> {
    const result = await this.db
      .update(notes)
      .set({ archivedAt: null, updatedAt: new Date() })
      .where(and(eq(notes.id, id), ...owner(scope)))
      .returning({ id: notes.id });
    return result.length > 0;
  }

  /** Hard delete — used by the service after it has cleaned up edges + embeddings. */
  async delete(scope: NoteScope | string, id: string): Promise<boolean> {
    const result = await this.db
      .delete(notes)
      .where(and(eq(notes.id, id), ...owner(scope)))
      .returning({ id: notes.id });
    return result.length > 0;
  }
}

/**
 * `NoteRepository` bound to one `NoteScope`: the method set without the
 * scope argument. `PersonalNoteRepo` and `SpaceNoteRepo` are what
 * `contentRepos(principal).notes` hands out; the workspace of every read
 * and write is the scope's, never an argument's.
 */
export interface NoteStore {
  readonly scope: NoteScope;
  create(record: Omit<NewNote, 'id' | 'createdAt' | 'updatedAt' | 'userId' | 'workspaceId'>): Promise<Note>;
  update(id: string, patch: Partial<Omit<NewNote, 'id' | 'userId' | 'workspaceId' | 'createdAt'>>): Promise<Note | null>;
  getById(id: string): Promise<Note | null>;
  getByIds(ids: string[]): Promise<Note[]>;
  getBySlug(slug: string): Promise<Note | null>;
  list(opts?: { kind?: string; tag?: string; includeArchived?: boolean; limit?: number; offset?: number }): Promise<Note[]>;
  query(opts?: Omit<Parameters<NoteRepository['query']>[1], 'workspaceId'>): Promise<Note[]>;
  listIndex(): Promise<Array<{ id: string; title: string; slug: string; noteKind: string }>>;
  tagCounts(): Promise<Array<{ tag: string; count: number }>>;
  setPinned(id: string, pinned: boolean): Promise<Note | null>;
  archive(id: string): Promise<boolean>;
  unarchive(id: string): Promise<boolean>;
  delete(id: string): Promise<boolean>;
}

/** A user's personal notes, in the personal workspace rule of `scope.workspaceId`. */
export class PersonalNoteRepo implements NoteStore {
  readonly scope: NoteScope & { kind: 'personal' };

  constructor(scope: NoteScope & { kind: 'personal' }, private readonly repo: NoteRepository = getNoteRepository()) {
    this.scope = scope;
  }

  private get ws(): string | undefined {
    return this.scope.workspaceId ?? undefined;
  }

  create(record: Omit<NewNote, 'id' | 'createdAt' | 'updatedAt' | 'userId' | 'workspaceId'>): Promise<Note> {
    return this.repo.create({ ...record, userId: this.scope.userId, workspaceId: this.scope.workspaceId });
  }
  update(id: string, patch: Partial<Omit<NewNote, 'id' | 'userId' | 'workspaceId' | 'createdAt'>>) { return this.repo.update(this.scope, id, patch); }
  getById(id: string) { return this.repo.getById(this.scope, id, this.ws); }
  getByIds(ids: string[]) { return this.repo.getByIds(this.scope, ids, this.ws); }
  getBySlug(slug: string) { return this.repo.getBySlug(this.scope, this.scope.workspaceId, slug); }
  list(opts: Parameters<NoteStore['list']>[0] = {}) { return this.repo.list(this.scope, { ...opts, workspaceId: this.ws }); }
  query(opts: Parameters<NoteStore['query']>[0] = {}) { return this.repo.query(this.scope, { ...opts, workspaceId: this.ws }); }
  listIndex() { return this.repo.listIndex(this.scope, this.ws); }
  tagCounts() { return this.repo.tagCounts(this.scope, this.ws); }
  setPinned(id: string, pinned: boolean) { return this.repo.setPinned(this.scope, id, pinned, this.ws); }
  archive(id: string) { return this.repo.archive(this.scope, id, this.ws); }
  unarchive(id: string) { return this.repo.unarchive(this.scope, id); }
  delete(id: string) { return this.repo.delete(this.scope, id); }
}

/**
 * The notes of one space (§5.5): every member's, read by any member and
 * written by the roles that may `write` (the store checks it).
 */
export class SpaceNoteRepo implements NoteStore {
  readonly scope: NoteScope & { kind: 'space' };

  constructor(scope: NoteScope & { kind: 'space' }, private readonly repo: NoteRepository = getNoteRepository()) {
    this.scope = scope;
  }

  private write(): void {
    assertNoteAccess(this.scope, 'write');
  }

  async create(record: Omit<NewNote, 'id' | 'createdAt' | 'updatedAt' | 'userId' | 'workspaceId'>): Promise<Note> {
    this.write();
    return this.repo.create({ ...record, userId: this.scope.userId, workspaceId: this.scope.workspaceId });
  }
  async update(id: string, patch: Partial<Omit<NewNote, 'id' | 'userId' | 'workspaceId' | 'createdAt'>>) { this.write(); return this.repo.update(this.scope, id, patch); }
  getById(id: string) { return this.repo.getById(this.scope, id); }
  getByIds(ids: string[]) { return this.repo.getByIds(this.scope, ids); }
  getBySlug(slug: string) { return this.repo.getBySlug(this.scope, this.scope.workspaceId, slug); }
  list(opts: Parameters<NoteStore['list']>[0] = {}) { return this.repo.list(this.scope, opts); }
  query(opts: Parameters<NoteStore['query']>[0] = {}) { return this.repo.query(this.scope, opts); }
  listIndex() { return this.repo.listIndex(this.scope); }
  tagCounts() { return this.repo.tagCounts(this.scope); }
  async setPinned(id: string, pinned: boolean) { this.write(); return this.repo.setPinned(this.scope, id, pinned); }
  async archive(id: string) { this.write(); return this.repo.archive(this.scope, id); }
  async unarchive(id: string) { this.write(); return this.repo.unarchive(this.scope, id); }
  async delete(id: string) { this.write(); return this.repo.delete(this.scope, id); }
}

/** The bound note store of a scope. */
export function noteStoreFor(scope: NoteScope, repo: NoteRepository = getNoteRepository()): NoteStore {
  return scope.kind === 'space' ? new SpaceNoteRepo(scope, repo) : new PersonalNoteRepo(scope, repo);
}

let _instance: NoteRepository | null = null;
export function getNoteRepository(): NoteRepository {
  if (!_instance) _instance = new NoteRepository();
  return _instance;
}
