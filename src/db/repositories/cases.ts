/**
 * Cases and contacts through one `RepoScope` (docs/CASES.md,
 * docs/plans/coworking-spec.md §5.5), the way `TaskRepo` reaches tasks: every
 * read uses the scope's filter, every write stamps the scope's author and
 * workspace (a caller's `userId` / `workspaceId` is ignored) and checks the
 * scope's `can`. Personally that is the owner and the personal workspace
 * rule; in a space every member's rows, written by editors. A guest reaches
 * no case and no contact (`shared` answers no row for them).
 *
 * Links are rows of `case_links`, keyed by the case: reading or writing them
 * goes through the case's scope first. Whether the linked entity is reachable
 * is checked a layer up (core/cases/links.ts), where every content store of
 * the scope is at hand.
 */
import { and, arrayContains, desc, eq, ilike, inArray, or, type SQL, sql } from 'drizzle-orm';
import { ACTIVE_CASE_STATUSES, closedAtPatch } from '@/core/cases/status';
import type { Principal } from '@/security/principal';
import { SpaceError } from '@/security/space-access';
import { getDb, queryRaw } from '../postgres';
import { type Case, type CaseLink, caseLinks, cases, type NewCase } from '../schema/cases';
import { type Contact, contacts, type NewContact } from '../schema/contacts';
import { isUuid, type RepoScope } from './scoped';

/** `%` and `_` in a search term match themselves, not any character. */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Upper bound of links one case read returns. */
const MAX_LINKS = 500;

/** Where each linkable entity lives, and what makes a row of it live. */
const ENTITY_TABLES: Readonly<Record<string, { name: string; live?: string }>> = {
  contact: { name: 'contacts' },
  document: { name: 'documents' },
  task: { name: 'tasks' },
  note: { name: 'notes' },
  artifact: { name: 'artifacts', live: 'deleted_at IS NULL' },
  record: { name: 'records' },
  mail: { name: 'mail_messages' },
};

/** The row a write stamps: the scope's author, in the scope's workspace. */
async function stampRow(scope: RepoScope): Promise<{ userId: string; workspaceId: string | null }> {
  return { userId: scope.stamp().userId, workspaceId: await scope.writeWorkspace() };
}

// ─────────────────────────────────────────────────────────────────────
// Cases
// ─────────────────────────────────────────────────────────────────────

export interface CaseListFilter {
  status?: string;
  /** Any of these statuses; ignored when `status` is set. */
  statuses?: readonly string[];
  kind?: string;
  assigneeUserId?: string;
  /** Matches title and summary, case-insensitively. */
  q?: string;
  limit?: number;
}

/** A case write: the author, workspace and timestamps are the repository's. */
export type CaseWrite = Omit<NewCase, 'id' | 'userId' | 'workspaceId' | 'createdAt' | 'updatedAt' | 'closedAt'>;

export class CaseRepo {
  constructor(private readonly scope: RepoScope) {}

  private get db() { return getDb(); }

  get principal(): Principal {
    return this.scope.principal;
  }

  /** The scope's filters on `cases`; `byId` lets a personal admin's by-id read skip the owner. */
  private rows(opts?: { byId?: boolean }): SQL[] {
    return this.scope.shared(cases, opts);
  }

  async findById(id: string): Promise<Case | null> {
    if (!isUuid(id)) return null;
    const [row] = await this.db.select().from(cases).where(and(eq(cases.id, id), ...this.rows({ byId: true }))).limit(1);
    return row ?? null;
  }

  /** The scope's cases, active ones first, then most recently changed. */
  async list(filter: CaseListFilter = {}): Promise<Case[]> {
    const filters: SQL[] = [...this.rows()];
    if (filter.status) filters.push(eq(cases.status, filter.status));
    else if (filter.statuses?.length) filters.push(inArray(cases.status, [...filter.statuses]));
    if (filter.kind) filters.push(eq(cases.kind, filter.kind));
    if (filter.assigneeUserId) {
      if (!isUuid(filter.assigneeUserId)) return [];
      filters.push(eq(cases.assigneeUserId, filter.assigneeUserId));
    }
    const q = filter.q?.trim();
    if (q) filters.push(or(ilike(cases.title, likePattern(q)), ilike(cases.summary, likePattern(q))) as SQL);
    const active = sql`CASE WHEN ${inArray(cases.status, [...ACTIVE_CASE_STATUSES])} THEN 0 ELSE 1 END`;
    return this.db
      .select()
      .from(cases)
      .where(and(...filters))
      .orderBy(active, desc(cases.updatedAt))
      .limit(Math.max(1, Math.min(500, filter.limit ?? 200)));
  }

  /**
   * The assignee of a write (§5.5): personally only the owner; in a space a
   * member who is not a guest. Throws with a message fit for a 400.
   */
  private async checkAssignee(assigneeUserId: string | null | undefined, owner: string): Promise<void> {
    if (!assigneeUserId) return;
    if (this.scope.kind === 'space') {
      const { getMembership } = await import('@/core/spaces/service');
      const member = isUuid(assigneeUserId) ? await getMembership(assigneeUserId, this.scope.spaceId as string) : null;
      if (!member || member.role === 'guest') throw new SpaceError('invalid_input', 'The assignee is not a member of this space');
      return;
    }
    if (assigneeUserId !== owner) throw new Error('A personal case can be assigned only to its owner');
  }

  async create(data: CaseWrite): Promise<Case> {
    this.scope.can('write');
    const stamp = await stampRow(this.scope);
    await this.checkAssignee(data.assigneeUserId, stamp.userId);
    const [row] = await this.db
      .insert(cases)
      .values({ ...data, ...stamp, ...closedAtPatch(data.status ?? 'open', false) })
      .returning();
    return row;
  }

  /**
   * Create unless the scope already has a case with `externalKey` — a
   * connector reporting the same matter twice gets the first case back.
   * `created` says whether this call inserted the row.
   */
  async createOnce(data: CaseWrite & { externalKey: string }): Promise<{ case: Case; created: boolean }> {
    this.scope.can('write');
    const stamp = await stampRow(this.scope);
    await this.checkAssignee(data.assigneeUserId, stamp.userId);
    const [created] = await this.db
      .insert(cases)
      .values({ ...data, ...stamp, ...closedAtPatch(data.status ?? 'open', false) })
      .onConflictDoNothing()
      .returning();
    if (created) return { case: created, created: true };
    const [existing] = await this.db
      .select()
      .from(cases)
      .where(and(eq(cases.externalKey, data.externalKey), ...this.rows()))
      .limit(1);
    if (!existing) throw new Error('A case with this external key exists outside this scope');
    return { case: existing, created: false };
  }

  /**
   * Update a case the scope reaches. The author, workspace and external key
   * never change on an edit; `closedAt` follows the status.
   */
  async update(id: string, patch: Partial<CaseWrite>): Promise<Case | null> {
    if (!isUuid(id)) return null;
    this.scope.can('write');
    const current = await this.findById(id);
    if (!current) return null;
    const { externalKey: _key, userId: _user, workspaceId: _ws, ...safe } = patch as Partial<NewCase>;
    void _key;
    void _user;
    void _ws;
    if (safe.assigneeUserId !== undefined) await this.checkAssignee(safe.assigneeUserId, current.userId);
    const [row] = await this.db
      .update(cases)
      .set({ ...safe, ...closedAtPatch(safe.status, current.closedAt !== null), updatedAt: new Date() })
      .where(and(eq(cases.id, id), ...this.rows({ byId: true })))
      .returning();
    return row ?? null;
  }

  /** Delete a case the scope reaches; its links go with it. */
  async delete(id: string): Promise<Case | null> {
    if (!isUuid(id)) return null;
    this.scope.can('write');
    const [row] = await this.db.delete(cases).where(and(eq(cases.id, id), ...this.rows({ byId: true }))).returning();
    return row ?? null;
  }

  /**
   * The links of a case the scope reaches, oldest first; null when the case
   * is not reachable. Pass the case row when this repository has just
   * returned it, to skip reading it again.
   */
  async links(caseRef: string | Case): Promise<CaseLink[] | null> {
    const found = typeof caseRef === 'string' ? await this.findById(caseRef) : caseRef;
    if (!found) return null;
    return this.db.select().from(caseLinks).where(eq(caseLinks.caseId, found.id)).orderBy(caseLinks.createdAt).limit(MAX_LINKS);
  }

  /**
   * Delete the links among `candidates` (links of `caseId`) whose entity row
   * no longer exists. A link the scope cannot resolve may still point at a
   * live row out of the reader's reach (another member's private artifact);
   * only a row that is gone takes its link with it. Existence is read by id
   * alone and nothing of the row is returned.
   */
  async pruneDangling(caseId: string, candidates: readonly CaseLink[]): Promise<number> {
    if (candidates.length === 0) return 0;
    const gone: string[] = [];
    for (const [entityType, table] of Object.entries(ENTITY_TABLES)) {
      const ids = candidates.filter((l) => l.entityType === entityType).map((l) => l.entityId);
      if (ids.length === 0) continue;
      // i2: existence by id only, for links the caller already holds.
      const { rows } = await queryRaw(
        `SELECT id::text AS id FROM ${table.name} WHERE id = ANY($1::uuid[])${table.live ? ` AND ${table.live}` : ''}`,
        [ids],
      );
      const found = new Set((rows as Array<{ id: string }>).map((r) => r.id));
      for (const l of candidates) if (l.entityType === entityType && !found.has(l.entityId)) gone.push(l.id);
    }
    if (gone.length === 0) return 0;
    const removed = await this.db.delete(caseLinks).where(and(eq(caseLinks.caseId, caseId), inArray(caseLinks.id, gone))).returning();
    return removed.length;
  }

  /**
   * Link an entity to a case. The caller has checked that the scope reaches
   * the entity (core/cases/links.ts). Linking the same entity again updates
   * its role. Null when the case is not reachable.
   */
  async addLink(caseId: string, link: { entityType: string; entityId: string; role: string | null }): Promise<CaseLink | null> {
    this.scope.can('write');
    if (!isUuid(link.entityId)) throw new Error(`Not an entity id: ${link.entityId}`);
    if (!(await this.findById(caseId))) return null;
    const [row] = await this.db
      .insert(caseLinks)
      .values({ caseId, entityType: link.entityType, entityId: link.entityId, role: link.role, createdByUserId: this.scope.stamp().userId })
      .onConflictDoUpdate({ target: [caseLinks.caseId, caseLinks.entityType, caseLinks.entityId], set: { role: link.role } })
      .returning();
    await this.touch(caseId);
    return row;
  }

  /** Remove one link of a case the scope reaches. */
  async removeLink(caseId: string, linkId: string): Promise<boolean> {
    if (!isUuid(linkId)) return false;
    this.scope.can('write');
    if (!(await this.findById(caseId))) return false;
    const removed = await this.db.delete(caseLinks).where(and(eq(caseLinks.id, linkId), eq(caseLinks.caseId, caseId))).returning();
    if (removed.length > 0) await this.touch(caseId);
    return removed.length > 0;
  }

  /** The scope's cases an entity is linked to, with the link's role. */
  async casesLinkedTo(entityType: string, entityId: string): Promise<Array<{ case: Case; role: string | null }>> {
    if (!isUuid(entityId)) return [];
    const rows = await this.db
      .select({ case: cases, role: caseLinks.role })
      .from(caseLinks)
      .innerJoin(cases, eq(cases.id, caseLinks.caseId))
      .where(and(eq(caseLinks.entityType, entityType), eq(caseLinks.entityId, entityId), ...this.rows()))
      .orderBy(desc(cases.updatedAt))
      .limit(200);
    return rows;
  }

  private async touch(caseId: string): Promise<void> {
    await this.db.update(cases).set({ updatedAt: new Date() }).where(eq(cases.id, caseId));
  }
}

// ─────────────────────────────────────────────────────────────────────
// Contacts
// ─────────────────────────────────────────────────────────────────────

export interface ContactListFilter {
  kind?: string;
  /** Contacts carrying this tag. */
  tag?: string;
  /** Matches name, email and phone, case-insensitively. */
  q?: string;
  /** People of one organisation. */
  organizationId?: string;
  limit?: number;
}

export type ContactWrite = Omit<NewContact, 'id' | 'userId' | 'workspaceId' | 'createdAt' | 'updatedAt'>;

export class ContactRepo {
  constructor(private readonly scope: RepoScope) {}

  private get db() { return getDb(); }

  private rows(opts?: { byId?: boolean }): SQL[] {
    return this.scope.shared(contacts, opts);
  }

  async findById(id: string): Promise<Contact | null> {
    if (!isUuid(id)) return null;
    const [row] = await this.db.select().from(contacts).where(and(eq(contacts.id, id), ...this.rows({ byId: true }))).limit(1);
    return row ?? null;
  }

  /** The subset of `ids` the scope reaches, with their names. */
  async findByIds(ids: readonly string[]): Promise<Contact[]> {
    const valid = [...new Set(ids.filter(isUuid))];
    if (valid.length === 0) return [];
    return this.db.select().from(contacts).where(and(inArray(contacts.id, valid), ...this.rows({ byId: true })));
  }

  async list(filter: ContactListFilter = {}): Promise<Contact[]> {
    const filters: SQL[] = [...this.rows()];
    if (filter.kind) filters.push(eq(contacts.kind, filter.kind));
    if (filter.tag) filters.push(arrayContains(contacts.tags, [filter.tag.trim().toLowerCase()]));
    if (filter.organizationId) {
      if (!isUuid(filter.organizationId)) return [];
      filters.push(eq(contacts.organizationId, filter.organizationId));
    }
    const q = filter.q?.trim();
    if (q) {
      const p = likePattern(q);
      filters.push(or(ilike(contacts.name, p), ilike(contacts.email, p), ilike(contacts.phone, p)) as SQL);
    }
    return this.db
      .select()
      .from(contacts)
      .where(and(...filters))
      .orderBy(contacts.name)
      .limit(Math.max(1, Math.min(500, filter.limit ?? 200)));
  }

  /** A person's organisation must be an organisation contact of the same scope. */
  private async checkOrganization(organizationId: string | null | undefined, selfId?: string): Promise<void> {
    if (!organizationId) return;
    if (organizationId === selfId) throw new Error('A contact cannot belong to itself');
    const org = await this.findById(organizationId);
    if (!org) throw new Error('Organization not found');
    if (org.kind !== 'organization') throw new Error('organizationId must name a contact of kind "organization"');
  }

  async create(data: ContactWrite): Promise<Contact> {
    this.scope.can('write');
    await this.checkOrganization(data.organizationId);
    const [row] = await this.db.insert(contacts).values({ ...data, ...(await stampRow(this.scope)) }).returning();
    return row;
  }

  /** Create unless the scope already has a contact with `externalKey`. */
  async createOnce(data: ContactWrite & { externalKey: string }): Promise<{ contact: Contact; created: boolean }> {
    this.scope.can('write');
    await this.checkOrganization(data.organizationId);
    const [created] = await this.db
      .insert(contacts)
      .values({ ...data, ...(await stampRow(this.scope)) })
      .onConflictDoNothing()
      .returning();
    if (created) return { contact: created, created: true };
    const [existing] = await this.db
      .select()
      .from(contacts)
      .where(and(eq(contacts.externalKey, data.externalKey), ...this.rows()))
      .limit(1);
    if (!existing) throw new Error('A contact with this external key exists outside this scope');
    return { contact: existing, created: false };
  }

  async update(id: string, patch: Partial<ContactWrite>): Promise<Contact | null> {
    if (!isUuid(id)) return null;
    this.scope.can('write');
    const { externalKey: _key, userId: _user, workspaceId: _ws, ...safe } = patch as Partial<NewContact>;
    void _key;
    void _user;
    void _ws;
    if (safe.organizationId !== undefined) await this.checkOrganization(safe.organizationId, id);
    if (safe.kind !== undefined && safe.kind !== 'organization') {
      // An organisation with members cannot stop being one.
      const [member] = await this.db.select({ id: contacts.id }).from(contacts)
        .where(and(eq(contacts.organizationId, id), ...this.rows())).limit(1);
      if (member) throw new Error('This organization still has people; move them first');
    }
    const [row] = await this.db
      .update(contacts)
      .set({ ...safe, updatedAt: new Date() })
      .where(and(eq(contacts.id, id), ...this.rows({ byId: true })))
      .returning();
    return row ?? null;
  }

  /**
   * Delete a contact the scope reaches. Its people lose the organisation,
   * and the links of cases to it go with it.
   */
  async delete(id: string): Promise<Contact | null> {
    if (!isUuid(id)) return null;
    this.scope.can('write');
    return this.db.transaction(async (tx) => {
      const [row] = await tx.delete(contacts).where(and(eq(contacts.id, id), ...this.rows({ byId: true }))).returning();
      if (!row) return null;
      await tx.update(contacts).set({ organizationId: null, updatedAt: new Date() }).where(eq(contacts.organizationId, id));
      await tx.delete(caseLinks).where(and(eq(caseLinks.entityType, 'contact'), eq(caseLinks.entityId, id)));
      return row;
    });
  }
}
