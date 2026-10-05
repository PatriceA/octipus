/**
 * Scoped repositories — Principal-bound facades over the raw repos.
 *
 * Phase 1a multi-user foundation. The unscoped repositories under
 * `src/db/repositories/*` accept raw `userId` strings and rely on the
 * caller to filter correctly. That puts the security burden on every
 * route handler, and "forgot to add the WHERE" is exactly the bug class
 * we're trying to design out.
 *
 * `scopedRepos(principal)` returns a bundle of repositories that:
 *
 *   1. Filter every read by `principal.userId` automatically.
 *      Rows belonging to other users are returned as `null` / empty
 *      lists, indistinguishable from "does not exist". This blocks UUID
 *      enumeration attacks: an attacker who guesses a session id can't
 *      tell whether the row is missing or owned by another user.
 *
 *   2. Reject writes targeting rows the principal does not own. Mutating
 *      methods load the row scoped, then mutate; if the scoped load
 *      returned null, the mutation is a no-op returning null.
 *
 *   3. Allow admins broader access only through *explicitly named*
 *      methods (`findByIdAdmin`, `listAllAdmin`). The default methods
 *      stay scoped even for admins, which matches the principle of
 *      least surprise — an admin browsing the UI sees their own data
 *      unless they've explicitly asked for the global view.
 *
 *   4. Cross-table reads (e.g. messages by session id) join through
 *      `sessions.user_id` so the filter happens in SQL, not application
 *      code. Drizzle composes the join behind the scope so callers
 *      can't bypass it by accident.
 */

import { and, arrayContains, asc, count, desc, eq, getTableColumns, gte, inArray, ne, notExists, notInArray, or, type SQL, sql } from 'drizzle-orm';
import { alias, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { dispatchWakeups, notifyTaskClosed, scheduleWakeup, type WakeupCause } from '@/core/tasks/wakeups';
import { isAdmin, isAuthenticated, type Principal } from '@/security/principal';
import { type GuestScope, type SpaceAction, SpaceError } from '@/security/space-access';
import { TASK_CHECKOUT_TTL_MS } from '@/core/tasks/checkout';
import { ACTIVE_TASK_STATUSES, isActiveStatus, isTaskStatus } from '@/core/tasks/status';
import { toLookup, type WaitingOn, waitingOn } from '@/core/tasks/structure';
import { join as pathJoin, resolve as pathResolve } from 'node:path';
import { getConfig } from '@/config';
import { messageEvents } from './message-events';
import { sessionsRemoved } from './session-lifecycle';
import { getDb } from '../postgres';
import { type AgentRecord, agents, type NewAgentRecord } from '../schema/agents';
import { type BackgroundJob, backgroundJobs } from '../schema/background-jobs';
import { type DocumentRecord, documents, type NewDocumentRecord } from '../schema/documents';
import { type Hook, hooks } from '../schema/hooks';
import { type Message, messages, type NewMessage } from '../schema/messages';
import { type Notification, notifications } from '../schema/notifications';
import { type PipelineTemplate, pipelineTemplates } from '../schema/pipeline-templates';
import { type Pipeline, pipelines } from '../schema/pipelines';
import { type NewSession, type Session, sessions } from '../schema/sessions';
import { type TaskComment, taskComments } from '../schema/task-comments';
import { type NewTask, type Task, tasks } from '../schema/tasks';
import { workspaces } from '../schema/organizations';
import { type TrajectoryRunRecord, trajectoryRuns } from '../schema/trajectory-runs';

/**
 * Anonymous principals and unauthenticated calls fail fast with this
 * error. Routes should never reach this — the auth guard rejects them
 * first — but the repos enforce it as defense-in-depth.
 */
export class UnauthenticatedAccessError extends Error {
  readonly code = 'UNAUTHENTICATED';
  constructor() {
    super('Scoped repositories require an authenticated principal');
    this.name = 'UnauthenticatedAccessError';
  }
}

function requireAuth(p: Principal): void {
  if (!isAuthenticated(p)) throw new UnauthenticatedAccessError();
}

/**
 * Is `id` shaped like the uuid its column stores?
 *
 * A caller-supplied id that is not a uuid reaches Postgres as a cast error, so
 * an operation that should have been a miss came back a 500 instead — a client
 * posting a made-up session id crashed the request rather than being told the
 * session does not exist. Guarded on every method that takes a caller-supplied
 * id, reads and writes alike: `PATCH /sessions/abc` and `DELETE /tasks/abc`
 * carry exactly the same id from exactly the same place as a lookup does.
 * These tables key on `uuid`; `agents.id` is `text` and is deliberately not
 * guarded.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(id: string): boolean {
  return UUID_RE.test(id);
}

/**
 * The personal predicate (docs/plans/coworking-spec.md §5.5, I2): the row is
 * in no workspace, or in a personal one. Every personal read carries it —
 * through `workspaceFilter` here, and on its own in the raw readers outside
 * the repositories — so a personal path never returns a space's rows, for
 * their author and for an admin alike. `column` is a `workspace_id` column
 * (or an aliased one); a NULL workspace is personal.
 *
 * Positive on purpose: a row still naming a workspace that no longer exists
 * (a purged space's row on a table without a foreign key) is nobody's
 * personal row. "Not in a shared workspace" would hand it to its author.
 */
export function notInSharedWorkspace(column: AnyPgColumn | SQL): SQL {
  return sql`(${column} IS NULL OR EXISTS (SELECT 1 FROM workspaces pw WHERE pw.id = ${column} AND pw.kind = 'personal'))`;
}

/**
 * Throws unless `workspaceId` may take a personal write: none (user-level)
 * or a personal workspace. A personal scope handed a space's id — an agent
 * context in a space, a caller's `data.workspaceId` — would otherwise insert
 * into the space with no membership, role or archive check (D3): space
 * writes go through `contentRepos` with the space principal.
 */
export async function assertPersonalWorkspace(workspaceId: string | null | undefined): Promise<void> {
  if (!workspaceId) return;
  if (!isUuid(workspaceId)) throw new Error(`Not a workspace id: ${workspaceId}`);
  const [row] = await getDb()
    .select({ kind: workspaces.kind })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (row?.kind === 'shared') {
    throw new Error('Personal repositories cannot write into a shared workspace; use contentRepos(principal) with the space principal');
  }
}

/**
 * Phase 4 — workspace scoping helper.
 *
 * Returns a Drizzle filter narrowing rows to the principal's
 * workspace. Rows with a NULL `workspace_id` are included alongside the
 * matching workspace — NULL means "visible to every workspace owned by
 * this user", so un-backfilled rows stay visible after the runtime starts
 * filtering. Rows of a shared workspace (a space) never match, with or
 * without a workspace context: spaces are reached through `spaceRepos`
 * only (§5.5, D3).
 *
 * Admins are NOT exempted from this filter. An admin browsing their
 * own UI under a specific workspace should see only that
 * workspace's rows; the global view is reached via the explicit
 * `*Admin` methods that don't go through scoping.
 */
export function workspaceFilter(
  principal: Principal,
  column: AnyPgColumn,
): SQL {
  const wsId = principal.workspaceId;
  const personal = notInSharedWorkspace(column);
  if (!wsId) return personal;
  return sql`((${column} = ${wsId} OR ${column} IS NULL) AND ${personal})`;
}

/** The owner / workspace columns scoping reads, on a content table or an alias of it. */
export type ScopeColumns = { userId: AnyPgColumn; workspaceId: AnyPgColumn };

/**
 * Where a bundle of repositories reads and writes (§5.5). The personal
 * scope is the owner plus the personal workspace rule; the space scope is
 * one shared workspace, entered only after a membership check
 * (`spaceRepos`). Repositories take one and never build their own owner
 * filter.
 */
export interface RepoScope {
  readonly kind: 'personal' | 'space';
  readonly principal: Principal;
  /** The space's id; null for the personal scope. */
  readonly spaceId: string | null;
  /**
   * Rows the scope shares — in a space every member's (tasks, documents,
   * notes, artifacts). `byId` lets a personal admin's by-id read skip the
   * owner filter (never across into a space: the workspace rule stays).
   */
  shared(t: ScopeColumns, opts?: { byId?: boolean }): SQL[];
  /** Rows private to the member even in a space: their sessions, agents, notifications, pipelines. */
  own(t: ScopeColumns, opts?: { byId?: boolean }): SQL[];
  /** The columns a write stamps: the author (D4) and the workspace. */
  stamp(): { userId: string; workspaceId: string | null };
  /** Throws `SpaceError` when the principal may not `action` here; the personal scope allows everything. */
  can(action: SpaceAction): void;
  /** Throws `SpaceError('archived')` when the scope reads only (an archived space); the personal scope never does. */
  assertOpen(): void;
  /**
   * A guest's scope (S6). Then `shared` reaches no row by default — a
   * repository whose table has a guest rule applies it instead (tasks:
   * raised from a room of the scope). Absent for every other scope.
   */
  readonly guest?: GuestScope | null;
  /**
   * The workspace a new row is stamped with. In a space, always the space
   * (`requested` is ignored); personally, `requested` or the principal's
   * workspace, refused when it names a shared workspace (D3).
   */
  writeWorkspace(requested?: string | null): Promise<string | null>;
}

/** The personal scope of `principal`: the personal door (D3). */
export function personalScope(principal: Principal): RepoScope {
  requireAuth(principal);
  if (principal.workspaceKind === 'shared') {
    // A request's principal acting in a space reaches the personal repos only
    // by a wiring bug: its handler must go through `contentRepos`.
    throw new Error('Personal repositories reached with a space principal; use contentRepos(principal)');
  }
  const owner = (t: ScopeColumns, opts?: { byId?: boolean }): SQL[] => {
    const filters: SQL[] = [];
    if (!(opts?.byId && isAdmin(principal))) filters.push(eq(t.userId, principal.userId));
    filters.push(workspaceFilter(principal, t.workspaceId));
    return filters;
  };
  return {
    kind: 'personal',
    principal,
    spaceId: null,
    shared: owner,
    own: owner,
    stamp: () => ({ userId: principal.userId, workspaceId: principal.workspaceId ?? null }),
    can: () => undefined,
    assertOpen: () => undefined,
    writeWorkspace: async (requested) => {
      const workspaceId = requested ?? principal.workspaceId ?? null;
      await assertPersonalWorkspace(workspaceId);
      return workspaceId;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Sessions
// ─────────────────────────────────────────────────────────────────────

/**
 * Personal session paths see chats only (coworking §6.2, D7): a room is a
 * session of its creator (`user_id`), and still invisible to every personal
 * path — the creator's included. Rooms are read through the rooms service,
 * after `roomAccess`.
 */
export const personalChat: SQL = sql`${sessions.kind} = 'chat'`;

/**
 * A personal create path never makes a room: `kind: 'room'` and the
 * `room` channel type are the rooms service's alone.
 */
export function assertNotRoomCreate(data: { kind?: string | null; channelType?: string | null; roomVisibility?: string | null }): void {
  if (data.kind === 'room' || data.channelType === 'room' || data.roomVisibility != null) {
    throw new Error('Rooms are created in a space (POST /api/spaces/:id/rooms), not as a chat');
  }
}

export class ScopedSessionRepo {
  private readonly scope: RepoScope;

  /** Personal by default; `spaceRepos` passes the space scope (the member's private chats there). */
  constructor(private readonly principal: Principal, scope?: RepoScope) {
    requireAuth(principal);
    this.scope = scope ?? personalScope(principal);
  }

  private get db() { return getDb(); }

  /**
   * Returns the row only if the principal owns it (or is an admin).
   * Returns null on miss or on cross-tenant access — callers cannot
   * distinguish the two. Phase 4: also narrows to the principal's
   * workspace when set; rows with NULL workspace_id stay visible. An
   * admin's by-id bypass never reaches a session of a space (I2).
   */
  async findById(id: string): Promise<Session | null> {
    if (!isUuid(id)) return null;
    const row = await this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.id, id), ...this.scope.own(sessions, { byId: true }), personalChat))
      .limit(1);
    return row[0] ?? null;
  }

  /** List the principal's own sessions. Admins still get only their own here. */
  async listOwn(limit = 50): Promise<Session[]> {
    return this.db
      .select()
      .from(sessions)
      .where(and(...this.scope.own(sessions), personalChat))
      .orderBy(desc(sessions.updatedAt))
      .limit(limit);
  }

  /**
   * Count the principal's own sessions (unbounded by the list `limit`). Used
   * for the dashboard "sessions" stat, which was wrongly showing the global
   * agent count. Same scope as `listOwn`.
   */
  async countOwn(): Promise<number> {
    const row = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(sessions)
      .where(and(...this.scope.own(sessions), personalChat));
    return row[0]?.count ?? 0;
  }

  /**
   * Admin-only global list. Throws if the principal is not an admin. Never
   * lists a session of a space: admins reach spaces through membership or
   * audited impersonation (§5.5).
   */
  async listAllAdmin(limit = 50): Promise<Session[]> {
    if (!isAdmin(this.principal) || this.scope.kind !== 'personal') throw new UnauthenticatedAccessError();
    return this.db
      .select()
      .from(sessions)
      .where(and(notInSharedWorkspace(sessions.workspaceId), personalChat))
      .orderBy(desc(sessions.updatedAt))
      .limit(limit);
  }

  /**
   * Create a session pinned to the principal. Ignores any user_id in
   * `data`. Phase 4: when the principal carries a workspace context,
   * the new row is stamped with it (unless `data` explicitly sets a
   * workspaceId — useful for admin tools that need to seed rows in a
   * specific workspace). In a space the workspace is always the space's,
   * and a chat there is an agent run: the role must allow `run_agent` and
   * the space must not be archived. A personal create never lands in a space.
   */
  async create(data: Omit<NewSession, 'userId'>): Promise<Session> {
    // Rooms are created by the rooms service only (§6.1).
    assertNotRoomCreate(data);
    this.scope.can('run_agent');
    const stamp = this.scope.stamp();
    const workspaceId = await this.scope.writeWorkspace(data.workspaceId);
    const result = await this.db
      .insert(sessions)
      .values({ ...data, userId: stamp.userId, workspaceId })
      .returning();
    return result[0];
  }

  /** Update only if the principal owns the row (or is an admin). */
  async update(id: string, patch: Partial<NewSession>): Promise<Session | null> {
    if (!isUuid(id)) return null;
    // An archived space reads only, the member's own chats included.
    this.scope.assertOpen();
    // Strip user_id (re-owning a row is never legitimate) and workspace_id
    // (moving a chat into or out of a space is not an edit).
    // ... and `kind` / `room_visibility` (a chat never becomes a room).
    const { userId: _drop, workspaceId: _ws, kind: _kind, roomVisibility: _vis, ...safe } = patch;
    void _drop;
    void _ws;
    void _kind;
    void _vis;
    const result = await this.db
      .update(sessions)
      .set({ ...safe, updatedAt: new Date() })
      .where(and(eq(sessions.id, id), ...this.scope.own(sessions, { byId: true }), personalChat))
      .returning();
    // Archived: its live state (the gateway replay buffer) goes.
    if (result[0] && safe.status === 'completed') sessionsRemoved([id]);
    return result[0] ?? null;
  }

  /** Delete only if owned. Returns false on miss / cross-tenant. */
  async delete(id: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    this.scope.assertOpen();
    const result = await this.db
      .delete(sessions)
      .where(and(eq(sessions.id, id), ...this.scope.own(sessions, { byId: true }), personalChat))
      .returning();
    sessionsRemoved(result.map((row) => row.id));
    return result.length > 0;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Messages
// ─────────────────────────────────────────────────────────────────────

export class ScopedMessageRepo {
  private readonly scope: RepoScope;

  constructor(private readonly principal: Principal, scope?: RepoScope) {
    requireAuth(principal);
    this.scope = scope ?? personalScope(principal);
  }

  private get db() { return getDb(); }

  /**
   * The session filter every message read and write joins through: the
   * principal's own sessions — any session for an admin, but never one of
   * a space (I2) — or, in a space, the member's own sessions there. Not
   * narrowed to the principal's workspace: a session id names one chat
   * wherever it lives.
   */
  private sessionFilter(): SQL[] {
    if (this.scope.kind === 'space') {
      return [eq(sessions.workspaceId, this.scope.spaceId as string), eq(sessions.userId, this.principal.userId), personalChat];
    }
    const filters: SQL[] = [notInSharedWorkspace(sessions.workspaceId), personalChat];
    if (!isAdmin(this.principal)) filters.push(eq(sessions.userId, this.principal.userId));
    return filters;
  }

  /**
   * List messages for a session. Joins through sessions so the filter
   * runs in SQL — callers cannot bypass by smuggling a foreign session id.
   * Returns [] on cross-tenant or missing session.
   */
  async findBySession(
    sessionId: string,
    limit = 100,
    offset = 0,
    roles?: string[],
  ): Promise<Message[]> {
    const filters = [eq(messages.sessionId, sessionId), ...this.sessionFilter()];
    if (roles?.length) {
      filters.push(inArray(messages.role, roles as ('system' | 'user' | 'assistant' | 'tool')[]));
    }

    const rows = await this.db
      .select({ m: messages })
      .from(messages)
      .innerJoin(sessions, eq(messages.sessionId, sessions.id))
      .where(and(...filters))
      .orderBy(asc(messages.createdAt))
      .limit(limit)
      .offset(offset);

    return rows.map((r) => r.m);
  }

  /** Aggregate across multiple sibling sessions; each session is checked individually. */
  async findBySessions(
    sessionIds: string[],
    limit = 100,
    offset = 0,
    roles?: string[],
  ): Promise<Message[]> {
    if (sessionIds.length === 0) return [];
    const filters = [inArray(messages.sessionId, sessionIds), ...this.sessionFilter()];
    if (roles?.length) {
      filters.push(inArray(messages.role, roles as ('system' | 'user' | 'assistant' | 'tool')[]));
    }
    const rows = await this.db
      .select({ m: messages })
      .from(messages)
      .innerJoin(sessions, eq(messages.sessionId, sessions.id))
      .where(and(...filters))
      .orderBy(asc(messages.createdAt))
      .limit(limit)
      .offset(offset);
    return rows.map((r) => r.m);
  }

  async countBySessions(sessionIds: string[]): Promise<number> {
    if (sessionIds.length === 0) return 0;
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(messages)
      .innerJoin(sessions, eq(messages.sessionId, sessions.id))
      .where(and(inArray(messages.sessionId, sessionIds), ...this.sessionFilter()));
    return rows[0]?.count ?? 0;
  }

  /**
   * Insert a message. The caller must already have proven session
   * ownership by loading the session via the scoped session repo;
   * we re-check here so the layer is independently safe. In a space a
   * message is a turn of the member's chat: `run_agent`, not archived.
   */
  async create(data: NewMessage): Promise<Message | null> {
    this.scope.can('run_agent');
    const owns = await this.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.id, data.sessionId), ...this.sessionFilter()))
      .limit(1);
    if (owns.length === 0) return null;
    const result = await this.db.insert(messages).values(data).returning();
    messageEvents.announce(result);
    return result[0];
  }
}

// ─────────────────────────────────────────────────────────────────────
// Agents
// ─────────────────────────────────────────────────────────────────────

export type FinishedAgentRow = Pick<AgentRecord, 'id' | 'role' | 'status' | 'error' | 'durationMs' | 'createdAt' | 'completedAt'>;

export class ScopedAgentRepo {
  private readonly scope: RepoScope;

  constructor(private readonly principal: Principal, scope?: RepoScope) {
    requireAuth(principal);
    this.scope = scope ?? personalScope(principal);
  }

  private get db() { return getDb(); }

  /** Find one agent owned by the principal (or any agent if admin, never one of a space). */
  async findById(id: string): Promise<AgentRecord | null> {
    const row = await this.db
      .select()
      .from(agents)
      .where(and(eq(agents.id, id), ...this.scope.own(agents, { byId: true })))
      .limit(1);
    return row[0] ?? null;
  }

  async listOwn(limit = 200, offset = 0): Promise<AgentRecord[]> {
    return this.db
      .select()
      .from(agents)
      .where(and(...this.scope.own(agents)))
      .orderBy(desc(agents.createdAt))
      .limit(limit)
      .offset(offset);
  }

  /**
   * Agents that reached a terminal state since `since`, newest first — the
   * "what finished while I was away" query. Terminal = completed, failed or
   * stopped; a still-running agent is not news yet.
   */
  async finishedSince(since: Date, limit = 50): Promise<FinishedAgentRow[]> {
    // Projection on purpose: the digest is polled by every open dashboard,
    // and the jsonb columns (toolCalls, metadata) are the bulk of a row.
    return this.db
      .select({ id: agents.id, role: agents.role, status: agents.status, error: agents.error, durationMs: agents.durationMs, createdAt: agents.createdAt, completedAt: agents.completedAt })
      .from(agents)
      .where(and(
        ...this.scope.own(agents),
        inArray(agents.status, ['completed', 'failed', 'stopped']),
        gte(agents.completedAt, since),
      ))
      .orderBy(desc(agents.completedAt))
      .limit(limit);
  }

  /**
   * Admin-only global list and its count. Throws if the principal is not an
   * admin. Never lists an agent of a space (I2): admins reach spaces through
   * membership or audited impersonation (§5.5).
   */
  async listAllAdmin(limit = 200, offset = 0): Promise<AgentRecord[]> {
    if (!isAdmin(this.principal) || this.scope.kind !== 'personal') throw new UnauthenticatedAccessError();
    return this.db
      .select()
      .from(agents)
      .where(notInSharedWorkspace(agents.workspaceId))
      .orderBy(desc(agents.createdAt))
      .limit(limit)
      .offset(offset);
  }

  async countAllAdmin(): Promise<number> {
    if (!isAdmin(this.principal) || this.scope.kind !== 'personal') throw new UnauthenticatedAccessError();
    const [row] = await this.db.select({ c: count() }).from(agents).where(notInSharedWorkspace(agents.workspaceId));
    return row?.c ?? 0;
  }

  /** Count agents owned by the principal — for pagination totals. */
  async countOwn(): Promise<number> {
    const [row] = await this.db
      .select({ c: count() })
      .from(agents)
      .where(and(...this.scope.own(agents)));
    return row?.c ?? 0;
  }

  /** Count agents across the given sessions (owner-scoped). */
  async countBySessions(sessionIds: string[]): Promise<number> {
    if (sessionIds.length === 0) return 0;
    const [row] = await this.db
      .select({ c: count() })
      .from(agents)
      .where(and(inArray(agents.sessionId, sessionIds), ...this.scope.own(agents, { byId: true })));
    return row?.c ?? 0;
  }

  async findBySession(sessionId: string, limit = 50): Promise<AgentRecord[]> {
    return this.db
      .select()
      .from(agents)
      .where(and(eq(agents.sessionId, sessionId), ...this.scope.own(agents, { byId: true })))
      .orderBy(desc(agents.createdAt))
      .limit(limit);
  }

  /**
   * Aggregate across multiple session ids (used for sibling-channel
   * transcripts: telegram restart, slack /clear, etc.). Owner filter
   * still applies — even if a foreign session id sneaks into the list,
   * its rows are silently dropped.
   */
  async findBySessions(sessionIds: string[], limit = 200, offset = 0): Promise<AgentRecord[]> {
    if (sessionIds.length === 0) return [];
    return this.db
      .select()
      .from(agents)
      .where(and(inArray(agents.sessionId, sessionIds), ...this.scope.own(agents, { byId: true })))
      .orderBy(desc(agents.createdAt))
      .limit(limit)
      .offset(offset);
  }

  /** Create an agent pinned to the principal. Phase 4 — stamps workspace_id when set; in a space, always the space's. */
  async create(data: Omit<NewAgentRecord, 'userId'>): Promise<AgentRecord> {
    this.scope.can('run_agent');
    const stamp = this.scope.stamp();
    const workspaceId = await this.scope.writeWorkspace(data.workspaceId);
    const result = await this.db
      .insert(agents)
      .values({ ...data, userId: stamp.userId, workspaceId })
      .returning();
    return result[0];
  }
}

// ─────────────────────────────────────────────────────────────────────
// Documents
// ─────────────────────────────────────────────────────────────────────

/**
 * Documents. In a space every member reads the space's documents and an
 * editor writes them (`SpaceDocumentRepo` is this class with the space
 * scope); the uploader stays on the row as its author (D4).
 */
export class ScopedDocumentRepo {
  protected readonly scope: RepoScope;

  constructor(private readonly principal: Principal, scope?: RepoScope) {
    requireAuth(principal);
    this.scope = scope ?? personalScope(principal);
  }

  private get db() { return getDb(); }

  /**
   * Where an upload of this scope is written: the active workspace's folder
   * of the per-user layout (`SpaceDocumentRepo` writes under the space's).
   */
  uploadDirectory(): string {
    const config = getConfig();
    const documentsRoot = pathResolve(config.workspace.documentsPath || './workspace/documents');
    return pathJoin(documentsRoot, 'users', this.principal.userId, 'workspaces', this.principal.workspaceId ?? 'default', 'uncategorized');
  }

  async findById(id: string): Promise<DocumentRecord | null> {
    if (!isUuid(id)) return null;
    const row = await this.db
      .select()
      .from(documents)
      .where(and(eq(documents.id, id), ...this.scope.shared(documents, { byId: true })))
      .limit(1);
    return row[0] ?? null;
  }

  async listOwn(limit = 50): Promise<DocumentRecord[]> {
    return this.db
      .select()
      .from(documents)
      .where(and(...this.scope.shared(documents)))
      .orderBy(desc(documents.createdAt))
      .limit(limit);
  }

  /** Filter the principal's own documents by category. */
  async listOwnByCategory(category: string, limit = 50): Promise<DocumentRecord[]> {
    return this.db
      .select()
      .from(documents)
      .where(and(...this.scope.shared(documents), eq(documents.category, category)))
      .orderBy(desc(documents.createdAt))
      .limit(limit);
  }

  async create(data: Omit<NewDocumentRecord, 'userId'>): Promise<DocumentRecord> {
    this.scope.can('write');
    const stamp = this.scope.stamp();
    const workspaceId = await this.scope.writeWorkspace(data.workspaceId);
    const result = await this.db
      .insert(documents)
      .values({ ...data, userId: stamp.userId, workspaceId })
      .returning();
    return result[0];
  }

  async delete(id: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    this.scope.can('write');
    const result = await this.db
      .delete(documents)
      .where(and(eq(documents.id, id), ...this.scope.shared(documents, { byId: true })))
      .returning();
    return result.length > 0;
  }

  /** Update status — restricted to documents the principal may write. */
  async updateStatus(id: string, status: DocumentRecord['status'], error?: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    this.scope.can('write');
    const result = await this.db
      .update(documents)
      .set({
        status,
        ...(error ? { metadata: { error } } : {}),
      })
      .where(and(eq(documents.id, id), ...this.scope.shared(documents, { byId: true })))
      .returning();
    return result.length > 0;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Notifications
// ─────────────────────────────────────────────────────────────────────

export interface NotificationListFilter {
  /** Only unread rows. */
  unread?: boolean;
  /** Only rows whose `type` starts with this (e.g. `agent`, `pipeline`, `approval`). */
  typePrefix?: string;
}

/** A member's inbox; in a space, the notifications that space filed for them. */
export class ScopedNotificationRepo {
  private readonly scope: RepoScope;

  constructor(private readonly principal: Principal, scope?: RepoScope) {
    requireAuth(principal);
    this.scope = scope ?? personalScope(principal);
  }

  private get db() { return getDb(); }

  /**
   * Newest first. Filters apply in SQL so paging is over the filtered set —
   * an inbox that filters client-side over one page hides every match that
   * fell outside it.
   */
  async list(limit = 50, offset = 0, filter: NotificationListFilter = {}): Promise<Notification[]> {
    const filters: SQL[] = [...this.scope.own(notifications)];
    if (filter.unread) filters.push(eq(notifications.read, false));
    if (filter.typePrefix) filters.push(sql`${notifications.type} LIKE ${`${filter.typePrefix.replace(/[%_\\]/g, '\\$&')}%`}`);
    return this.db
      .select()
      .from(notifications)
      .where(and(...filters))
      .orderBy(desc(notifications.createdAt))
      .limit(limit)
      .offset(offset);
  }

  /** Unread rows for the principal; `since` narrows to rows created at/after it. */
  async unreadCount(since?: Date): Promise<number> {
    const filters: SQL[] = [...this.scope.own(notifications), eq(notifications.read, false)];
    if (since) filters.push(gte(notifications.createdAt, since));
    const [row] = await this.db
      .select({ c: count() })
      .from(notifications)
      .where(and(...filters));
    return Number(row?.c ?? 0);
  }

  /**
   * Mark a single notification read — only when the principal owns it.
   * Returns true on success; false if the row is missing or owned by
   * another user (cross-tenant attempts are silent no-ops).
   */
  async markRead(id: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    const result = await this.db
      .update(notifications)
      .set({ read: true })
      .where(and(eq(notifications.id, id), ...this.scope.own(notifications, { byId: true })))
      .returning();
    return result.length > 0;
  }

  /** Mark every unread notification for the principal as read. */
  async markAllRead(): Promise<void> {
    await this.db
      .update(notifications)
      .set({ read: true })
      .where(and(...this.scope.own(notifications), eq(notifications.read, false)));
  }
}

// ─────────────────────────────────────────────────────────────────────
// Trajectories
// ─────────────────────────────────────────────────────────────────────

export interface TrajectoryFilter {
  outcome?: 'success' | 'failure' | 'partial' | 'cancelled';
  from?: Date;
  to?: Date;
  limit?: number;
}

export class ScopedTrajectoryRepo {
  constructor(private readonly principal: Principal) {
    requireAuth(principal);
  }

  private get db() { return getDb(); }

  /**
   * List trajectory runs. Non-admins see only their own runs. Admins
   * see everyone's — these audit logs are operationally useful, and an
   * admin browsing them is intentional.
   */
  async list(filter: TrajectoryFilter = {}): Promise<TrajectoryRunRecord[]> {
    const conds: (SQL | undefined)[] = [];
    if (!isAdmin(this.principal)) {
      conds.push(eq(trajectoryRuns.userId, this.principal.userId));
    }
    conds.push(workspaceFilter(this.principal, trajectoryRuns.workspaceId));
    if (filter.outcome) conds.push(eq(trajectoryRuns.outcome, filter.outcome));
    if (filter.from) conds.push(sql`${trajectoryRuns.startedAt} >= ${filter.from}`);
    if (filter.to)   conds.push(sql`${trajectoryRuns.startedAt} <= ${filter.to}`);

    const where = conds.filter((c): c is SQL => c !== undefined);
    return this.db
      .select()
      .from(trajectoryRuns)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(trajectoryRuns.startedAt))
      .limit(filter.limit ?? 100);
  }

  async findById(id: string): Promise<TrajectoryRunRecord | null> {
    if (!isUuid(id)) return null;
    const filters: (SQL | undefined)[] = [eq(trajectoryRuns.id, id)];
    if (!isAdmin(this.principal)) filters.push(eq(trajectoryRuns.userId, this.principal.userId));
    filters.push(workspaceFilter(this.principal, trajectoryRuns.workspaceId));
    const row = await this.db
      .select()
      .from(trajectoryRuns)
      .where(and(...filters.filter((f): f is SQL => f !== undefined)))
      .limit(1);
    return row[0] ?? null;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Hooks
// ─────────────────────────────────────────────────────────────────────

export class ScopedHookRepo {
  constructor(private readonly principal: Principal) {
    requireAuth(principal);
  }

  private get db() { return getDb(); }

  /**
   * Returns the hook only if the principal owns it (or is an admin).
   * Mutating endpoints in the hooks route call this before delegating
   * to the hookManager so the manager's existing methods stay simple.
   */
  async findById(id: string): Promise<Hook | null> {
    if (!isUuid(id)) return null;
    const filters: (SQL | undefined)[] = [eq(hooks.id, id)];
    if (!isAdmin(this.principal)) filters.push(eq(hooks.userId, this.principal.userId));
    filters.push(workspaceFilter(this.principal, hooks.workspaceId));
    const row = await this.db
      .select()
      .from(hooks)
      .where(and(...filters.filter((f): f is SQL => f !== undefined)))
      .limit(1);
    return row[0] ?? null;
  }

  async listOwn(): Promise<Hook[]> {
    const filters: (SQL | undefined)[] = [eq(hooks.userId, this.principal.userId)];
    filters.push(workspaceFilter(this.principal, hooks.workspaceId));
    return this.db
      .select()
      .from(hooks)
      .where(and(...filters.filter((f): f is SQL => f !== undefined)))
      .orderBy(desc(hooks.createdAt));
  }
}

// ─────────────────────────────────────────────────────────────────────
// Pipelines & templates
// ─────────────────────────────────────────────────────────────────────

export type ChangedPipelineRow = Pick<Pipeline, 'id' | 'title' | 'status' | 'summary' | 'updatedAt'>;

export class ScopedPipelineRepo {
  private readonly scope: RepoScope;

  constructor(private readonly principal: Principal, scope?: RepoScope) {
    requireAuth(principal);
    this.scope = scope ?? personalScope(principal);
  }

  private get db() { return getDb(); }

  /**
   * The pipeline when the principal owns it (any for an admin), wherever it
   * runs — but never one of a space through the personal door (I2); in a
   * space, the member's own pipelines there.
   */
  async findById(id: string): Promise<Pipeline | null> {
    if (!isUuid(id)) return null;
    const scope = this.scope.kind === 'space'
      ? this.scope.own(pipelines)
      : [notInSharedWorkspace(pipelines.workspaceId), ...(isAdmin(this.principal) ? [] : [eq(pipelines.userId, this.principal.userId)])];
    const row = await this.db.select().from(pipelines).where(and(eq(pipelines.id, id), ...scope)).limit(1);
    return row[0] ?? null;
  }

  /**
   * Pipelines that reached a state worth reporting since `since`, newest
   * change first: finished, failed, or now waiting on the user (`paused` /
   * `awaiting_approval`). `updated_at` moves on every node transition, which
   * is why the status filter is there — a run that is still going is not
   * news yet, however many nodes it crossed.
   */
  async changedSince(since: Date, limit = 50): Promise<ChangedPipelineRow[]> {
    return this.db
      .select({ id: pipelines.id, title: pipelines.title, status: pipelines.status, summary: pipelines.summary, updatedAt: pipelines.updatedAt })
      .from(pipelines)
      .where(and(
        ...this.scope.own(pipelines),
        inArray(pipelines.status, ['paused', 'awaiting_approval', 'completed', 'failed']),
        gte(pipelines.updatedAt, since),
      ))
      .orderBy(desc(pipelines.updatedAt))
      .limit(limit);
  }

  /**
   * Pipeline templates have a different ownership model: rows with
   * `is_preset=true` are visible to every user (system-shipped templates),
   * but private templates belong to one user. `findTemplateById` returns
   * null when the principal is neither the owner nor looking at a preset.
   */
  async findTemplateById(id: string): Promise<PipelineTemplate | null> {
    if (!isUuid(id)) return null;
    if (isAdmin(this.principal)) {
      const row = await this.db.select().from(pipelineTemplates).where(eq(pipelineTemplates.id, id)).limit(1);
      return row[0] ?? null;
    }
    const row = await this.db
      .select()
      .from(pipelineTemplates)
      .where(and(
        eq(pipelineTemplates.id, id),
        sql`(${pipelineTemplates.userId} = ${this.principal.userId} OR ${pipelineTemplates.isPreset} = TRUE)`,
      ))
      .limit(1);
    return row[0] ?? null;
  }

  /**
   * Look up a template the principal is allowed to *modify*. Presets are
   * read-only — this returns null even if the row exists, so the route's
   * write paths short-circuit to "not found".
   */
  async findOwnedTemplateById(id: string): Promise<PipelineTemplate | null> {
    if (!isUuid(id)) return null;
    const where = isAdmin(this.principal)
      ? eq(pipelineTemplates.id, id)
      : and(
          eq(pipelineTemplates.id, id),
          eq(pipelineTemplates.userId, this.principal.userId),
        );
    const row = await this.db.select().from(pipelineTemplates).where(where).limit(1);
    return row[0] ?? null;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Background jobs (research runs, document processing)
// ─────────────────────────────────────────────────────────────────────

export type ChangedJobRow = Pick<BackgroundJob, 'id' | 'kind' | 'title' | 'status' | 'error' | 'resultRef' | 'updatedAt' | 'finishedAt'>;

/** Read side of `background_jobs`: the poller and the digest. Writes are the workers' (`BackgroundJobRepository`). */
export class ScopedJobRepo {
  constructor(private readonly principal: Principal) {
    requireAuth(principal);
  }

  private get db() { return getDb(); }

  /** The job only if the principal owns it (or is an admin): a foreign id is indistinguishable from a missing one. */
  async findById(id: string): Promise<BackgroundJob | null> {
    if (!isUuid(id)) return null;
    const filters: (SQL | undefined)[] = [eq(backgroundJobs.id, id)];
    if (!isAdmin(this.principal)) filters.push(eq(backgroundJobs.userId, this.principal.userId));
    filters.push(workspaceFilter(this.principal, backgroundJobs.workspaceId));
    const rows = await this.db
      .select()
      .from(backgroundJobs)
      .where(and(...filters.filter((f): f is SQL => f !== undefined)))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Jobs that reached a terminal state since `since`, newest first. A job
   * still running is not news; one the restart killed is, which is why
   * `interrupted` counts.
   */
  async finishedSince(since: Date, limit = 50): Promise<ChangedJobRow[]> {
    const filters: (SQL | undefined)[] = [
      eq(backgroundJobs.userId, this.principal.userId),
      inArray(backgroundJobs.status, ['done', 'error', 'interrupted']),
      gte(backgroundJobs.updatedAt, since),
    ];
    filters.push(workspaceFilter(this.principal, backgroundJobs.workspaceId));
    return this.db
      .select({
        id: backgroundJobs.id,
        kind: backgroundJobs.kind,
        title: backgroundJobs.title,
        status: backgroundJobs.status,
        error: backgroundJobs.error,
        resultRef: backgroundJobs.resultRef,
        updatedAt: backgroundJobs.updatedAt,
        finishedAt: backgroundJobs.finishedAt,
      })
      .from(backgroundJobs)
      .where(and(...filters.filter((f): f is SQL => f !== undefined)))
      .orderBy(desc(backgroundJobs.updatedAt))
      .limit(limit);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Tasks (personal todos — feature #6)
// ─────────────────────────────────────────────────────────────────────

export interface TaskListFilter {
  /** Restrict to one status ('open' | 'in_progress' | 'done' | 'archived'). */
  status?: string;
  /** Restrict to any of these statuses (e.g. the active pair). Ignored when `status` is set. */
  statuses?: string[];
  /** Only tasks due on/before this instant (for "what's due today"). */
  dueBefore?: Date;
  /** Restrict to a user category/list (exact match; '' / 'none' → uncategorized). */
  category?: string;
  /** Restrict to an assignee kind ('user' | 'role' | 'node'); with `assigneeRef`, to one assignee. */
  assigneeKind?: string;
  assigneeRef?: string;
  limit?: number;
}

/**
 * Outcome of a board checkout. `conflict` carries the current holder (null
 * when nobody holds it but the task is done or archived); `blocked` carries
 * what the task is still waiting on.
 */
export type TaskCheckoutResult =
  | { ok: true; task: Task }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'conflict'; holder: string | null; status: string }
  | { ok: false; reason: 'blocked'; waiting: WaitingOn };

export type TaskReleaseResult =
  | { ok: true; task: Task }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'conflict'; holder: string | null };

/** The owner / workspace columns scoping reads, on `tasks` or an alias of it. */
export type TaskScopeColumns = ScopeColumns & { sourceRef: AnyPgColumn };

/**
 * A guest's tasks (S6): those raised from a room of their scope
 * (`source_ref.sessionId`). No room reaches none.
 */
export function guestTaskFilter(t: TaskScopeColumns, guest: GuestScope): SQL {
  if (guest.rooms.length === 0) return sql`FALSE`;
  return inArray(sql`(${t.sourceRef} ->> 'sessionId')`, guest.rooms);
}

/**
 * The board's lease rule as a condition on `tasks`: nobody holds the row, or
 * the holder's lease (TASK_CHECKOUT_TTL_MS) has lapsed, or (with `actor`)
 * `actor` is the holder. Judged on the database clock only — `checked_out_at`
 * is written with now() as well. Shared by the checkout and the role
 * heartbeat's probe (core/heartbeat.ts) so both read one rule.
 */
export function taskLeaseFree(actor?: string): SQL {
  const lease = sql.raw(`interval '${Math.floor(TASK_CHECKOUT_TTL_MS / 1000)} seconds'`);
  const holder = actor === undefined ? sql`` : sql` OR ${tasks.checkedOutBy} = ${actor}`;
  return sql`(${tasks.checkedOutBy} IS NULL${holder} OR ${tasks.checkedOutAt} < now() - ${lease})`;
}

/**
 * `waitingOn` (core/tasks/structure.ts) as conditions on a row of `tasks`: no
 * active blocker and no active child, each read through `scope` (a blocker
 * outside it does not block). The outer row is written as "tasks" explicitly
 * so the correlation cannot bind to the alias. Shared by the checkout and the
 * role heartbeat's probe.
 */
export function taskNotWaiting(scope: (t: TaskScopeColumns) => SQL[]): SQL[] {
  const db = getDb();
  const blocker = alias(tasks, 'task_blocker');
  const child = alias(tasks, 'task_child');
  const active = [...ACTIVE_TASK_STATUSES];
  return [
    notExists(db.select({ one: sql`1` }).from(blocker).where(and(
      sql`${blocker.id} = ANY("tasks"."blocked_by")`,
      sql`${blocker.id} <> "tasks"."id"`,
      inArray(blocker.status, active),
      ...scope(blocker),
    ))),
    notExists(db.select({ one: sql`1` }).from(child).where(and(
      sql`${child.parentId} = "tasks"."id"`,
      sql`${child.id} <> "tasks"."id"`,
      inArray(child.status, active),
      ...scope(child),
    ))),
  ];
}

export type CreatedTaskRow = Pick<Task, 'id' | 'title' | 'source' | 'createdAt'>;

/**
 * Tasks through one `RepoScope` (docs/plans/coworking-spec.md §5.5): every
 * read — `listOwn` and `createdSince` included — uses the scope's filter,
 * every write stamps the scope's author and workspace (a caller's
 * `data.workspaceId` is ignored) and checks the scope's `can`. The personal
 * scope is the owner and the personal workspace rule (`ScopedTaskRepo`); the
 * space scope is every member's tasks of one space, written by editors and
 * commented on by commenters.
 */
export class TaskRepo {
  protected readonly principal: Principal;

  constructor(protected readonly taskScope: RepoScope) {
    this.principal = taskScope.principal;
  }

  private get db() { return getDb(); }

  /** Returns the task only if the scope reaches it (a personal admin's by-id bypass included). */
  async findById(id: string): Promise<Task | null> {
    if (!isUuid(id)) return null;
    const row = await this.db
      .select()
      .from(tasks)
      .where(this.scopeWhere(id))
      .limit(1);
    return row[0] ?? null;
  }

  /** List the scope's tasks (the principal's own, or the space's), newest-first, optionally filtered. */
  async listOwn(filter: TaskListFilter = {}): Promise<Task[]> {
    const filters: SQL[] = [...this.rows(tasks)];
    if (filter.status) filters.push(eq(tasks.status, filter.status));
    else if (filter.statuses?.length) filters.push(inArray(tasks.status, filter.statuses));
    if (filter.dueBefore) filters.push(sql`${tasks.dueAt} IS NOT NULL AND ${tasks.dueAt} <= ${filter.dueBefore}`);
    if (filter.category !== undefined) {
      const c = filter.category.trim();
      // '' / 'none' selects the uncategorized bucket; otherwise exact match.
      filters.push(c === '' || c.toLowerCase() === 'none' ? sql`${tasks.category} IS NULL` : eq(tasks.category, c));
    }
    if (filter.assigneeKind) filters.push(eq(tasks.assigneeKind, filter.assigneeKind));
    if (filter.assigneeRef) filters.push(eq(tasks.assigneeRef, filter.assigneeRef));
    return this.db
      .select()
      .from(tasks)
      .where(and(...filters))
      .orderBy(asc(tasks.status), desc(tasks.priority), asc(tasks.dueAt), desc(tasks.createdAt))
      .limit(filter.limit ?? 200);
  }

  /**
   * Tasks created since `since` by something other than the user (an agent,
   * email triage, research, the reader) — the ones the user has not seen yet.
   */
  async createdSince(since: Date, opts: { excludeSource?: string; limit?: number } = {}): Promise<CreatedTaskRow[]> {
    const filters: SQL[] = [...this.rows(tasks), gte(tasks.createdAt, since)];
    if (opts.excludeSource) filters.push(ne(tasks.source, opts.excludeSource));
    return this.db
      .select({ id: tasks.id, title: tasks.title, source: tasks.source, createdAt: tasks.createdAt })
      .from(tasks)
      .where(and(...filters))
      .orderBy(desc(tasks.createdAt))
      .limit(opts.limit ?? 50);
  }

  /**
   * The subset of `ids` the scope reaches (workspace-scoped like every
   * other read). Cross-tenant and unknown ids simply do not come back.
   */
  async ownedIds(ids: readonly string[]): Promise<Set<string>> {
    const valid = [...new Set(ids.filter(isUuid))];
    if (valid.length === 0) return new Set();
    const rows = await this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(inArray(tasks.id, valid), ...this.scope()));
    return new Set(rows.map((r) => r.id));
  }

  /**
   * Check the structural fields of a write before it happens: the parent
   * and every blocker must be tasks the principal can see (a foreign id is
   * "not found", never a link across tenants), a task cannot be its own
   * parent or blocker, and re-parenting cannot close a loop. Throws with a
   * message fit for the API's 400 / the tool's `error` field.
   */
  private async checkStructure(patch: Partial<NewTask>, selfId?: string): Promise<void> {
    const parentId = patch.parentId ?? null;
    const blockedBy = patch.blockedBy ?? [];
    if (parentId && parentId === selfId) throw new Error('A task cannot be its own parent');
    if (selfId && blockedBy.includes(selfId)) throw new Error('A task cannot block itself');
    const wanted = [...(parentId ? [parentId] : []), ...blockedBy];
    if (wanted.length === 0) return;
    const owned = await this.ownedIds(wanted);
    if (parentId && !owned.has(parentId)) throw new Error('Parent task not found');
    const missing = blockedBy.find((id) => !owned.has(id));
    if (missing) throw new Error(`Blocking task not found: ${missing}`);
    if (parentId && selfId) {
      // Walk up from the proposed parent; reaching ourselves is a cycle.
      // Bounded: only a loop already in the data could run past the cap.
      let cursor: string | null = parentId;
      for (let depth = 0; cursor; depth += 1) {
        if (cursor === selfId || depth >= 50) throw new Error('That parent would make the task its own ancestor');
        const row: Task | null = await this.findById(cursor);
        cursor = row?.parentId ?? null;
      }
    }
  }

  /**
   * Check the assignee of a write (§5.5). A user assignee is told when the
   * task wakes (core/tasks/wakeups.ts), so it must be someone the task is
   * theirs to see: in a space a member (not a guest; a role or a node never
   * — role agents and heartbeats are personal automation and never run a
   * space task), personally the task's owner. Throws with a message fit for
   * the API's 400 / the tool's `error` field.
   */
  private async checkAssignee(kind: string | null | undefined, ref: string | null | undefined, owner: string): Promise<void> {
    if (!kind) return;
    if (this.taskScope.kind === 'space') {
      if (kind !== 'user') throw new SpaceError('invalid_input', 'A space task is assigned to a member, never to a role or a node');
      const { getMembership } = await import('@/core/spaces/service');
      const member = ref ? await getMembership(ref, this.taskScope.spaceId as string) : null;
      if (!member || member.role === 'guest') throw new SpaceError('invalid_input', 'The assignee is not a member of this space');
      return;
    }
    if (kind === 'user' && ref !== owner) throw new Error('A personal task can be assigned only to its owner');
  }

  /** The row a task write stamps: the scope's author, in the scope's workspace (never a space from the personal door). */
  private async stampRow(): Promise<{ userId: string; workspaceId: string | null }> {
    return { userId: this.taskScope.stamp().userId, workspaceId: await this.taskScope.writeWorkspace() };
  }

  /**
   * Create a task in the scope. Ignores any user_id and workspace_id in
   * `data`: the row is the scope's author's, in the scope's workspace.
   */
  async create(data: Omit<NewTask, 'userId'>): Promise<Task> {
    this.taskScope.can('write');
    await this.checkStructure(data);
    const stamp = await this.stampRow();
    await this.checkAssignee(data.assigneeKind, data.assigneeRef, stamp.userId);
    const result = await this.db
      .insert(tasks)
      .values({ ...data, ...stamp })
      .returning();
    return result[0];
  }

  /**
   * Idempotent source ingestion; a retry returns the existing owned task.
   * `created` says whether this call inserted the row (false on a retry, and
   * for the loser of a concurrent insert).
   */
  async createOnce(data: Omit<NewTask, 'userId'> & { id: string }): Promise<{ task: Task; created: boolean }> {
    this.taskScope.can('write');
    await this.checkStructure(data);
    const stamp = await this.stampRow();
    await this.checkAssignee(data.assigneeKind, data.assigneeRef, stamp.userId);
    const [created] = await this.db.insert(tasks).values({ ...data, ...stamp })
      .onConflictDoNothing({ target: tasks.id }).returning();
    if (created) return { task: created, created: true };
    const existing = await this.findById(data.id);
    if (!existing) throw new Error('Source task conflicts with an inaccessible task');
    return { task: existing, created: false };
  }

  /**
   * Update only if the scope reaches the row. `completedAt` is managed by the route/tool. With
   * `asActor` (the tasks tool) the write also requires that no one else holds
   * a live checkout, in the same UPDATE (every guarded UPDATE below carries
   * it); a refused write returns null like a miss, and the caller re-reads to
   * tell which. Without it (the user's routes) the write overrides any
   * checkout. Leaving the active lanes or going back to open clears the
   * checkout.
   *
   * This and `delete` are the only paths a task leaves the active set by
   * (the PATCH/DELETE routes, the update/complete tools, anything else
   * holding a scoped repo), so the dependency wakeups hang off them. A
   * close (a status in TASK_STATUSES that is not active) runs as guarded
   * UPDATEs, each atomic because Postgres re-checks the guard under the
   * row lock:
   *
   *   1. `… AND status IN (active)`: a hit is a real active → closed
   *      transition, and concurrent closes of one task cannot both win it;
   *   2. on a miss, `… AND status NOT IN (active)`: already closed, a
   *      plain edit of a closed task, nothing fires;
   *   3. if both miss (reopened between the two, or not owned), one last
   *      unguarded UPDATE whose RETURNING subquery reports the pre-update
   *      status from the statement snapshot; active there fires too.
   *
   * `updatedAt` is always set, so (updatedAt, id) orders closes for the
   * sibling rule in core/tasks/wakeups.ts. The wakeup itself is detached
   * (`scheduleWakeup`): it never adds latency to, or fails, the write.
   */
  async update(id: string, patch: Partial<NewTask>, opts: { asActor?: string } = {}): Promise<Task | null> {
    if (!isUuid(id)) return null;
    this.taskScope.can('write');
    // Neither the author nor the workspace changes on an edit.
    const { userId: _drop, workspaceId: _ws, ...safe } = patch;
    void _drop;
    void _ws;
    if (safe.parentId !== undefined || safe.blockedBy !== undefined) await this.checkStructure(safe, id);
    if (safe.assigneeKind !== undefined || safe.assigneeRef !== undefined) {
      const current = await this.findById(id);
      if (!current) return null;
      await this.checkAssignee(
        safe.assigneeKind !== undefined ? safe.assigneeKind : current.assigneeKind,
        safe.assigneeRef !== undefined ? safe.assigneeRef : current.assigneeRef,
        current.userId,
      );
    }
    // Leaving the active lanes (done, archived) or going back to open ends the
    // work, so it ends the checkout too.
    const release = safe.status !== undefined && (safe.status === 'open' || !isActiveStatus(safe.status))
      ? { checkedOutBy: null, checkedOutAt: null, checkoutRunId: null }
      : {};
    const holderCheck = opts.asActor !== undefined ? [this.leaseFree(opts.asActor)] : [];
    const where = (...extra: SQL[]) => this.scopeWhere(id, ...holderCheck, ...extra);
    const values = { ...safe, ...release, updatedAt: new Date() };
    const withPrevious = {
      ...getTableColumns(tasks),
      previousStatus: sql<string>`(SELECT p.status FROM tasks p WHERE p.id = tasks.id)`,
    };
    if (!(isTaskStatus(safe.status) && !isActiveStatus(safe.status))) {
      const result = await this.db.update(tasks).set(values).where(where()).returning();
      return result[0] ?? null;
    }
    const active = inArray(tasks.status, [...ACTIVE_TASK_STATUSES]);
    const [won] = await this.db.update(tasks).set(values).where(where(active)).returning(withPrevious);
    if (won) return this.closedBy(won);
    const [stillClosed] = await this.db
      .update(tasks)
      .set(values)
      .where(where(notInArray(tasks.status, [...ACTIVE_TASK_STATUSES])))
      .returning();
    if (stillClosed) return stillClosed;
    const [last] = await this.db.update(tasks).set(values).where(where()).returning(withPrevious);
    return last ? this.closedBy(last) : null;
  }

  /**
   * The scope's filters on `t` (the tasks table or an alias of it). Every
   * task read and write by id goes through here, so tenant scoping lives in
   * one place.
   */
  private scope(t: TaskScopeColumns = tasks): SQL[] {
    return this.rows(t, { byId: true });
  }

  /** The rows the scope reaches: shared ones, or a guest's (their rooms' tasks, S6). */
  private rows(t: TaskScopeColumns, opts?: { byId?: boolean }): SQL[] {
    const guest = this.taskScope.guest;
    if (guest) return [eq(t.workspaceId, this.taskScope.spaceId as string), guestTaskFilter(t, guest)];
    return this.taskScope.shared(t, opts);
  }

  /** `id` plus the scope filters, and any extra conditions. */
  private scopeWhere(id: string, ...extra: SQL[]): SQL | undefined {
    return and(eq(tasks.id, id), ...this.scope(), ...extra);
  }

  /**
   * What `task` is waiting on: its active blockers and active children,
   * read scoped (a blocker the principal cannot see does not block).
   */
  private async waitingOnFor(task: Task): Promise<WaitingOn> {
    const related: SQL[] = [eq(tasks.parentId, task.id)];
    if (task.blockedBy.length > 0) related.push(inArray(tasks.id, task.blockedBy));
    const rows = await this.db
      .select({ id: tasks.id, title: tasks.title, status: tasks.status, parentId: tasks.parentId, blockedBy: tasks.blockedBy })
      .from(tasks)
      .where(and(sql`(${sql.join(related, sql` OR `)})`, inArray(tasks.status, [...ACTIVE_TASK_STATUSES]), ...this.scope()));
    return waitingOn(task, toLookup(rows));
  }

  /** `actor` may write the row (see `taskLeaseFree`). */
  private leaseFree(actor: string): SQL {
    return taskLeaseFree(actor);
  }

  /** `waitingOnFor` as conditions on the row being updated (see `taskNotWaiting`). */
  private notWaiting(): SQL[] {
    return taskNotWaiting((t) => this.scope(t));
  }

  /**
   * Claim a task for `actor` (work board, after Paperclip). The claim is one
   * conditional UPDATE — active status, not waiting on an open blocker or open
   * sub-tasks, and no live holder other than `actor` — so of two concurrent
   * claimers exactly one gets the row back. A checkout is a lease
   * (TASK_CHECKOUT_TTL_MS, core/tasks/checkout.ts): a claim not renewed within
   * it can be taken over, which is how a crashed agent's claim clears.
   * Re-checkout by the holder is idempotent and renews the lease. Claiming
   * moves the task to in_progress. On a miss the task is re-read to say why:
   * gone, closed, blocked (with what it waits on), or held by someone else.
   */
  async checkout(id: string, actor: string, runId: string | null = null): Promise<TaskCheckoutResult> {
    const existing = await this.findById(id);
    if (!existing) return { ok: false, reason: 'not_found' };
    this.taskScope.can('write');
    if (!isActiveStatus(existing.status)) return { ok: false, reason: 'conflict', holder: existing.checkedOutBy, status: existing.status };
    // The holder renews without the blocked rule (it may have split its own
    // task into sub-tasks); anyone else claims only a free, unblocked task.
    const [claimed] = await this.db
      .update(tasks)
      .set({ checkedOutBy: actor, checkedOutAt: sql`now()`, checkoutRunId: runId, status: 'in_progress', updatedAt: new Date() })
      .where(this.scopeWhere(
        id,
        inArray(tasks.status, [...ACTIVE_TASK_STATUSES]),
        or(eq(tasks.checkedOutBy, actor), and(this.leaseFree(actor), ...this.notWaiting())) as SQL,
      ))
      .returning();
    if (claimed) return { ok: true, task: claimed };
    const current = await this.findById(id);
    if (!current) return { ok: false, reason: 'not_found' };
    if (!isActiveStatus(current.status)) return { ok: false, reason: 'conflict', holder: current.checkedOutBy, status: current.status };
    const waiting = await this.waitingOnFor(current);
    if (waiting.blockers.length > 0 || waiting.openChildren > 0) return { ok: false, reason: 'blocked', waiting };
    return { ok: false, reason: 'conflict', holder: current.checkedOutBy, status: current.status };
  }

  /**
   * Give a checkout back. Only the holder may release unless `force` (the
   * owner clearing a dead agent's claim). A task that was being worked goes
   * back to open. Releasing a task nobody holds writes nothing and succeeds.
   */
  async release(id: string, actor: string, opts: { force?: boolean } = {}): Promise<TaskReleaseResult> {
    if (!isUuid(id)) return { ok: false, reason: 'not_found' };
    this.taskScope.can('write');
    const holderCheck = opts.force ? [] : [eq(tasks.checkedOutBy, actor)];
    const [released] = await this.db
      .update(tasks)
      .set({
        status: sql`CASE WHEN ${tasks.status} = 'in_progress' THEN 'open' ELSE ${tasks.status} END`,
        checkedOutBy: null,
        checkedOutAt: null,
        checkoutRunId: null,
        updatedAt: new Date(),
      })
      .where(this.scopeWhere(id, sql`${tasks.checkedOutBy} IS NOT NULL`, ...holderCheck))
      .returning();
    if (released) return { ok: true, task: released };
    const current = await this.findById(id);
    if (!current) return { ok: false, reason: 'not_found' };
    if (!current.checkedOutBy) return { ok: true, task: current };
    return { ok: false, reason: 'conflict', holder: current.checkedOutBy };
  }

  /**
   * Add a comment to a task the scope reaches; null when the task is not
   * visible. A personal comment is filed under the task's owner; in a space
   * the commenting member is the comment's `user_id` (its author, D4).
   */
  async addComment(taskId: string, comment: { authorKind: 'user' | 'agent'; authorRef: string; body: string }): Promise<TaskComment | null> {
    const task = await this.findById(taskId);
    if (!task) return null;
    this.taskScope.can('comment');
    const userId = this.taskScope.kind === 'space' ? this.taskScope.stamp().userId : task.userId;
    const [row] = await this.db
      .insert(taskComments)
      .values({ ...comment, taskId: task.id, userId })
      .returning();
    return row;
  }

  /**
   * The newest `limit` comments of a task, oldest first; `truncated` says
   * older ones were left out. Null when the task is not visible. In a space
   * the thread holds every member's comments.
   */
  async listComments(taskId: string, limit = 200): Promise<{ comments: TaskComment[]; truncated: boolean } | null> {
    const task = await this.findById(taskId);
    if (!task) return null;
    const authors = this.taskScope.kind === 'space' ? [] : [eq(taskComments.userId, task.userId)];
    const newest = await this.db
      .select()
      .from(taskComments)
      .where(and(eq(taskComments.taskId, task.id), ...authors))
      .orderBy(desc(taskComments.createdAt), desc(taskComments.id))
      .limit(limit + 1);
    return { comments: newest.slice(0, limit).reverse(), truncated: newest.length > limit };
  }

  /** Strip the RETURNING extra and wake when the row was active before the write. */
  private closedBy(row: Task & { previousStatus: string }): Task {
    const { previousStatus, ...closed } = row;
    this.wakeAfter(closed, previousStatus, 'closed');
    return closed;
  }

  /** Run the close listeners and the wakeups for a task that just left the active set, detached. */
  private wakeAfter(closed: Task, previousStatus: string, cause: WakeupCause): void {
    if (!isActiveStatus(previousStatus)) return;
    scheduleWakeup(async () => {
      await notifyTaskClosed({ task: closed, previousStatus, cause });
      const context = await this.wakeupContext(closed);
      await dispatchWakeups({ closed, previousStatus, cause, ...context });
    });
  }

  /**
   * The rows needed to decide what closing `closed` woke, read in the
   * scope the task lives in: a personal task's owner across their personal
   * workspaces (no workspace narrowing: a blocker in another of the owner's
   * workspaces still blocks; never a space's rows), or a space task's
   * space (every member's tasks there). Loads, uncapped: active tasks whose
   * `blockedBy` holds it, every other blocker those tasks name, the parent,
   * the parent's active children and its latest-closed other child (for the
   * sibling order). A named blocker outside the scope is looked up by id
   * alone: if the row exists (only reachable by raw SQL) it is `unknownIds`
   * and counts as blocking; if it is gone it is a deleted blocker and inert.
   */
  async wakeupContext(closed: Task): Promise<{ rows: Task[]; unknownIds: string[] }> {
    const owner = this.taskScope.kind === 'space'
      ? eq(tasks.workspaceId, this.taskScope.spaceId as string)
      : and(eq(tasks.userId, closed.userId), notInSharedWorkspace(tasks.workspaceId)) as SQL;
    const active = inArray(tasks.status, [...ACTIVE_TASK_STATUSES]);
    const byId = new Map<string, Task>();
    const dependents = await this.db
      .select()
      .from(tasks)
      .where(and(owner, active, arrayContains(tasks.blockedBy, [closed.id])));
    for (const row of dependents) byId.set(row.id, row);
    if (closed.parentId) {
      const family = await this.db
        .select()
        .from(tasks)
        .where(and(owner, sql`(${tasks.id} = ${closed.parentId} OR (${tasks.parentId} = ${closed.parentId} AND ${active}))`));
      for (const row of family) byId.set(row.id, row);
      // The latest-closed sibling (by the (updatedAt, id) order), for the
      // "last child closes it" rule: one row, whatever the family size.
      const [latestClosed] = await this.db
        .select()
        .from(tasks)
        .where(and(owner, eq(tasks.parentId, closed.parentId), ne(tasks.id, closed.id), notInArray(tasks.status, [...ACTIVE_TASK_STATUSES])))
        .orderBy(desc(tasks.updatedAt), desc(tasks.id))
        .limit(1);
      if (latestClosed) byId.set(latestClosed.id, latestClosed);
    }
    const named = [...new Set(dependents.flatMap((d) => d.blockedBy ?? []))]
      .filter((b) => b !== closed.id && !byId.has(b) && isUuid(b));
    let unknownIds: string[] = [];
    if (named.length > 0) {
      const found = await this.db.select().from(tasks).where(and(owner, inArray(tasks.id, named)));
      for (const row of found) byId.set(row.id, row);
      const missing = named.filter((b) => !byId.has(b));
      if (missing.length > 0) {
        // Existence only (ids, never data): a foreign row is unknown, so conservatively blocking.
        const foreign = await this.db.select({ id: tasks.id }).from(tasks).where(inArray(tasks.id, missing));
        unknownIds = foreign.map((r) => r.id);
      }
    }
    byId.delete(closed.id);
    return { rows: [...byId.values()], unknownIds };
  }

  /**
   * Delete only if the scope reaches the row. Returns false on miss /
   * cross-tenant. Deleting an active task can free its dependents or finish
   * its parent just as closing it does; DELETE … RETURNING hands back the
   * row atomically.
   */
  async delete(id: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    this.taskScope.can('write');
    const result = await this.db.delete(tasks).where(this.scopeWhere(id)).returning();
    const gone = result[0];
    // A delete ranks at the moment it happened in the sibling order.
    if (gone) this.wakeAfter({ ...gone, updatedAt: new Date() }, gone.status, 'deleted');
    return result.length > 0;
  }
}

/** Personal tasks (feature #6): `TaskRepo` in the principal's personal scope. */
export class ScopedTaskRepo extends TaskRepo {
  constructor(principal: Principal) {
    super(personalScope(principal));
  }
}

// ─────────────────────────────────────────────────────────────────────
// Bundle factory
// ─────────────────────────────────────────────────────────────────────

export interface ScopedRepos {
  sessions: ScopedSessionRepo;
  messages: ScopedMessageRepo;
  agents: ScopedAgentRepo;
  documents: ScopedDocumentRepo;
  notifications: ScopedNotificationRepo;
  trajectories: ScopedTrajectoryRepo;
  hooks: ScopedHookRepo;
  pipelines: ScopedPipelineRepo;
  tasks: ScopedTaskRepo;
  jobs: ScopedJobRepo;
}

/**
 * Build a bundle of scoped repositories for the given principal. Used by
 * route handlers and root agent code paths that should never see data
 * outside the current principal's tenant.
 *
 * Throws `UnauthenticatedAccessError` if called with an anonymous
 * principal — that's a bug at the call site, not a runtime condition.
 */
export function scopedRepos(principal: Principal): ScopedRepos {
  // The personal door (D3): refuses a principal acting in a space.
  const scope = personalScope(principal);
  return {
    sessions: new ScopedSessionRepo(principal, scope),
    messages: new ScopedMessageRepo(principal, scope),
    agents: new ScopedAgentRepo(principal, scope),
    documents: new ScopedDocumentRepo(principal, scope),
    notifications: new ScopedNotificationRepo(principal, scope),
    trajectories: new ScopedTrajectoryRepo(principal),
    hooks: new ScopedHookRepo(principal),
    pipelines: new ScopedPipelineRepo(principal, scope),
    tasks: new ScopedTaskRepo(principal),
    jobs: new ScopedJobRepo(principal),
  };
}
