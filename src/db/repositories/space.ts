/**
 * The space access layer (docs/plans/coworking-spec.md §5.5, D3).
 *
 * Personal access stays on the personal repositories (`scopedRepos`, the
 * singleton note / link repositories with a user id). Space access goes
 * through here, keyed only by `workspace_id` after a membership check:
 * `spaceRepos(principal)` takes a principal the resolver marked shared — the
 * member's role read from the database for this request (D5) — and throws
 * `SpaceError('not_found')` for anything else (I1, I3).
 *
 * Every query filters `workspace_id = $space`; every write stamps the space
 * as its workspace (ignoring any `data.workspaceId`) and the member as its
 * author (`user_id`, D4: attribution, never a grant), and checks `can()`:
 * viewers read, commenters also comment, editors and owners write. An
 * archived space reads only.
 *
 * Rows private to a member stay private inside a space: their chats
 * (sessions, messages), agents, pipelines and notifications are filtered by
 * the member as well as by the space.
 *
 * Guests (S6) have no content access yet: their scope has no defined shape
 * until guest scopes land, and an unscoped guest would read the whole space.
 */
import { join } from 'node:path';
import { and, desc, eq, inArray, isNull, ne, or, type SQL } from 'drizzle-orm';
import type { KnowledgeOwner, KnowledgeScope } from '@/core/rag/knowledge-scope';
import { type Principal, isAuthenticated } from '@/security/principal';
import { requireCan, SpaceError, type SpaceAction, type SpaceRole } from '@/security/space-access';
import { spaceDirectories, WorkspaceFS } from '@/security/workspace-fs';
import { getDb } from '../postgres';
import { type Artifact, artifacts, type NewArtifact } from '../schema/artifacts';
import { workspaceMembers, workspaces } from '../schema/organizations';
import { type NewVaultEntry, vault } from '../schema/vault';
import { type KnowledgeLinkRepository, getKnowledgeLinkRepository } from './knowledge-link-repository';
import { type NoteScope, type NoteStore, SpaceNoteRepo } from './note-repository';
import {
  type RepoScope,
  type ScopeColumns,
  ScopedAgentRepo,
  ScopedDocumentRepo,
  ScopedMessageRepo,
  ScopedNotificationRepo,
  ScopedPipelineRepo,
  ScopedSessionRepo,
  TaskRepo,
  UnauthenticatedAccessError,
} from './scoped';

/** What a member acting in a space is: the space, their role, and whether it is archived. */
export interface SpaceContext {
  readonly workspaceId: string;
  readonly userId: string;
  readonly role: SpaceRole;
  readonly archived: boolean;
}

/**
 * The space a principal acts in, or `SpaceError('not_found')`: a principal
 * the resolver did not mark shared with a role has no door into a space.
 */
export function spaceContextOf(principal: Principal): SpaceContext {
  if (!isAuthenticated(principal)) throw new UnauthenticatedAccessError();
  if (principal.workspaceKind !== 'shared' || !principal.workspaceId || !principal.spaceRole) {
    throw new SpaceError('not_found', 'Space not found');
  }
  if (principal.spaceRole === 'guest') {
    throw new SpaceError('forbidden_role', 'Guests reach space content through guest scopes, which this install does not have yet');
  }
  return {
    workspaceId: principal.workspaceId,
    userId: principal.userId,
    role: principal.spaceRole,
    archived: principal.spaceArchived === true,
  };
}

/** `can()` of a space context: the role's grant, and nothing but reads in an archived space. */
export function assertSpaceCan(space: SpaceContext, action: SpaceAction): void {
  if (space.archived && action !== 'read') throw new SpaceError('archived', 'This space is archived');
  requireCan({ workspaceId: space.workspaceId, userId: space.userId, role: space.role, scope: null }, action);
}

/** The `RepoScope` of a space: shared rows by workspace, private rows by workspace and member. */
export function spaceScope(principal: Principal): RepoScope {
  const space = spaceContextOf(principal);
  return {
    kind: 'space',
    principal,
    spaceId: space.workspaceId,
    shared: (t: ScopeColumns): SQL[] => [eq(t.workspaceId, space.workspaceId)],
    own: (t: ScopeColumns): SQL[] => [eq(t.workspaceId, space.workspaceId), eq(t.userId, space.userId)],
    stamp: () => ({ userId: space.userId, workspaceId: space.workspaceId }),
    can: (action) => assertSpaceCan(space, action),
    assertOpen: () => {
      if (space.archived) throw new SpaceError('archived', 'This space is archived');
    },
    writeWorkspace: async () => space.workspaceId,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Documents
// ─────────────────────────────────────────────────────────────────────

/**
 * A space's documents: every member reads them, editors upload and delete.
 * Uploads land under `<workspace.documentsPath>/spaces/<id>/`, which purge
 * removes with the space.
 */
export class SpaceDocumentRepo extends ScopedDocumentRepo {
  constructor(principal: Principal, private readonly space: SpaceContext) {
    super(principal, spaceScope(principal));
  }

  override uploadDirectory(): string {
    return join(spaceDirectories(this.space.workspaceId).documents, 'uncategorized');
  }
}

// ─────────────────────────────────────────────────────────────────────
// Links
// ─────────────────────────────────────────────────────────────────────

/** `KnowledgeLinkRepository`'s reads bound to one `NoteScope` (and, personally, its workspace rule). */
export interface LinkStore {
  getOutgoing(fromType: string, fromId: string): ReturnType<KnowledgeLinkRepository['getOutgoing']>;
  getBacklinks(toType: string, toId: string): ReturnType<KnowledgeLinkRepository['getBacklinks']>;
  getBacklinksByRef(toRef: string): ReturnType<KnowledgeLinkRepository['getBacklinksByRef']>;
  outgoingForIds(fromType: string, fromIds: string[]): ReturnType<KnowledgeLinkRepository['outgoingForIds']>;
  backlinksForIds(toType: string, toIds: string[]): ReturnType<KnowledgeLinkRepository['backlinksForIds']>;
  countUnresolved(): ReturnType<KnowledgeLinkRepository['countUnresolved']>;
}

export function linkStoreFor(scope: NoteScope, repo: KnowledgeLinkRepository = getKnowledgeLinkRepository()): LinkStore {
  const ws = scope.kind === 'personal' ? scope.workspaceId ?? undefined : undefined;
  return {
    getOutgoing: (fromType, fromId) => repo.getOutgoing(scope, fromType, fromId, ws),
    getBacklinks: (toType, toId) => repo.getBacklinks(scope, toType, toId, ws),
    getBacklinksByRef: (toRef) => repo.getBacklinksByRef(scope, toRef),
    outgoingForIds: (fromType, fromIds) => repo.outgoingForIds(scope, fromType, fromIds),
    backlinksForIds: (toType, toIds) => repo.backlinksForIds(scope, toType, toIds),
    countUnresolved: () => repo.countUnresolved(scope),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Artifacts
// ─────────────────────────────────────────────────────────────────────

/**
 * Artifacts of one workspace. `private` means the creator only — in a space
 * the other members do not see it (enforced here, so on every REST route).
 * Writes check `can('write')`. `door` runs once before the first query: the
 * personal store checks there that its workspace is not a space (D3).
 */
export class ArtifactStore {
  private entered: Promise<void> | null = null;

  constructor(
    private readonly workspaceId: string,
    private readonly userId: string,
    private readonly can: (action: SpaceAction) => void,
    private readonly door: () => Promise<void> = async () => undefined,
  ) {}

  private get db() { return getDb(); }

  private enter(): Promise<void> {
    this.entered ??= this.door();
    return this.entered;
  }

  /** Live (not deleted) rows of this workspace the caller may see. */
  private visible(): SQL[] {
    return [
      eq(artifacts.workspaceId, this.workspaceId),
      isNull(artifacts.deletedAt),
      or(eq(artifacts.visibility, 'workspace'), eq(artifacts.visibility, 'signed'), eq(artifacts.visibility, 'public'), eq(artifacts.createdByUserId, this.userId)) as SQL,
    ];
  }

  async list(limit = 200): Promise<Artifact[]> {
    await this.enter();
    return this.db
      .select()
      .from(artifacts)
      .where(and(...this.visible()))
      .orderBy(desc(artifacts.updatedAt))
      .limit(limit);
  }

  async findById(id: string): Promise<Artifact | null> {
    if (!UUID_RE.test(id)) return null;
    await this.enter();
    const [row] = await this.db.select().from(artifacts).where(and(eq(artifacts.id, id), ...this.visible())).limit(1);
    return row ?? null;
  }

  async findBySlug(slug: string): Promise<Artifact | null> {
    await this.enter();
    const [row] = await this.db.select().from(artifacts).where(and(eq(artifacts.slug, slug), ...this.visible())).limit(1);
    return row ?? null;
  }

  /** By slug *or* id. UUID-shaped ids try id first; otherwise slug. */
  async resolve(slugOrId: string): Promise<Artifact | null> {
    if (UUID_RE.test(slugOrId)) {
      const byId = await this.findById(slugOrId);
      if (byId) return byId;
    }
    return this.findBySlug(slugOrId);
  }

  /** Create in this workspace, by the caller. */
  async create(record: Omit<NewArtifact, 'workspaceId' | 'createdByUserId'>): Promise<Artifact> {
    this.can('write');
    await this.enter();
    const [row] = await this.db
      .insert(artifacts)
      .values({ ...record, workspaceId: this.workspaceId, createdByUserId: this.userId })
      .returning();
    return row;
  }

  /** Throws unless the caller may change artifacts here (edit, delete, sources, refresh, share links). */
  assertWrite(): void {
    this.can('write');
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The artifact of `slug` a signed-in viewer may open as a page: the one in
 * a personal workspace of theirs first, then one in a space they are a
 * member of (any role reads; guests not until their scopes exist, as in
 * `spaceContextOf`). Slugs are unique per workspace only, so the personal
 * row always wins: a personal page link never opens a space's page.
 * `private` is the creator's only. Membership is `getMembership` (D5).
 */
export async function findViewableArtifactBySlug(userId: string, slug: string): Promise<Artifact | null> {
  if (!UUID_RE.test(userId)) return null;
  const db = getDb();
  const viewable = [
    eq(artifacts.slug, slug),
    isNull(artifacts.deletedAt),
    or(eq(artifacts.visibility, 'workspace'), eq(artifacts.visibility, 'signed'), eq(artifacts.visibility, 'public'), eq(artifacts.createdByUserId, userId)) as SQL,
  ];
  const [personal] = await db
    .select()
    .from(artifacts)
    .where(and(...viewable, inArray(artifacts.workspaceId, db.select({ id: workspaces.id }).from(workspaces)
      .where(and(eq(workspaces.userId, userId), eq(workspaces.kind, 'personal'))))))
    .orderBy(desc(artifacts.updatedAt))
    .limit(1);
  if (personal) return personal;
  // Candidates: spaces where the viewer holds a non-guest role; the winner's
  // membership is then confirmed through `getMembership`.
  const [inSpace] = await db
    .select()
    .from(artifacts)
    .where(and(...viewable, inArray(artifacts.workspaceId, db.select({ id: workspaceMembers.workspaceId }).from(workspaceMembers)
      .where(and(eq(workspaceMembers.userId, userId), ne(workspaceMembers.role, 'guest'))))))
    .orderBy(desc(artifacts.updatedAt))
    .limit(1);
  if (!inSpace) return null;
  const { getMembership } = await import('@/core/spaces/service');
  const membership = await getMembership(userId, inSpace.workspaceId);
  return membership && membership.role !== 'guest' ? inSpace : null;
}

// ─────────────────────────────────────────────────────────────────────
// Secrets (space connectors, §9.5)
// ─────────────────────────────────────────────────────────────────────

/** A space secret without its value. */
export interface SpaceSecretView {
  name: string;
  credentialType: NewVaultEntry['credentialType'];
  /** The owner who stored it: its author, never a grant (D4). */
  storedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A space's credentials: vault rows with `scope = 'space'`, keyed by the
 * space (`workspace_id`) and encrypted under a key derived from it
 * (`dekForRow`). The only reader and writer of those rows (I1): every call
 * goes through a member's space context, read for this request.
 *
 * - `list` (names only): any member who may read the space.
 * - `read`: the space's connector code acting for a member who may run the
 *   agent (token getters, `runGh` with `opts.token`). A space secret never
 *   reaches `{{secret:}}` injection, which reads `user` and `system` rows
 *   only, so a turn cannot route one into a shell or an HTTP call.
 * - `write` / `remove`: owners (`manage_space`), audited with the space.
 * - `refresh`: a connector's token refresh, by any member who may run the
 *   agent, of a row that already exists.
 */
export class SpaceSecretStore {
  constructor(private readonly space: SpaceContext) {}

  private get db() { return getDb(); }

  private live(name?: string): SQL[] {
    return [
      eq(vault.scope, 'space'),
      eq(vault.workspaceId, this.space.workspaceId),
      eq(vault.isActive, true),
      ...(name === undefined ? [] : [eq(vault.name, name)]),
    ];
  }

  async list(): Promise<SpaceSecretView[]> {
    assertSpaceCan(this.space, 'read');
    return this.db
      .select({ name: vault.name, credentialType: vault.credentialType, storedBy: vault.userId, createdAt: vault.createdAt, updatedAt: vault.updatedAt })
      .from(vault)
      .where(and(...this.live()))
      .orderBy(vault.name);
  }

  /** The value of `name`, or null. For connector code only (see the class comment). */
  async read(name: string): Promise<string | null> {
    assertSpaceCan(this.space, 'run_agent');
    const [row] = await this.db.select().from(vault).where(and(...this.live(name))).orderBy(desc(vault.updatedAt)).limit(1);
    if (!row) return null;
    if (row.expiresAt && row.expiresAt < new Date()) return null;
    const { decryptRow } = await import('@/security/vault');
    return decryptRow(row).plaintext;
  }

  /** Every row of `name` in the space, live or not. */
  private everyRow(name?: string): SQL[] {
    return [
      eq(vault.scope, 'space'),
      eq(vault.workspaceId, this.space.workspaceId),
      ...(name === undefined ? [] : [eq(vault.name, name)]),
    ];
  }

  /**
   * Store `name`, replacing every row of that name: the superseded
   * ciphertext is deleted, not kept inactive under the space's key. Owners
   * only.
   */
  async write(name: string, value: string, credentialType: NewVaultEntry['credentialType']): Promise<void> {
    assertSpaceCan(this.space, 'manage_space');
    if (!value.trim()) throw new SpaceError('invalid_input', 'A secret needs a value');
    const { encryptForRow } = await import('@/security/vault');
    const key = { scope: 'space' as const, userId: this.space.userId, workspaceId: this.space.workspaceId };
    await this.db.transaction(async (tx) => {
      await tx.delete(vault).where(and(...this.everyRow(name)));
      await tx.insert(vault).values({ ...key, name, credentialType, ...encryptForRow(key, value), tags: ['space-connector'] });
    });
  }

  /**
   * A connector's refreshed token: rewrites the live row of `name` in place
   * (its author stays). False when there is none — a refresh never creates a
   * secret the owners did not store.
   */
  async refresh(name: string, value: string): Promise<boolean> {
    assertSpaceCan(this.space, 'run_agent');
    const { encryptForRow } = await import('@/security/vault');
    const key = { scope: 'space' as const, userId: this.space.userId, workspaceId: this.space.workspaceId };
    const updated = await this.db.update(vault)
      .set({ ...encryptForRow(key, value), updatedAt: new Date() })
      .where(and(...this.live(name)))
      .returning({ id: vault.id });
    return updated.length > 0;
  }

  /**
   * Delete the rows of `names` (inactive leftovers of an earlier version
   * too); returns how many were live. Owners only.
   */
  async remove(names: readonly string[]): Promise<number> {
    assertSpaceCan(this.space, 'manage_space');
    if (names.length === 0) return 0;
    const removed = await this.db.delete(vault)
      .where(and(...this.everyRow(), inArray(vault.name, [...names])))
      .returning({ isActive: vault.isActive });
    return removed.filter((r) => r.isActive).length;
  }
}

/**
 * The shared principal of `userId` in `workspaceId`, with the role read now
 * (D5) — for code that acts for a member outside a request (an OAuth
 * callback, a channel bridge). `SpaceError('not_found')` for a non-member.
 */
export async function memberPrincipal(userId: string, workspaceId: string): Promise<Principal> {
  const { getMembership, isSpaceArchived } = await import('@/core/spaces/service');
  const membership = await getMembership(userId, workspaceId);
  if (!membership) throw new SpaceError('not_found', 'Space not found');
  return {
    kind: 'user',
    userId,
    username: userId,
    isAdmin: false,
    sessionToken: null,
    roles: ['user'],
    workspaceId,
    workspaceKind: 'shared',
    spaceRole: membership.role,
    spaceScope: membership.scope,
    spaceArchived: await isSpaceArchived(workspaceId),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Bundle
// ─────────────────────────────────────────────────────────────────────

export interface SpaceRepos {
  readonly kind: 'space';
  readonly principal: Principal;
  readonly workspaceId: string;
  readonly role: SpaceRole;
  /** Throws `SpaceError` unless the member may `action` here. */
  can(action: SpaceAction): void;
  /** Throws `SpaceError('archived')` when the space is archived. */
  assertOpen(): void;
  sessions: ScopedSessionRepo;
  messages: ScopedMessageRepo;
  agents: ScopedAgentRepo;
  pipelines: ScopedPipelineRepo;
  documents: SpaceDocumentRepo;
  notifications: ScopedNotificationRepo;
  tasks: TaskRepo;
  notes: NoteStore;
  noteScope: NoteScope;
  links: LinkStore;
  artifacts: ArtifactStore;
  /** The space's connector credentials (§9.5). */
  secrets: SpaceSecretStore;
  knowledge: KnowledgeScope;
  knowledgeOwner: KnowledgeOwner;
  /** The space's files (`<workspace.rootPath>/spaces/<id>/files`). */
  files(): WorkspaceFS;
}

/**
 * The repositories of the space `principal` acts in. Throws
 * `SpaceError('not_found')` unless the resolver marked the principal shared
 * with a role.
 */
export function spaceRepos(principal: Principal): SpaceRepos {
  const space = spaceContextOf(principal);
  const scope = spaceScope(principal);
  const noteScope: NoteScope = { kind: 'space', workspaceId: space.workspaceId, userId: space.userId, role: space.role, archived: space.archived };
  return {
    kind: 'space',
    principal,
    workspaceId: space.workspaceId,
    role: space.role,
    can: scope.can,
    assertOpen: scope.assertOpen,
    sessions: new ScopedSessionRepo(principal, scope),
    messages: new ScopedMessageRepo(principal, scope),
    agents: new ScopedAgentRepo(principal, scope),
    pipelines: new ScopedPipelineRepo(principal, scope),
    documents: new SpaceDocumentRepo(principal, space),
    notifications: new ScopedNotificationRepo(principal, scope),
    tasks: new TaskRepo(scope),
    notes: new SpaceNoteRepo(noteScope),
    noteScope,
    links: linkStoreFor(noteScope),
    artifacts: new ArtifactStore(space.workspaceId, space.userId, scope.can),
    secrets: new SpaceSecretStore(space),
    knowledge: { kind: 'space', workspaceId: space.workspaceId },
    knowledgeOwner: { ownerUserId: space.userId, workspaceId: space.workspaceId },
    files: () => WorkspaceFS.forSpace(space.workspaceId),
  };
}
