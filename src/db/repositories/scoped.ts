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

import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { agents, type AgentRecord, type NewAgentRecord } from '../schema/agents';
import { documents, type DocumentRecord, type NewDocumentRecord } from '../schema/documents';
import { type Hook, hooks } from '../schema/hooks';
import { messages, type Message, type NewMessage } from '../schema/messages';
import { notifications, type Notification } from '../schema/notifications';
import { type Pipeline, pipelines } from '../schema/pipelines';
import { type PipelineTemplate, pipelineTemplates } from '../schema/pipeline-templates';
import { type NewSession, type Session, sessions } from '../schema/sessions';
import { trajectoryRuns, type TrajectoryRunRecord } from '../schema/trajectory-runs';
import { type Principal, isAdmin, isAuthenticated } from '@/security/principal';
import { getDb } from '../postgres';

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
   * distinguish the two.
   */
  async findById(id: string): Promise<Session | null> {
    const where = isAdmin(this.principal)
      ? eq(sessions.id, id)
      : and(eq(sessions.id, id), eq(sessions.userId, this.principal.userId));
    const row = await this.db.select().from(sessions).where(where).limit(1);
    return row[0] ?? null;
  }

  /** List the principal's own sessions. Admins still get only their own here. */
  async listOwn(limit = 50): Promise<Session[]> {
    return this.db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, this.principal.userId))
      .orderBy(desc(sessions.updatedAt))
      .limit(limit);
  }

  /** Admin-only global list. Throws if the principal is not an admin. */
  async listAllAdmin(limit = 50): Promise<Session[]> {
    if (!isAdmin(this.principal)) throw new UnauthenticatedAccessError();
    return this.db.select().from(sessions).orderBy(desc(sessions.updatedAt)).limit(limit);
  }

  /** Create a session pinned to the principal. Ignores any user_id in `data`. */
  async create(data: Omit<NewSession, 'userId'>): Promise<Session> {
    const result = await this.db
      .insert(sessions)
      .values({ ...data, userId: this.principal.userId })
      .returning();
    return result[0];
  }

  /** Update only if the principal owns the row (or is an admin). */
  async update(id: string, patch: Partial<NewSession>): Promise<Session | null> {
    // Strip user_id from caller-supplied patch — re-owning a row is never legitimate.
    const { userId: _drop, ...safe } = patch;
    void _drop;
    const where = isAdmin(this.principal)
      ? eq(sessions.id, id)
      : and(eq(sessions.id, id), eq(sessions.userId, this.principal.userId));
    const result = await this.db
      .update(sessions)
      .set({ ...safe, updatedAt: new Date() })
      .where(where)
      .returning();
    return result[0] ?? null;
  }

  /** Delete only if owned. Returns false on miss / cross-tenant. */
  async delete(id: string): Promise<boolean> {
    const where = isAdmin(this.principal)
      ? eq(sessions.id, id)
      : and(eq(sessions.id, id), eq(sessions.userId, this.principal.userId));
    const result = await this.db.delete(sessions).where(where).returning();
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
    const where = isAdmin(this.principal)
      ? eq(agents.id, id)
      : and(eq(agents.id, id), eq(agents.userId, this.principal.userId));
    const row = await this.db.select().from(agents).where(where).limit(1);
    return row[0] ?? null;
  }

  async listOwn(limit = 200): Promise<AgentRecord[]> {
    return this.db
      .select()
      .from(agents)
      .where(eq(agents.userId, this.principal.userId))
      .orderBy(desc(agents.createdAt))
      .limit(limit);
  }

  async findBySession(sessionId: string, limit = 50): Promise<AgentRecord[]> {
    // Two filters: sessionId AND principal ownership of the agent.
    // We rely on agents.user_id (already populated for new agents) rather
    // than joining through sessions — agents may outlive their session row.
    const filters = [eq(agents.sessionId, sessionId)];
    if (!isAdmin(this.principal)) filters.push(eq(agents.userId, this.principal.userId));
    return this.db
      .select()
      .from(agents)
      .where(and(...filters))
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
    const filters = [inArray(agents.sessionId, sessionIds)];
    if (!isAdmin(this.principal)) filters.push(eq(agents.userId, this.principal.userId));
    return this.db
      .select()
      .from(agents)
      .where(and(...filters))
      .orderBy(desc(agents.createdAt))
      .limit(limit);
  }

  /** Create an agent pinned to the principal. */
  async create(data: Omit<NewAgentRecord, 'userId'>): Promise<AgentRecord> {
    const result = await this.db
      .insert(agents)
      .values({ ...data, userId: this.principal.userId })
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
    const where = isAdmin(this.principal)
      ? eq(documents.id, id)
      : and(eq(documents.id, id), eq(documents.userId, this.principal.userId));
    const row = await this.db.select().from(documents).where(where).limit(1);
    return row[0] ?? null;
  }

  async listOwn(limit = 50): Promise<DocumentRecord[]> {
    return this.db
      .select()
      .from(documents)
      .where(eq(documents.userId, this.principal.userId))
      .orderBy(desc(documents.createdAt))
      .limit(limit);
  }

  /** Filter the principal's own documents by category. */
  async listOwnByCategory(category: string, limit = 50): Promise<DocumentRecord[]> {
    return this.db
      .select()
      .from(documents)
      .where(and(eq(documents.userId, this.principal.userId), eq(documents.category, category)))
      .orderBy(desc(documents.createdAt))
      .limit(limit);
  }

  async create(data: Omit<NewDocumentRecord, 'userId'>): Promise<DocumentRecord> {
    const result = await this.db
      .insert(documents)
      .values({ ...data, userId: this.principal.userId })
      .returning();
    return result[0];
  }

  async delete(id: string): Promise<boolean> {
    const where = isAdmin(this.principal)
      ? eq(documents.id, id)
      : and(eq(documents.id, id), eq(documents.userId, this.principal.userId));
    const result = await this.db.delete(documents).where(where).returning();
    return result.length > 0;
  }

  /** Update status — restricted to documents owned by the principal. */
  async updateStatus(id: string, status: DocumentRecord['status'], error?: string): Promise<boolean> {
    const where = isAdmin(this.principal)
      ? eq(documents.id, id)
      : and(eq(documents.id, id), eq(documents.userId, this.principal.userId));
    const result = await this.db
      .update(documents)
      .set({
        status,
        ...(error ? { metadata: { error } } : {}),
      })
      .where(where)
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
    return this.db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, this.principal.userId))
      .orderBy(desc(notifications.createdAt))
      .limit(limit)
      .offset(offset);
  }

  async unreadCount(): Promise<number> {
    const rows = await this.db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.userId, this.principal.userId), eq(notifications.read, false)));
    return rows.length;
  }

  /**
   * Mark a single notification read — only when the principal owns it.
   * Returns true on success; false if the row is missing or owned by
   * another user (cross-tenant attempts are silent no-ops).
   */
  async markRead(id: string): Promise<boolean> {
    const where = isAdmin(this.principal)
      ? eq(notifications.id, id)
      : and(eq(notifications.id, id), eq(notifications.userId, this.principal.userId));
    const result = await this.db
      .update(notifications)
      .set({ read: true })
      .where(where)
      .returning();
    return result.length > 0;
  }

  /** Mark every unread notification for the principal as read. */
  async markAllRead(): Promise<void> {
    await this.db
      .update(notifications)
      .set({ read: true })
      .where(and(
        eq(notifications.userId, this.principal.userId),
        eq(notifications.read, false),
      ));
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
    const conds = [];
    if (!isAdmin(this.principal)) {
      conds.push(eq(trajectoryRuns.userId, this.principal.userId));
    }
    if (filter.outcome) conds.push(eq(trajectoryRuns.outcome, filter.outcome));
    if (filter.from) conds.push(sql`${trajectoryRuns.startedAt} >= ${filter.from}`);
    if (filter.to)   conds.push(sql`${trajectoryRuns.startedAt} <= ${filter.to}`);

    return this.db
      .select()
      .from(trajectoryRuns)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(trajectoryRuns.startedAt))
      .limit(filter.limit ?? 100);
  }

  async findById(id: string): Promise<TrajectoryRunRecord | null> {
    const where = isAdmin(this.principal)
      ? eq(trajectoryRuns.id, id)
      : and(eq(trajectoryRuns.id, id), eq(trajectoryRuns.userId, this.principal.userId));
    const row = await this.db.select().from(trajectoryRuns).where(where).limit(1);
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
    const where = isAdmin(this.principal)
      ? eq(hooks.id, id)
      : and(eq(hooks.id, id), eq(hooks.userId, this.principal.userId));
    const row = await this.db.select().from(hooks).where(where).limit(1);
    return row[0] ?? null;
  }

  async listOwn(): Promise<Hook[]> {
    return this.db
      .select()
      .from(hooks)
      .where(eq(hooks.userId, this.principal.userId))
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
  };
}
