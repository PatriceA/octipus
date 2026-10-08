/**
 * Persistence of live documents (docs/plans/coworking-spec.md §7, S3): the
 * document hub's note reads and conditional writes, note revisions, edit
 * proposals and file leases. Space rows only — every read is keyed by a
 * space's workspace id or by a note of a shared workspace — and part of the
 * access layer: the callers (the hub, the services, the routes) check the
 * member's role before they get here.
 */
import { and, asc, desc, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';
import { getDb } from '../postgres';
import {
  type FileLease,
  type FileLeaseHolderKind,
  fileLeases,
  type NoteEditProposal,
  type NoteEditProposalAction,
  type NoteEditProposalStatus,
  noteEditProposals,
  type NoteRevision,
  type NoteRevisionOrigin,
  noteRevisions,
} from '../schema/live-documents';
import { type Note, notes } from '../schema/notes';
import { type SpaceRole, workspaceMembers, workspaces } from '../schema/organizations';
import { users } from '../schema/users';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─────────────────────────────────────────────────────────────────────
// Notes
// ─────────────────────────────────────────────────────────────────────

/** A note of a shared workspace, as the hub loads it. */
export interface SpaceNoteRow {
  id: string;
  workspaceId: string;
  title: string;
  body: string;
  bodySha256: string;
  archivedAt: Date | null;
  /** The space is archived: the note reads only. */
  spaceArchived: boolean;
}

/** The note `noteId` when it lives in a shared workspace; null otherwise (personal notes have no live document). */
export async function loadSpaceNote(noteId: string): Promise<SpaceNoteRow | null> {
  if (!UUID_RE.test(noteId)) return null;
  const [row] = await getDb()
    .select({
      id: notes.id,
      workspaceId: notes.workspaceId,
      title: notes.title,
      body: notes.body,
      bodySha256: notes.bodySha256,
      archivedAt: notes.archivedAt,
      spaceArchivedAt: workspaces.archivedAt,
    })
    .from(notes)
    .innerJoin(workspaces, eq(workspaces.id, notes.workspaceId))
    .where(and(eq(notes.id, noteId), eq(workspaces.kind, 'shared')))
    .limit(1);
  if (!row || !row.workspaceId) return null;
  const { spaceArchivedAt, ...note } = row;
  return { ...note, workspaceId: row.workspaceId, spaceArchived: spaceArchivedAt !== null };
}

/** The workspace and slug of a note (a guest's scope is checked against the slug, S6). */
export async function loadSpaceNoteSlug(noteId: string): Promise<{ workspaceId: string; slug: string } | null> {
  if (!UUID_RE.test(noteId)) return null;
  const [row] = await getDb()
    .select({ workspaceId: notes.workspaceId, slug: notes.slug })
    .from(notes)
    .where(eq(notes.id, noteId))
    .limit(1);
  return row?.workspaceId ? { workspaceId: row.workspaceId, slug: row.slug } : null;
}

/**
 * Write `body` over the note only while its body is still `expectedSha`
 * (one conditional `UPDATE … RETURNING`): the compare-and-write every
 * space-note body write is. Null when the body moved on (or the note is
 * gone).
 */
export async function writeBodyIfUnchanged(
  noteId: string,
  workspaceId: string,
  expectedSha: string,
  body: string,
  bodySha256: string,
  extra: { title?: string; tags?: string[] } = {},
): Promise<Note | null> {
  const [row] = await getDb()
    .update(notes)
    .set({ body, bodySha256, ...extra, updatedAt: new Date() })
    .where(and(eq(notes.id, noteId), eq(notes.workspaceId, workspaceId), eq(notes.bodySha256, expectedSha)))
    .returning();
  return row ?? null;
}

// ─────────────────────────────────────────────────────────────────────
// Revisions
// ─────────────────────────────────────────────────────────────────────

export interface NewRevision {
  noteId: string;
  workspaceId: string;
  body: string;
  bodySha256: string;
  authors: string[];
  onBehalfOfUserId: string | null;
  origin: NoteRevisionOrigin;
  restoredFrom?: string | null;
}

export async function insertRevision(rev: NewRevision): Promise<NoteRevision> {
  const [row] = await getDb()
    .insert(noteRevisions)
    .values({ ...rev, authors: [...new Set(rev.authors)], restoredFrom: rev.restoredFrom ?? null })
    .returning();
  return row;
}

/** A revision as the history panel lists it: no body, authors with names. */
export interface RevisionView {
  id: string;
  createdAt: Date;
  origin: NoteRevisionOrigin;
  bodySha256: string;
  size: number;
  authors: Array<{ userId: string; username: string | null }>;
  onBehalfOf: { userId: string; username: string | null } | null;
  restoredFrom: string | null;
}

export async function listRevisions(workspaceId: string, noteId: string, limit = 100): Promise<RevisionView[]> {
  const rows = await getDb()
    .select({
      id: noteRevisions.id,
      createdAt: noteRevisions.createdAt,
      origin: noteRevisions.origin,
      bodySha256: noteRevisions.bodySha256,
      size: sql<number>`octet_length(${noteRevisions.body})`,
      authors: noteRevisions.authors,
      onBehalfOfUserId: noteRevisions.onBehalfOfUserId,
      restoredFrom: noteRevisions.restoredFrom,
    })
    .from(noteRevisions)
    .where(and(eq(noteRevisions.workspaceId, workspaceId), eq(noteRevisions.noteId, noteId)))
    .orderBy(desc(noteRevisions.createdAt))
    .limit(limit);
  const names = await userNames(rows.flatMap((r) => [...r.authors, ...(r.onBehalfOfUserId ? [r.onBehalfOfUserId] : [])]));
  const named = (userId: string) => ({ userId, username: names.get(userId) ?? null });
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    origin: r.origin,
    bodySha256: r.bodySha256,
    size: Number(r.size),
    authors: r.authors.map(named),
    onBehalfOf: r.onBehalfOfUserId ? named(r.onBehalfOfUserId) : null,
    restoredFrom: r.restoredFrom,
  }));
}

export async function getRevision(workspaceId: string, noteId: string, revisionId: string): Promise<NoteRevision | null> {
  if (!UUID_RE.test(revisionId)) return null;
  const [row] = await getDb()
    .select()
    .from(noteRevisions)
    .where(and(eq(noteRevisions.id, revisionId), eq(noteRevisions.workspaceId, workspaceId), eq(noteRevisions.noteId, noteId)))
    .limit(1);
  return row ?? null;
}

// ─────────────────────────────────────────────────────────────────────
// Edit proposals
// ─────────────────────────────────────────────────────────────────────

export interface ProposalInput {
  noteId: string;
  workspaceId: string;
  userId: string;
  sessionId: string | null;
  /** A proposer without a session (`remote:<user id>`); one of the two keys the pending proposal. */
  proposerKey?: string | null;
  agentId: string | null;
  action: NoteEditProposalAction;
  title: string | null;
  baseBody: string;
  baseSha256: string;
  body: string;
}

/**
 * Create the session's (or the proposer's) pending proposal for the note,
 * or update it (its base stays the one it was first made from only when the
 * new write names the same base; a write from a newer read replaces the
 * base too).
 */
export async function upsertPendingProposal(input: ProposalInput): Promise<NoteEditProposal> {
  const db = getDb();
  if (input.sessionId && input.proposerKey) throw new Error('A proposal is keyed by its session or its proposer, not both');
  return db.transaction(async (tx) => {
    const keyed = input.sessionId ? eq(noteEditProposals.sessionId, input.sessionId)
      : input.proposerKey ? and(isNull(noteEditProposals.sessionId), eq(noteEditProposals.proposerKey, input.proposerKey))
      : null;
    if (keyed) {
      const [existing] = await tx
        .select()
        .from(noteEditProposals)
        .where(and(
          eq(noteEditProposals.noteId, input.noteId),
          eq(noteEditProposals.workspaceId, input.workspaceId),
          keyed,
          eq(noteEditProposals.status, 'pending'),
        ))
        .for('update')
        .limit(1);
      if (existing) {
        const [updated] = await tx
          .update(noteEditProposals)
          .set({
            action: input.action,
            title: input.title,
            baseBody: input.baseBody,
            baseSha256: input.baseSha256,
            body: input.body,
            agentId: input.agentId,
            updatedAt: new Date(),
          })
          .where(eq(noteEditProposals.id, existing.id))
          .returning();
        return updated;
      }
    }
    const [created] = await tx.insert(noteEditProposals).values({ ...input, proposerKey: input.proposerKey ?? null, status: 'pending' }).returning();
    return created;
  });
}

export async function getProposal(workspaceId: string, proposalId: string): Promise<NoteEditProposal | null> {
  if (!UUID_RE.test(proposalId)) return null;
  const [row] = await getDb()
    .select()
    .from(noteEditProposals)
    .where(and(eq(noteEditProposals.id, proposalId), eq(noteEditProposals.workspaceId, workspaceId)))
    .limit(1);
  return row ?? null;
}

export async function listProposals(workspaceId: string, opts: { noteId?: string; status?: NoteEditProposalStatus; limit?: number } = {}): Promise<NoteEditProposal[]> {
  return getDb()
    .select()
    .from(noteEditProposals)
    .where(and(
      eq(noteEditProposals.workspaceId, workspaceId),
      opts.noteId ? eq(noteEditProposals.noteId, opts.noteId) : undefined,
      opts.status ? eq(noteEditProposals.status, opts.status) : undefined,
    ))
    .orderBy(desc(noteEditProposals.updatedAt))
    .limit(opts.limit ?? 100);
}

/** The pending proposal of `sessionId` for the note, if any. */
export async function pendingProposalOf(workspaceId: string, noteId: string, sessionId: string): Promise<NoteEditProposal | null> {
  const [row] = await getDb()
    .select()
    .from(noteEditProposals)
    .where(and(
      eq(noteEditProposals.workspaceId, workspaceId),
      eq(noteEditProposals.noteId, noteId),
      eq(noteEditProposals.sessionId, sessionId),
      eq(noteEditProposals.status, 'pending'),
    ))
    .limit(1);
  return row ?? null;
}

/**
 * Move a pending proposal to `status`; null when it was no longer pending
 * (decided concurrently) or, with `asRead`, no longer says what was read
 * (the agent updated it since): nobody is marked as having decided a body
 * they never saw.
 */
export async function decideProposal(
  workspaceId: string,
  proposalId: string,
  status: Exclude<NoteEditProposalStatus, 'pending'>,
  decidedBy: string,
  asRead?: Pick<NoteEditProposal, 'action' | 'title' | 'baseSha256' | 'body'>,
): Promise<NoteEditProposal | null> {
  const [row] = await getDb()
    .update(noteEditProposals)
    .set({ status, decidedBy, decidedAt: new Date(), updatedAt: new Date() })
    .where(and(
      eq(noteEditProposals.id, proposalId),
      eq(noteEditProposals.workspaceId, workspaceId),
      eq(noteEditProposals.status, 'pending'),
      ...(asRead ? [
        eq(noteEditProposals.action, asRead.action),
        asRead.title === null ? isNull(noteEditProposals.title) : eq(noteEditProposals.title, asRead.title),
        eq(noteEditProposals.baseSha256, asRead.baseSha256),
        eq(noteEditProposals.body, asRead.body),
      ] : []),
    ))
    .returning();
  return row ?? null;
}

// ─────────────────────────────────────────────────────────────────────
// File leases
// ─────────────────────────────────────────────────────────────────────

export interface LeaseHolder {
  userId: string;
  kind: FileLeaseHolderKind;
  agentId?: string | null;
}

/** Unexpired leases of the space, by path. `paths` narrows to those paths. */
export async function liveLeases(workspaceId: string, paths?: string[]): Promise<FileLease[]> {
  if (paths && paths.length === 0) return [];
  return getDb()
    .select()
    .from(fileLeases)
    .where(and(
      eq(fileLeases.workspaceId, workspaceId),
      gt(fileLeases.expiresAt, sql`now()`),
      paths ? inArray(fileLeases.path, paths) : undefined,
    ))
    .orderBy(asc(fileLeases.path));
}

/** Unexpired leases on `path` or anywhere under it (`path/…`). */
export async function liveLeasesUnder(workspaceId: string, path: string): Promise<FileLease[]> {
  const escaped = path.replace(/[\\%_]/g, (c) => `\\${c}`);
  return getDb()
    .select()
    .from(fileLeases)
    .where(and(
      eq(fileLeases.workspaceId, workspaceId),
      gt(fileLeases.expiresAt, sql`now()`),
      sql`(${fileLeases.path} = ${path} OR ${fileLeases.path} LIKE ${`${escaped}/%`})`,
    ));
}

/**
 * Take or renew the lease on `path` for `holder` until now + `ttlSeconds`:
 * inserted when free, taken over when expired, renewed when the holder
 * already has it. Null when another holder has a live lease on it.
 */
export async function takeLease(workspaceId: string, path: string, holder: LeaseHolder, ttlSeconds: number): Promise<FileLease | null> {
  const expires = sql`now() + make_interval(secs => ${ttlSeconds})`;
  const agentId = holder.agentId ?? null;
  const [row] = await getDb()
    .insert(fileLeases)
    .values({ workspaceId, path, holderUserId: holder.userId, holderKind: holder.kind, agentId, expiresAt: expires })
    .onConflictDoUpdate({
      target: [fileLeases.workspaceId, fileLeases.path],
      set: {
        holderUserId: holder.userId,
        holderKind: holder.kind,
        agentId,
        acquiredAt: sql`CASE WHEN ${fileLeases.expiresAt} <= now() THEN now() ELSE ${fileLeases.acquiredAt} END`,
        renewedAt: sql`now()`,
        expiresAt: expires,
      },
      setWhere: sql`${fileLeases.expiresAt} <= now() OR (
        ${fileLeases.holderUserId} = ${holder.userId}
        AND ${fileLeases.holderKind} = ${holder.kind}
        AND ${fileLeases.agentId} IS NOT DISTINCT FROM ${agentId})`,
    })
    .returning();
  return row ?? null;
}

/** Drop `holder`'s lease on `path`. Returns whether there was one. */
export async function dropLease(workspaceId: string, path: string, holder: LeaseHolder): Promise<boolean> {
  const rows = await getDb()
    .delete(fileLeases)
    .where(and(
      eq(fileLeases.workspaceId, workspaceId),
      eq(fileLeases.path, path),
      eq(fileLeases.holderUserId, holder.userId),
      eq(fileLeases.holderKind, holder.kind),
      sql`${fileLeases.agentId} IS NOT DISTINCT FROM ${holder.agentId ?? null}`,
    ))
    .returning({ path: fileLeases.path });
  return rows.length > 0;
}

/** Delete expired leases (of one space, or all). Returns the spaces that lost one. */
export async function deleteExpiredLeases(workspaceId?: string): Promise<string[]> {
  const rows = await getDb()
    .delete(fileLeases)
    .where(and(lt(fileLeases.expiresAt, sql`now()`), workspaceId ? eq(fileLeases.workspaceId, workspaceId) : undefined))
    .returning({ workspaceId: fileLeases.workspaceId });
  return [...new Set(rows.map((r) => r.workspaceId))];
}

/** Drop every lease `userId` holds in the space (removal from it). */
export async function dropLeasesOf(workspaceId: string, userId: string): Promise<number> {
  const rows = await getDb()
    .delete(fileLeases)
    .where(and(eq(fileLeases.workspaceId, workspaceId), eq(fileLeases.holderUserId, userId)))
    .returning({ path: fileLeases.path });
  return rows.length;
}

// ─────────────────────────────────────────────────────────────────────
// People
// ─────────────────────────────────────────────────────────────────────

/** Usernames of `ids` (unknown ids are left out). */
export async function userNames(ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)].filter((id) => UUID_RE.test(id));
  if (unique.length === 0) return new Map();
  const rows = await getDb().select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, unique));
  return new Map(rows.map((r) => [r.id, r.username]));
}

/** The members of a space with their role and username (presence). */
export async function spaceMemberRoles(workspaceId: string): Promise<Map<string, { role: SpaceRole; username: string }>> {
  if (!UUID_RE.test(workspaceId)) return new Map();
  const rows = await getDb()
    .select({ userId: workspaceMembers.userId, role: workspaceMembers.role, username: users.username })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaces.kind, 'shared')));
  return new Map(rows.map((r) => [r.userId, { role: r.role, username: r.username }]));
}
