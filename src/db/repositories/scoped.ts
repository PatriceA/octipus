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
 *
 * When `multiuser.enabled` is false the wrapper still works — a
 * single-user install simply has every row owned by the bootstrap admin,
 * so every scope check passes. There's no functional change for v0
 * deployments.
 */

import { and, asc, desc, eq, inArray, type SQL, sql } from 'drizzle-orm';
import { isAdmin, isAuthenticated, type Principal } from '@/security/principal';
import { getDb } from '../postgres';
import { type AgentRecord, agents, type NewAgentRecord } from '../schema/agents';
import { type DocumentRecord, documents, type NewDocumentRecord } from '../schema/documents';
import { type Hook, hooks } from '../schema/hooks';
import { type Message, messages, type NewMessage } from '../schema/messages';
import { type Notification, notifications } from '../schema/notifications';
import { type PipelineTemplate, pipelineTemplates } from '../schema/pipeline-templates';
import { type Pipeline, pipelines } from '../schema/pipelines';
import { type NewSession, type Session, sessions } from '../schema/sessions';
import { type NewTask, type Task, tasks } from '../schema/tasks';
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
 * Phase 4 — workspace scoping helper.
 *
 * Returns a Drizzle filter narrowing rows to the principal's
 * workspace, OR a no-op when the principal has no workspace context
 * (feature flag off, or the row is "user-level"). Rows with a NULL
 * `workspace_id` are included alongside the matching workspace —
 * NULL means "visible to every workspace owned by this user", so
 * un-backfilled rows stay visible after the runtime starts
 * filtering.
 *
 * Admins are NOT exempted from this filter. An admin browsing their
 * own UI under a specific workspace should see only that
 * workspace's rows; the global view is reached via the explicit
 * `*Admin` methods that don't go through scoping.
 */
function workspaceFilter(
  principal: Principal,
  column: { name: string } | typeof sessions.workspaceId,
): SQL | undefined {
  const wsId = principal.workspaceId;
  if (!wsId) return undefined;
  return sql`(${column} = ${wsId} OR ${column} IS NULL)`;
}

// ─────────────────────────────────────────────────────────────────────
// Sessions
// ─────────────────────────────────────────────────────────────────────

export class ScopedSessionRepo {
  constructor(private readonly principal: Principal) {
    requireAuth(principal);
  }

  private get db() { return getDb(); }

  /**
   * Returns the row only if the principal owns it (or is an admin).
   * Returns null on miss or on cross-tenant access — callers cannot
   * distinguish the two. Phase 4: also narrows to the principal's
   * workspace when set; rows with NULL workspace_id stay visible.
   */
  async findById(id: string): Promise<Session | null> {
    const filters: (SQL | undefined)[] = [eq(sessions.id, id)];
    if (!isAdmin(this.principal)) filters.push(eq(sessions.userId, this.principal.userId));
    filters.push(workspaceFilter(this.principal, sessions.workspaceId));
    const row = await this.db
      .select()
      .from(sessions)
      .where(and(...filters.filter((f): f is SQL => f !== undefined)))
      .limit(1);
    return row[0] ?? null;
  }

  /** List the principal's own sessions. Admins still get only their own here. */
  async listOwn(limit = 50): Promise<Session[]> {
    const filters: (SQL | undefined)[] = [eq(sessions.userId, this.principal.userId)];
    filters.push(workspaceFilter(this.principal, sessions.workspaceId));
    return this.db
      .select()
      .from(sessions)
      .where(and(...filters.filter((f): f is SQL => f !== undefined)))
      .orderBy(desc(sessions.updatedAt))
      .limit(limit);
  }

  /**
   * Count the principal's own sessions (unbounded by the list `limit`). Used
   * for the dashboard "sessions" stat, which was wrongly showing the global
   * agent count. Same scope as `listOwn`.
   */
  async countOwn(): Promise<number> {
    const filters: (SQL | undefined)[] = [eq(sessions.userId, this.principal.userId)];
    filters.push(workspaceFilter(this.principal, sessions.workspaceId));
    const row = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(sessions)
      .where(and(...filters.filter((f): f is SQL => f !== undefined)));
    return row[0]?.count ?? 0;
  }

  /** Admin-only global list. Throws if the principal is not an admin. */
  async listAllAdmin(limit = 50): Promise<Session[]> {
    if (!isAdmin(this.principal)) throw new UnauthenticatedAccessError();
    return this.db.select().from(sessions).orderBy(desc(sessions.updatedAt)).limit(limit);
  }

  /**
   * Create a session pinned to the principal. Ignores any user_id in
   * `data`. Phase 4: when the principal carries a workspace context,
   * the new row is stamped with it (unless `data` explicitly sets a
   * workspaceId — useful for admin tools that need to seed rows in a
   * specific workspace).
   */
  async create(data: Omit<NewSession, 'userId'>): Promise<Session> {
    const result = await this.db
      .insert(sessions)
      .values({
        ...data,
        userId: this.principal.userId,
        workspaceId: data.workspaceId ?? this.principal.workspaceId ?? null,
      })
      .returning();
    return result[0];
  }

  /** Update only if the principal owns the row (or is an admin). */
  async update(id: string, patch: Partial<NewSession>): Promise<Session | null> {
    // Strip user_id from caller-supplied patch — re-owning a row is never legitimate.
    const { userId: _drop, ...safe } = patch;
    void _drop;
    const filters: (SQL | undefined)[] = [eq(sessions.id, id)];
    if (!isAdmin(this.principal)) filters.push(eq(sessions.userId, this.principal.userId));
    filters.push(workspaceFilter(this.principal, sessions.workspaceId));
    const result = await this.db
      .update(sessions)
      .set({ ...safe, updatedAt: new Date() })
      .where(and(...filters.filter((f): f is SQL => f !== undefined)))
      .returning();
    return result[0] ?? null;
  }

  /** Delete only if owned. Returns false on miss / cross-tenant. */
  async delete(id: string): Promise<boolean> {
    const filters: (SQL | undefined)[] = [eq(sessions.id, id)];
    if (!isAdmin(this.principal)) filters.push(eq(sessions.userId, this.principal.userId));
    filters.push(workspaceFilter(this.principal, sessions.workspaceId));
    const result = await this.db
      .delete(sessions)
      .where(and(...filters.filter((f): f is SQL => f !== undefined)))
      .returning();
    return result.length > 0;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Messages
// ─────────────────────────────────────────────────────────────────────

export class ScopedMessageRepo {
  constructor(private readonly principal: Principal) {
    requireAuth(principal);
  }

  private get db() { return getDb(); }

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
    const filters = [eq(messages.sessionId, sessionId)];
    if (!isAdmin(this.principal)) {
      filters.push(eq(sessions.userId, this.principal.userId));
    }
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
    const filters = [inArray(messages.sessionId, sessionIds)];
    if (!isAdmin(this.principal)) {
      filters.push(eq(sessions.userId, this.principal.userId));
    }
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
    const filters = [inArray(messages.sessionId, sessionIds)];
    if (!isAdmin(this.principal)) filters.push(eq(sessions.userId, this.principal.userId));
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(messages)
      .innerJoin(sessions, eq(messages.sessionId, sessions.id))
      .where(and(...filters));
    return rows[0]?.count ?? 0;
  }

  /**
   * Insert a message. The caller must already have proven session
   * ownership by loading the session via the scoped session repo;
   * we re-check here so the layer is independently safe.
   */
  async create(data: NewMessage): Promise<Message | null> {
    const ownedFilters = [eq(sessions.id, data.sessionId)];
    if (!isAdmin(this.principal)) ownedFilters.push(eq(sessions.userId, this.principal.userId));
    const owns = await this.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(...ownedFilters))
      .limit(1);
    if (owns.length === 0) return null;
    const result = await this.db.insert(messages).values(data).returning();
    return result[0];
  }
}

// ─────────────────────────────────────────────────────────────────────
// Agents
// ─────────────────────────────────────────────────────────────────────

export class ScopedAgentRepo {
  constructor(private readonly principal: Principal) {
    requireAuth(principal);
  }

  private get db() { return getDb(); }

  /** Find one agent owned by the principal (or any agent if admin). */
  async findById(id: string): Promise<AgentRecord | null> {
    const filters: (SQL | undefined)[] = [eq(agents.id, id)];
    if (!isAdmin(this.principal)) filters.push(eq(agents.userId, this.principal.userId));
    filters.push(workspaceFilter(this.principal, agents.workspaceId));
    const row = await this.db
      .select()
      .from(agents)
      .where(and(...filters.filter((f): f is SQL => f !== undefined)))
      .limit(1);
    return row[0] ?? null;
  }

  async listOwn(limit = 200): Promise<AgentRecord[]> {
    const filters: (SQL | undefined)[] = [eq(agents.userId, this.principal.userId)];
    filters.push(workspaceFilter(this.principal, agents.workspaceId));
    return this.db
      .select()
      .from(agents)
      .where(and(...filters.filter((f): f is SQL => f !== undefined)))
      .orderBy(desc(agents.createdAt))
      .limit(limit);
  }

  async findBySession(sessionId: string, limit = 50): Promise<AgentRecord[]> {
    const filters: (SQL | undefined)[] = [eq(agents.sessionId, sessionId)];
    if (!isAdmin(this.principal)) filters.push(eq(agents.userId, this.principal.userId));
    filters.push(workspaceFilter(this.principal, agents.workspaceId));
    return this.db
      .select()
      .from(agents)
      .where(and(...filters.filter((f): f is SQL => f !== undefined)))
      .orderBy(desc(agents.createdAt))
      .limit(limit);
  }

  /**
   * Aggregate across multiple session ids (used for sibling-channel
   * transcripts: telegram restart, slack /clear, etc.). Owner filter
   * still applies — even if a foreign session id sneaks into the list,
   * its rows are silently dropped.
   */
  async findBySessions(sessionIds: string[], limit = 200): Promise<AgentRecord[]> {
    if (sessionIds.length === 0) return [];
    const filters: (SQL | undefined)[] = [inArray(agents.sessionId, sessionIds)];
    if (!isAdmin(this.principal)) filters.push(eq(agents.userId, this.principal.userId));
    filters.push(workspaceFilter(this.principal, agents.workspaceId));
    return this.db
      .select()
      .from(agents)
      .where(and(...filters.filter((f): f is SQL => f !== undefined)))
      .orderBy(desc(agents.createdAt))
      .limit(limit);
  }

  /** Create an agent pinned to the principal. Phase 4 — stamps workspace_id when set. */
  async create(data: Omit<NewAgentRecord, 'userId'>): Promise<AgentRecord> {
    const result = await this.db
      .insert(agents)
      .values({
        ...data,
        userId: this.principal.userId,
        workspaceId: data.workspaceId ?? this.principal.workspaceId ?? null,
      })
      .returning();
    return result[0];
  }
}

// ─────────────────────────────────────────────────────────────────────
// Documents
// ─────────────────────────────────────────────────────────────────────

export class ScopedDocumentRepo {
  constructor(private readonly principal: Principal) {
    requireAuth(principal);
  }

  private get db() { return getDb(); }

  async findById(id: string): Promise<DocumentRecord | null> {
    const filters: (SQL | undefined)[] = [eq(documents.id, id)];
    if (!isAdmin(this.principal)) filters.push(eq(documents.userId, this.principal.userId));
    filters.push(workspaceFilter(this.principal, documents.workspaceId));
    const row = await this.db
      .select()
      .from(documents)
      .where(and(...filters.filter((f): f is SQL => f !== undefined)))
      .limit(1);
    return row[0] ?? null;
  }

  async listOwn(limit = 50): Promise<DocumentRecord[]> {
    const filters: (SQL | undefined)[] = [eq(documents.userId, this.principal.userId)];
    filters.push(workspaceFilter(this.principal, documents.workspaceId));
    return this.db
      .select()
      .from(documents)
      .where(and(...filters.filter((f): f is SQL => f !== undefined)))
      .orderBy(desc(documents.createdAt))
      .limit(limit);
  }

  /** Filter the principal's own documents by category. */
  async listOwnByCategory(category: string, limit = 50): Promise<DocumentRecord[]> {
    const filters: (SQL | undefined)[] = [
      eq(documents.userId, this.principal.userId),
      eq(documents.category, category),
    ];
    filters.push(workspaceFilter(this.principal, documents.workspaceId));
    return this.db
      .select()
      .from(documents)
      .where(and(...filters.filter((f): f is SQL => f !== undefined)))
      .orderBy(desc(documents.createdAt))
      .limit(limit);
  }

  async create(data: Omit<NewDocumentRecord, 'userId'>): Promise<DocumentRecord> {
    const result = await this.db
      .insert(documents)
      .values({
        ...data,
        userId: this.principal.userId,
        workspaceId: data.workspaceId ?? this.principal.workspaceId ?? null,
      })
      .returning();
    return result[0];
  }

  async delete(id: string): Promise<boolean> {
    const filters: (SQL | undefined)[] = [eq(documents.id, id)];
    if (!isAdmin(this.principal)) filters.push(eq(documents.userId, this.principal.userId));
    filters.push(workspaceFilter(this.principal, documents.workspaceId));
    const result = await this.db
      .delete(documents)
      .where(and(...filters.filter((f): f is SQL => f !== undefined)))
      .returning();
    return result.length > 0;
  }

  /** Update status — restricted to documents owned by the principal. */
  async updateStatus(id: string, status: DocumentRecord['status'], error?: string): Promise<boolean> {
    const filters: (SQL | undefined)[] = [eq(documents.id, id)];
    if (!isAdmin(this.principal)) filters.push(eq(documents.userId, this.principal.userId));
    filters.push(workspaceFilter(this.principal, documents.workspaceId));
    const result = await this.db
      .update(documents)
      .set({
        status,
        ...(error ? { metadata: { error } } : {}),
      })
      .where(and(...filters.filter((f): f is SQL => f !== undefined)))
      .returning();
    return result.length > 0;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Notifications
// ─────────────────────────────────────────────────────────────────────

export class ScopedNotificationRepo {
  constructor(private readonly principal: Principal) {
    requireAuth(principal);
  }

  private get db() { return getDb(); }

  async list(limit = 50, offset = 0): Promise<Notification[]> {
    const filters: (SQL | undefined)[] = [eq(notifications.userId, this.principal.userId)];
    filters.push(workspaceFilter(this.principal, notifications.workspaceId));
    return this.db
      .select()
      .from(notifications)
      .where(and(...filters.filter((f): f is SQL => f !== undefined)))
      .orderBy(desc(notifications.createdAt))
      .limit(limit)
      .offset(offset);
  }

  async unreadCount(): Promise<number> {
    const filters: (SQL | undefined)[] = [
      eq(notifications.userId, this.principal.userId),
      eq(notifications.read, false),
    ];
    filters.push(workspaceFilter(this.principal, notifications.workspaceId));
    const rows = await this.db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(...filters.filter((f): f is SQL => f !== undefined)));
    return rows.length;
  }

  /**
   * Mark a single notification read — only when the principal owns it.
   * Returns true on success; false if the row is missing or owned by
   * another user (cross-tenant attempts are silent no-ops).
   */
  async markRead(id: string): Promise<boolean> {
    const filters: (SQL | undefined)[] = [eq(notifications.id, id)];
    if (!isAdmin(this.principal)) filters.push(eq(notifications.userId, this.principal.userId));
    filters.push(workspaceFilter(this.principal, notifications.workspaceId));
    const result = await this.db
      .update(notifications)
      .set({ read: true })
      .where(and(...filters.filter((f): f is SQL => f !== undefined)))
      .returning();
    return result.length > 0;
  }

  /** Mark every unread notification for the principal as read. */
  async markAllRead(): Promise<void> {
    const filters: (SQL | undefined)[] = [
      eq(notifications.userId, this.principal.userId),
      eq(notifications.read, false),
    ];
    filters.push(workspaceFilter(this.principal, notifications.workspaceId));
    await this.db
      .update(notifications)
      .set({ read: true })
      .where(and(...filters.filter((f): f is SQL => f !== undefined)));
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

export class ScopedPipelineRepo {
  constructor(private readonly principal: Principal) {
    requireAuth(principal);
  }

  private get db() { return getDb(); }

  async findById(id: string): Promise<Pipeline | null> {
    const where = isAdmin(this.principal)
      ? eq(pipelines.id, id)
      : and(eq(pipelines.id, id), eq(pipelines.userId, this.principal.userId));
    const row = await this.db.select().from(pipelines).where(where).limit(1);
    return row[0] ?? null;
  }

  /**
   * Pipeline templates have a different ownership model: rows with
   * `is_preset=true` are visible to every user (system-shipped templates),
   * but private templates belong to one user. `findTemplateById` returns
   * null when the principal is neither the owner nor looking at a preset.
   */
  async findTemplateById(id: string): Promise<PipelineTemplate | null> {
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
// Tasks (personal todos — feature #6)
// ─────────────────────────────────────────────────────────────────────

export interface TaskListFilter {
  /** Restrict to a status ('open' | 'done' | 'archived'). */
  status?: string;
  /** Only tasks due on/before this instant (for "what's due today"). */
  dueBefore?: Date;
  limit?: number;
}

export class ScopedTaskRepo {
  constructor(private readonly principal: Principal) {
    requireAuth(principal);
  }

  private get db() { return getDb(); }

  /** Returns the task only if the principal owns it (or is an admin). */
  async findById(id: string): Promise<Task | null> {
    const filters: (SQL | undefined)[] = [eq(tasks.id, id)];
    if (!isAdmin(this.principal)) filters.push(eq(tasks.userId, this.principal.userId));
    filters.push(workspaceFilter(this.principal, tasks.workspaceId));
    const row = await this.db
      .select()
      .from(tasks)
      .where(and(...filters.filter((f): f is SQL => f !== undefined)))
      .limit(1);
    return row[0] ?? null;
  }

  /** List the principal's own tasks, newest-first, optionally filtered. */
  async listOwn(filter: TaskListFilter = {}): Promise<Task[]> {
    const filters: (SQL | undefined)[] = [eq(tasks.userId, this.principal.userId)];
    if (filter.status) filters.push(eq(tasks.status, filter.status));
    if (filter.dueBefore) filters.push(sql`${tasks.dueAt} IS NOT NULL AND ${tasks.dueAt} <= ${filter.dueBefore}`);
    filters.push(workspaceFilter(this.principal, tasks.workspaceId));
    return this.db
      .select()
      .from(tasks)
      .where(and(...filters.filter((f): f is SQL => f !== undefined)))
      .orderBy(asc(tasks.status), desc(tasks.priority), asc(tasks.dueAt), desc(tasks.createdAt))
      .limit(filter.limit ?? 200);
  }

  /** Create a task pinned to the principal. Ignores any user_id in `data`. */
  async create(data: Omit<NewTask, 'userId'>): Promise<Task> {
    const result = await this.db
      .insert(tasks)
      .values({
        ...data,
        userId: this.principal.userId,
        workspaceId: data.workspaceId ?? this.principal.workspaceId ?? null,
      })
      .returning();
    return result[0];
  }

  /** Update only if owned. `completedAt` is managed by the route/tool. */
  async update(id: string, patch: Partial<NewTask>): Promise<Task | null> {
    const { userId: _drop, ...safe } = patch;
    void _drop;
    const filters: (SQL | undefined)[] = [eq(tasks.id, id)];
    if (!isAdmin(this.principal)) filters.push(eq(tasks.userId, this.principal.userId));
    filters.push(workspaceFilter(this.principal, tasks.workspaceId));
    const result = await this.db
      .update(tasks)
      .set({ ...safe, updatedAt: new Date() })
      .where(and(...filters.filter((f): f is SQL => f !== undefined)))
      .returning();
    return result[0] ?? null;
  }

  /** Delete only if owned. Returns false on miss / cross-tenant. */
  async delete(id: string): Promise<boolean> {
    const filters: (SQL | undefined)[] = [eq(tasks.id, id)];
    if (!isAdmin(this.principal)) filters.push(eq(tasks.userId, this.principal.userId));
    filters.push(workspaceFilter(this.principal, tasks.workspaceId));
    const result = await this.db
      .delete(tasks)
      .where(and(...filters.filter((f): f is SQL => f !== undefined)))
      .returning();
    return result.length > 0;
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
}

/**
 * Build a bundle of scoped repositories for the given principal. Used by
 * route handlers and orchestrator code paths that should never see data
 * outside the current principal's tenant.
 *
 * Throws `UnauthenticatedAccessError` if called with an anonymous
 * principal — that's a bug at the call site, not a runtime condition.
 */
export function scopedRepos(principal: Principal): ScopedRepos {
  return {
    sessions: new ScopedSessionRepo(principal),
    messages: new ScopedMessageRepo(principal),
    agents: new ScopedAgentRepo(principal),
    documents: new ScopedDocumentRepo(principal),
    notifications: new ScopedNotificationRepo(principal),
    trajectories: new ScopedTrajectoryRepo(principal),
    hooks: new ScopedHookRepo(principal),
    pipelines: new ScopedPipelineRepo(principal),
    tasks: new ScopedTaskRepo(principal),
  };
}
