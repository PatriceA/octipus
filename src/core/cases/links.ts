/**
 * What a case links to (docs/CASES.md), through the content stores of one
 * scope. A link is made only to an entity the scope reaches — a contact,
 * document, task, note or artifact of the same personal scope or space — so
 * a case never points across tenants. Records (docs/RECORDS.md) link the same way. Reads resolve each link through the
 * same stores and drop the ones whose entity is gone or out of reach (a
 * private artifact of another member, a deleted document).
 */
import type { ContentRepos } from '@/db/repositories/content';
import type { MailSummaryRow } from '@/db/repositories/mail';
import type { Case, CaseLink } from '@/db/schema/cases';
import type { Task } from '@/db/schema/tasks';
import { type CaseEntityType, isCaseEntityType, normalizeLabel } from './status';

/** A link with what it points at, as the API and the tool show it. */
export interface ResolvedCaseLink {
  id: string;
  entityType: CaseEntityType;
  entityId: string;
  role: string | null;
  createdAt: Date;
  /** The entity's name or title. */
  label: string;
  /** A short state of the entity: a task's status, a document's category, a contact's kind. */
  detail: string | null;
}

interface EntityView {
  label: string;
  detail: string | null;
}

/** The entity of a link as the scope sees it, or null when it is gone or out of reach. */
export async function resolveEntity(repos: ContentRepos, type: CaseEntityType, id: string): Promise<EntityView | null> {
  switch (type) {
    case 'contact': {
      const row = await repos.contacts.findById(id);
      return row ? { label: row.name, detail: row.kind } : null;
    }
    case 'document': {
      const row = await repos.documents.findById(id);
      return row ? { label: row.originalName, detail: row.category } : null;
    }
    case 'task': {
      const row = await repos.tasks.findById(id);
      return row ? { label: row.title, detail: row.status } : null;
    }
    case 'note': {
      const row = await repos.notes.getById(id);
      return row ? { label: row.title, detail: row.noteKind } : null;
    }
    case 'artifact': {
      const row = await repos.artifacts.findById(id);
      return row ? { label: row.title, detail: null } : null;
    }
    case 'record': {
      const row = await repos.records.findById(id);
      if (!row) return null;
      const type = await repos.recordTypes.findById(row.typeId);
      return { label: row.title ?? type?.name ?? 'Record', detail: type?.key ?? null };
    }
    case 'mail': {
      const [row] = await repos.mail.findByIds([id]);
      return row ? mailView(row) : null;
    }
  }
}

/** A message as a link shows it: its subject, and who it is from or to. */
function mailView(row: MailSummaryRow): EntityView {
  const other = row.status === 'received' ? row.fromAddress : row.toAddresses[0];
  return { label: row.subject || '(no subject)', detail: other ? (other.name ?? other.address) : row.status };
}

export class CaseLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaseLinkError';
  }
}

/**
 * Link `entityId` to a case. Throws `CaseLinkError` when the type is unknown
 * or the scope does not reach the entity; null when the case is not
 * reachable.
 */
export async function linkToCase(
  repos: ContentRepos,
  caseId: string,
  input: { entityType: unknown; entityId: string; role?: unknown },
): Promise<ResolvedCaseLink | null> {
  if (!isCaseEntityType(input.entityType)) throw new CaseLinkError(`Unknown entity type: ${String(input.entityType)}`);
  const entityType = input.entityType;
  const entity = await resolveEntity(repos, entityType, input.entityId);
  if (!entity) throw new CaseLinkError(`${entityType} not found`);
  const link = await repos.cases.addLink(caseId, { entityType, entityId: input.entityId, role: normalizeLabel(input.role) });
  return link ? toResolved(link, entityType, entity) : null;
}

/**
 * The links of a case the scope reaches, resolved; null when the case is not
 * reachable. Pass the case row when the caller has just read it through
 * `repos`. Entities are resolved one query per type where the store has a
 * batch read; links whose entity row is gone are deleted on the way.
 */
export async function caseLinks(repos: ContentRepos, caseRef: string | Case): Promise<ResolvedCaseLink[] | null> {
  const links = await repos.cases.links(caseRef);
  if (!links) return null;
  const views = await resolveEntities(repos, links);
  const resolved: ResolvedCaseLink[] = [];
  const unresolved: CaseLink[] = [];
  for (const link of links) {
    const view = isCaseEntityType(link.entityType) ? views.get(`${link.entityType}:${link.entityId}`) : undefined;
    if (view && isCaseEntityType(link.entityType)) resolved.push(toResolved(link, link.entityType, view));
    else unresolved.push(link);
  }
  // Referential cleanup, not a content write: any reader removes links
  // whose entity row is gone, so dead links never crowd out live ones.
  if (unresolved.length > 0) {
    const caseId = typeof caseRef === 'string' ? caseRef : caseRef.id;
    await repos.cases.pruneDangling(caseId, unresolved);
  }
  return resolved;
}

/** Each linked entity the scope reaches, keyed `type:id`. */
async function resolveEntities(repos: ContentRepos, links: readonly CaseLink[]): Promise<Map<string, EntityView>> {
  const ids = (type: CaseEntityType) => [...new Set(links.filter((l) => l.entityType === type).map((l) => l.entityId))];
  const out = new Map<string, EntityView>();
  const put = (type: CaseEntityType, id: string, view: EntityView) => out.set(`${type}:${id}`, view);
  const contactIds = ids('contact');
  const taskIds = ids('task');
  const noteIds = ids('note');
  const mailIds = ids('mail');
  const [contactRows, taskRows, noteRows, mailRows] = await Promise.all([
    contactIds.length ? repos.contacts.findByIds(contactIds) : [],
    taskIds.length ? repos.tasks.findByIds(taskIds) : [],
    noteIds.length ? repos.notes.getByIds(noteIds) : [],
    mailIds.length ? repos.mail.findByIds(mailIds) : [],
  ]);
  for (const r of contactRows) put('contact', r.id, { label: r.name, detail: r.kind });
  for (const r of taskRows) put('task', r.id, { label: r.title, detail: r.status });
  for (const r of noteRows) put('note', r.id, { label: r.title, detail: r.noteKind });
  for (const r of mailRows) put('mail', r.id, mailView(r));
  // Documents, artifacts and records have no batch read; one at a time keeps the pool free.
  for (const type of ['document', 'artifact', 'record'] as const) {
    for (const id of ids(type)) {
      const view = await resolveEntity(repos, type, id);
      if (view) put(type, id, view);
    }
  }
  return out;
}

function toResolved(link: CaseLink, entityType: CaseEntityType, entity: EntityView): ResolvedCaseLink {
  return {
    id: link.id,
    entityType,
    entityId: link.entityId,
    role: link.role,
    createdAt: link.createdAt,
    label: entity.label,
    detail: entity.detail,
  };
}

export interface FollowUpInput {
  title: string;
  remindAt: Date;
  dueAt?: Date | null;
  notes?: string | null;
  /** The user to remind; defaults to the case's assignee, else the author. */
  assigneeUserId?: string | null;
  source?: string;
  sourceRef?: Task['sourceRef'];
}

/**
 * Add a follow-up to a case: a task with `remindAt`, linked to the case as
 * `follow_up`. Null when the case is not reachable. The task is created
 * before the link; if linking fails the task is deleted again, so a failed
 * call leaves nothing behind.
 */
export async function addFollowUp(repos: ContentRepos, caseId: string, input: FollowUpInput): Promise<{ task: Task; link: ResolvedCaseLink } | null> {
  const parent = await repos.cases.findById(caseId);
  if (!parent) return null;
  const assignee = input.assigneeUserId !== undefined ? input.assigneeUserId : await assignableOrNull(repos, parent.assigneeUserId);
  const task = await repos.tasks.create({
    title: input.title,
    notes: input.notes ?? null,
    dueAt: input.dueAt ?? null,
    remindAt: input.remindAt,
    ...(assignee ? { assigneeKind: 'user', assigneeRef: assignee } : {}),
    source: input.source ?? 'user',
    sourceRef: input.sourceRef,
  });
  try {
    const link = await repos.cases.addLink(caseId, { entityType: 'task', entityId: task.id, role: 'follow_up' });
    if (!link) throw new CaseLinkError('Case not found');
    return { task, link: toResolved(link, 'task', { label: task.title, detail: task.status }) };
  } catch (err) {
    await repos.tasks.delete(task.id);
    throw err;
  }
}

/**
 * The case's assignee as a default for its follow-up, or null when they can
 * no longer be assigned (left the space, became a guest): the follow-up is
 * then unassigned and reminds its author, rather than failing.
 */
async function assignableOrNull(repos: ContentRepos, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  if (repos.kind !== 'space' || !repos.workspaceId) return userId === repos.principal.userId ? userId : null;
  const { getMembership } = await import('@/core/spaces/service');
  const member = await getMembership(userId, repos.workspaceId);
  return member && member.role !== 'guest' ? userId : null;
}
