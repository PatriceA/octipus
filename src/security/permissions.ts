import { and, eq, sql } from 'drizzle-orm';
import type { AgentContext, PermissionLevel } from '@/core/types';
import { getDb } from '@/db/postgres';
import { auditRepository } from '@/db/repositories/audit-repository';
import {
  type NewPermissionRequest,
  type PermissionCondition,
  type PermissionRequest,
  permissionRequests,
  type RateLimitConfig,
  type ToolPermission,
  toolPermissions,
} from '@/db/schema/permissions';
import { getToolRegistry } from '@/tools/registry';
import { generateId } from '@/utils/crypto';
import { coreLogger, securityLogger } from '@/utils/logger';
import { safeRegExp } from '@/utils/sanitize';

/**
 * Permission requests do not expire. A human takes as long as a human takes,
 * and the old 5-minute TTL denied the call out from under them — the agent
 * reported "rejected, expired, or undeliverable" for a request the user was
 * still reading. A wait ends when it is answered, or when the agent it belongs
 * to is stopped (`cancelWaits`).
 */

export interface PermissionCheckResult {
  source?: string;
  allowed: boolean;
  level: PermissionLevel;
  requiresApproval: boolean;
  requestId?: string;
  reason?: string;
}

/**
 * Payload broadcast when a tool call needs interactive approval. Emitted by
 * `requestApproval` and consumed by the gateway event bridge (→ WS clients) and
 * the TUI permission prompt. Field names are load-bearing — keep them in sync
 * with the `emitRequest({...})` call in `requestApproval`.
 */
export interface PermissionRequestEvent {
  requestId: string;
  userId: string;
  agentId: string;
  toolId: string;
  action: string;
  toolName: string;
  args: Record<string, unknown>;
  sessionId?: string;
}

export class PermissionManager {
  private get db() { return getDb(); }
  private preparedWaits = new Map<string, Promise<boolean>>();
  private pendingRequests: Map<string, (approved: boolean, resolution?: string) => void> = new Map();
  /** requestIds currently awaited, by the agent that is blocked on them. */
  private waitsByAgent: Map<string, Set<string>> = new Map();
  /** Notified when an agent starts or stops waiting on a human. */
  private waitListeners: Set<(agentId: string, waiting: boolean) => void> = new Set();
  private requestListeners: Set<(request: PermissionRequestEvent) => void> = new Set();

  /**
   * Subscribe to new permission requests (for WebSocket forwarding)
   */
  onRequest(handler: (request: PermissionRequestEvent) => void): () => void {
    this.requestListeners.add(handler);
    return () => this.requestListeners.delete(handler);
  }

  private emitRequest(request: PermissionRequestEvent): void {
    for (const handler of this.requestListeners) {
      try { handler(request); } catch { /* ignore */ }
    }
  }

  /**
   * Check if an action is permitted.
   * Evaluation order: rule engine (deny→allow→ask) → DB policy → tool default.
   */
  /** Does the tool's own manifest mark this action `dangerous`? */
  private isDangerousAction(toolId: string, action: string): boolean {
    try {
      const manifest = getToolRegistry().get(toolId)?.getManifest();
      return manifest?.permissions?.some((p) => p.action === action && p.dangerous === true) ?? false;
    } catch {
      // Registry not ready — treat as not-dangerous so boot-time checks behave
      // exactly as they did before this guard existed.
      return false;
    }
  }

  async check(
    userId: string,
    toolId: string,
    action: string,
    context?: Record<string, unknown>,
    scope?: Pick<AgentContext, 'sessionId' | 'workspaceId'>,
    options?: { revalidate?: boolean; defaultLevel?: PermissionLevel; dangerous?: boolean },
  ): Promise<PermissionCheckResult> {
    // 2. Get permission configuration from DB
    const permission = await this.db
      .select()
      .from(toolPermissions)
      .where(
        and(
          eq(toolPermissions.userId, userId),
          eq(toolPermissions.toolId, toolId),
          eq(toolPermissions.action, action)
        )
      )
      .limit(1);

    // Stored DENY cannot be overridden by broad allow rules or grant expiry.
    if (permission[0]?.level === 'DENY') {
      return { allowed: false, level: 'DENY', requiresApproval: false,
        reason: 'Action is denied by policy', source: `permission:${permission[0].id}` };
    }
    const { getPermissionRuleEngine } = await import('./permission-rules');
    const rule = getPermissionRuleEngine().evaluate(toolId, action, context);
    if (rule?.decision === 'deny') {
      return { allowed: false, level: 'DENY', requiresApproval: false,
        reason: `Denied by rule: ${rule.rule}`, source: 'rule' };
    }
    // Explicit per-user policies take precedence over broad allow/ask rules.
    if (!permission[0] && rule && !(rule.decision === 'allow' && (options?.dangerous ?? this.isDangerousAction(toolId, action)))) {
      const allowed = rule.decision === 'allow';
      return { allowed, level: allowed ? 'ALLOW' : 'ASK', requiresApproval: !allowed, source: 'rule' };
    }

    // Fall back to the tool's default permission level, or ASK if not found
    let defaultLevel: PermissionLevel = options?.defaultLevel ?? 'ASK';
    try {
      const registry = getToolRegistry();
      const toolInstance = registry.get(toolId);
      if (toolInstance) {
        const manifest = toolInstance.getManifest();
        const perm = manifest.permissions?.find((p: any) => p.action === action);
        if (perm?.defaultLevel) {
          defaultLevel = perm.defaultLevel as PermissionLevel;
        }
      }
    } catch { /* registry not ready yet */ }
    const level: PermissionLevel = permission[0]?.level || defaultLevel;

    // Check expiration
    if (permission[0]?.expiresAt && permission[0].expiresAt < new Date()) {
      return {
        allowed: false,
        level: 'ASK',
        requiresApproval: true,
        reason: 'Permission expired',
      };
    }

    // Check conditions if any
    if (permission[0]?.conditions?.length) {
      const conditionsResult = await this.checkConditions(
        permission[0].conditions as PermissionCondition[],
        context ?? {},
        { userId, toolId, action },
        scope,
        options,
      );
      if (!conditionsResult.passed) {
        return {
          allowed: false,
          level: 'ASK',
          requiresApproval: true,
          reason: conditionsResult.reason,
        };
      }
    }

    switch (level) {
      case 'ALLOW':
        return {
          allowed: true,
          level: 'ALLOW',
          requiresApproval: false,
          source: permission[0] ? `permission:${permission[0].id}` : 'manifest',
        };

      case 'ASK':
      default:
        return {
          allowed: false,
          level: 'ASK',
          requiresApproval: true,
        };
    }
  }

  /**
   * Check permission conditions
   */
  private async checkConditions(
    conditions: PermissionCondition[],
    context: Record<string, unknown>,
    identity: { userId: string; toolId: string; action: string },
    scope?: Pick<AgentContext, 'sessionId' | 'workspaceId'>,
    options?: { revalidate?: boolean },
  ): Promise<{ passed: boolean; reason?: string }> {
    for (const condition of conditions) {
      switch (condition.type) {
        case 'session':
        case 'workspace': {
          const actual = condition.type === 'session' ? scope?.sessionId : scope?.workspaceId;
          if (!actual || actual !== condition.value) return { passed: false, reason: 'Outside permission scope' };
          break;
        }
        case 'path_pattern': {
          const paths = ['path', 'source', 'destination', 'file_path', 'filePath', 'directory', 'cwd']
            .flatMap(key => typeof context[key] === 'string' ? [context[key] as string] : []);
          if (!paths.length || typeof condition.value !== 'string') return { passed: false, reason: 'Required path scope is missing' };
          const pattern = safeRegExp(condition.value);
          if (!pattern || paths.some(path => !pattern.test(path))) {
            return { passed: false, reason: 'A path is outside the permitted pattern' };
          }
          break;
        }

        case 'command_pattern': {
          const command = context.command as string;
          if (!command || typeof condition.value !== 'string') return { passed: false, reason: 'Required command scope is missing' };
          if (command && typeof condition.value === 'string') {
            const pattern = safeRegExp(condition.value);
            if (!pattern) {
              return { passed: false, reason: 'Invalid or too complex command pattern' };
            }
            if (!pattern.test(command)) {
              return { passed: false, reason: `Command does not match pattern: ${condition.value}` };
            }
          }
          break;
        }

        case 'time_window': {
          const window = condition.value as { startHour: number; endHour: number; daysOfWeek?: number[] };
          const now = new Date();
          const hour = now.getHours();
          const day = now.getDay();

          if (hour < window.startHour || hour >= window.endHour) {
            return { passed: false, reason: 'Outside allowed time window' };
          }

          if (window.daysOfWeek && !window.daysOfWeek.includes(day)) {
            return { passed: false, reason: 'Outside allowed days' };
          }
          break;
        }

        case 'rate_limit': {
          if (options?.revalidate) break;
          const cfg = condition.value as RateLimitConfig;
          if (!cfg || !Number.isFinite(cfg.maxRequests) || !Number.isFinite(cfg.windowMs) || cfg.maxRequests <= 0 || cfg.windowMs <= 0) {
            // Fail loud: a misconfigured rate-limit policy must not silently
            // grant access (DESIGN.md rule #1).
            return { passed: false, reason: 'Invalid rate_limit condition (maxRequests/windowMs)' };
          }
          const { getRateLimiter } = await import('./rate-limiter');
          const key = `perm:rl:${identity.userId}:${identity.toolId}:${identity.action}`;
          const windowSecs = Math.max(1, Math.ceil(cfg.windowMs / 1000));
          const result = await getRateLimiter().check(key, cfg.maxRequests, windowSecs);
          if (!result.allowed) {
            return { passed: false, reason: `Rate limit exceeded (${cfg.maxRequests}/${windowSecs}s); retry in ${result.retryAfter}s` };
          }
          break;
        }
        default: return { passed: false, reason: `Unsupported permission condition: ${condition.type}` };
      }
    }

    return { passed: true };
  }

  /**
   * Request permission approval
   */
  async requestApproval(
    userId: string,
    agentId: string,
    toolId: string,
    action: string,
    context: Record<string, unknown>,
    sessionId?: string,
    callerToolName?: string,
  ): Promise<string> {
    const requestId = generateId();

    const request: NewPermissionRequest = {
      id: requestId,
      userId,
      agentId,
      sessionId,
      toolId,
      action,
      context: {
        toolName: callerToolName || action,
        toolArguments: context,
      },
    };

    await this.db.insert(permissionRequests).values(request);
    // Install the waiter before notifying clients: a fast answer must not be lost.
    this.preparedWaits.set(requestId, this.waitForApproval(requestId, { agentId }));

    await auditRepository.log({
      userId,
      action: 'permission_requested',
      resourceType: 'permission',
      resourceId: requestId,
      sessionId,
      details: { toolId, action, agentId },
    });

    securityLogger.info({ requestId, userId, toolId, action, callerToolName }, 'Permission requested');

    // Notify WebSocket listeners
    this.emitRequest({
      requestId,
      userId,
      agentId,
      toolId,
      action,
      toolName: callerToolName || action,
      args: context,
      sessionId,
    });

    return requestId;
  }

  /**
   * Wait for permission approval
   */
  async waitForApproval(
    requestId: string,
    opts?: { agentId?: string; timeoutMs?: number },
  ): Promise<boolean> {
    const prepared = this.preparedWaits.get(requestId);
    if (prepared) {
      this.preparedWaits.delete(requestId);
      if (!opts?.timeoutMs || opts.timeoutMs <= 0) return prepared;
      const timeout = setTimeout(() => {
        const settle = this.pendingRequests.get(requestId);
        if (!settle) return;
        this.expireRequest(requestId).catch(err => coreLogger.error({ err }, 'Could not expire approval'));
        settle(false);
      }, opts.timeoutMs);
      try { return await prepared; } finally { clearTimeout(timeout); }
    }
    return new Promise((resolve) => {
      const settle = (approved: boolean) => {
        this.pendingRequests.delete(requestId);
        this.untrackWait(opts?.agentId, requestId);
        resolve(approved);
      };
      this.pendingRequests.set(requestId, settle);
      this.trackWait(opts?.agentId, requestId);

      // No deadline unless a caller explicitly asks for one. Nothing in the
      // product does; the option exists for a caller that genuinely cannot
      // block (a batch job), not as a default.
      if (opts?.timeoutMs && opts.timeoutMs > 0) {
        setTimeout(() => {
          if (!this.pendingRequests.has(requestId)) return;
          this.expireRequest(requestId).catch((err: unknown) =>
            coreLogger.error({ err }, 'background task failed in permissions'));
          settle(false);
        }, opts.timeoutMs);
      }
    });
  }

  /**
   * Release every wait belonging to `agentId`, as unapproved. Called when a
   * worker is stopped: without it, an aborted agent would sit on an
   * unanswerable request forever now that the requests have no TTL.
   */
  cancelWaits(agentId: string): number {
    const requestIds = this.waitsByAgent.get(agentId);
    const count = requestIds?.size ?? 0;
    for (const requestId of [...(requestIds ?? [])]) {
      const callback = this.pendingRequests.get(requestId);
      // `callback` is the `settle` closure, which untracks the wait and emits
      // the wait-state-off transition once the agent's set drains — don't
      // duplicate either here.
      callback?.(false);
    }
    // Also expire the ROWS, including any this process isn't waiting on: an
    // agent killed as a cross-process zombie (agent-manager's not-in-memory
    // branch, the orphan reaper) leaves a pending request nobody will ever
    // answer, and with no TTL it would sit in the approvals list forever.
    this.expireRequestsForAgent(agentId).catch((err: unknown) =>
      coreLogger.error({ err, agentId }, 'background task failed in permissions'));
    if (count > 0) securityLogger.info({ agentId, count }, 'Permission waits cancelled with the agent');
    return count;
  }

  /** Expire every pending request belonging to an agent. */
  private async expireRequestsForAgent(agentId: string): Promise<void> {
    await this.db
      .update(permissionRequests)
      .set({ status: 'expired' })
      .where(and(eq(permissionRequests.agentId, agentId), eq(permissionRequests.status, 'pending')));
  }

  /**
   * Subscribe to "this agent is blocked on a human" transitions. The worker
   * uses it to stop its wall clock: with no TTL, a turn would otherwise die of
   * its own timeout while the prompt sat on screen. Returns an unsubscribe.
   */
  onWaitStateChange(listener: (agentId: string, waiting: boolean) => void): () => void {
    this.waitListeners.add(listener);
    return () => this.waitListeners.delete(listener);
  }

  private emitWaitState(agentId: string, waiting: boolean): void {
    for (const listener of this.waitListeners) {
      try {
        listener(agentId, waiting);
      } catch (err) {
        coreLogger.error({ err, agentId }, 'permission wait listener failed');
      }
    }
  }

  private trackWait(agentId: string | undefined, requestId: string): void {
    if (!agentId) return;
    const set = this.waitsByAgent.get(agentId) ?? new Set<string>();
    const wasIdle = set.size === 0;
    set.add(requestId);
    this.waitsByAgent.set(agentId, set);
    if (wasIdle) this.emitWaitState(agentId, true);
  }

  private untrackWait(agentId: string | undefined, requestId: string): void {
    if (!agentId) return;
    const set = this.waitsByAgent.get(agentId);
    if (!set) return;
    set.delete(requestId);
    if (set.size === 0) {
      this.waitsByAgent.delete(agentId);
      this.emitWaitState(agentId, false);
    }
  }

  /**
   * Approve a permission request.
   *
   * Phase 1c: cross-tenant resolution is now blocked. The WHERE clause
   * requires the request's `user_id` to match the principal calling
   * approve. Pre-Phase-1c the gateway handler called this with
   * `context.userId` as `resolvedBy`, but the row update accepted any
   * `requestId` with status='pending' — so any authenticated caller
   * with a leaked requestId could approve another user's request.
   * Now: alice approving bob's requestId is a silent no-op (returns
   * false, same shape as "request id doesn't exist or already
   * resolved"), so attackers can't enumerate live requests by probing.
   *
   * Admins (`{ admin: true }`) bypass the user filter — they may
   * intervene from the admin console once Phase 2 ships.
   */
  async approve(
    requestId: string,
    resolvedBy: string,
    resolution?: string,
    opts?: { admin?: boolean },
  ): Promise<boolean> {
    const filters = [
      eq(permissionRequests.id, requestId),
      eq(permissionRequests.status, 'pending'),
      sql`(${permissionRequests.expiresAt} IS NULL OR ${permissionRequests.expiresAt} > NOW())`,
    ];
    if (!opts?.admin) filters.push(eq(permissionRequests.userId, resolvedBy));

    const result = await this.db
      .update(permissionRequests)
      .set({
        status: 'approved',
        resolvedBy,
        resolvedAt: new Date(),
        resolution,
      })
      .where(and(...filters))
      .returning();

    if (result.length > 0) {
      const request = result[0];

      await auditRepository.log({
        userId: request.userId,
        action: 'permission_granted',
        resourceType: 'permission',
        resourceId: requestId,
        sessionId: request.sessionId || undefined,
        details: { toolId: request.toolId, action: request.action, resolvedBy },
      });

      // Notify waiting code
      const callback = this.pendingRequests.get(requestId);
      if (callback) {
        this.pendingRequests.delete(requestId);
        callback(true, resolution);
      }

      securityLogger.info({ requestId, resolvedBy }, 'Permission approved');
      return true;
    }

    return false;
  }

  /**
   * Deny a permission request. Same cross-tenant guard as `approve`.
   */
  async deny(
    requestId: string,
    resolvedBy: string,
    resolution?: string,
    opts?: { admin?: boolean },
  ): Promise<boolean> {
    const filters = [
      eq(permissionRequests.id, requestId),
      eq(permissionRequests.status, 'pending'),
    ];
    if (!opts?.admin) filters.push(eq(permissionRequests.userId, resolvedBy));

    const result = await this.db
      .update(permissionRequests)
      .set({
        status: 'denied',
        resolvedBy,
        resolvedAt: new Date(),
        resolution,
      })
      .where(and(...filters))
      .returning();

    if (result.length > 0) {
      const request = result[0];

      await auditRepository.log({
        userId: request.userId,
        action: 'permission_denied',
        resourceType: 'permission',
        resourceId: requestId,
        sessionId: request.sessionId || undefined,
        details: { toolId: request.toolId, action: request.action, resolvedBy, reason: resolution },
      });

      // Notify waiting code
      const callback = this.pendingRequests.get(requestId);
      if (callback) {
        this.pendingRequests.delete(requestId);
        callback(false, resolution);
      }

      securityLogger.info({ requestId, resolvedBy, reason: resolution }, 'Permission denied');
      return true;
    }

    return false;
  }

  /**
   * Expire a permission request
   */
  private async expireRequest(requestId: string): Promise<void> {
    await this.db
      .update(permissionRequests)
      .set({ status: 'expired' })
      .where(and(eq(permissionRequests.id, requestId), eq(permissionRequests.status, 'pending')));

    securityLogger.debug({ requestId }, 'Permission request expired');
  }

  /**
   * Mark every request left pending by a previous process as expired.
   *
   * Requests have no deadline any more, and the promise waiting on one lives
   * in this process's memory — so a row still `pending` at boot belongs to an
   * agent that no longer exists. Without this sweep those rows would replay
   * into the web permission banner at every connect, forever. Returns how many
   * were released.
   */
  async releaseOrphanedRequests(): Promise<number> {
    const released = await this.db
      .update(permissionRequests)
      .set({ status: 'expired' })
      .where(eq(permissionRequests.status, 'pending'))
      .returning({ id: permissionRequests.id });
    if (released.length > 0) {
      securityLogger.info({ count: released.length }, 'Released permission requests orphaned by a restart');
    }
    return released.length;
  }

  /**
   * Get pending permission requests for a user
   */
  async getPendingRequests(userId: string): Promise<PermissionRequest[]> {
    return this.db
      .select()
      .from(permissionRequests)
      .where(
        and(
          eq(permissionRequests.userId, userId),
          eq(permissionRequests.status, 'pending'),
          // A request with no expiry never times out — the common case now.
          sql`(${permissionRequests.expiresAt} IS NULL OR ${permissionRequests.expiresAt} > NOW())`
        )
      );
  }

  /**
   * Set permission level
   */
  async setPermission(
    userId: string,
    toolId: string,
    action: string,
    level: PermissionLevel,
    options?: {
      conditions?: PermissionCondition[];
      grantedBy?: string;
      reason?: string;
      expiresAt?: Date;
    }
  ): Promise<ToolPermission> {
    const existing = await this.db
      .select()
      .from(toolPermissions)
      .where(
        and(
          eq(toolPermissions.userId, userId),
          eq(toolPermissions.toolId, toolId),
          eq(toolPermissions.action, action)
        )
      )
      .limit(1);

    if (existing[0]) {
      // Update existing
      const result = await this.db
        .update(toolPermissions)
        .set({
          level,
          conditions: options?.conditions || [],
          grantedBy: options?.grantedBy,
          reason: options?.reason,
          expiresAt: options?.expiresAt ?? null,
          updatedAt: new Date(),
        })
        .where(eq(toolPermissions.id, existing[0].id))
        .returning();

      securityLogger.info({ userId, toolId, action, level }, 'Permission updated');
      return result[0];
    }

    // Create new
    const result = await this.db
      .insert(toolPermissions)
      .values({
        userId,
        toolId,
        action,
        level,
        conditions: options?.conditions || [],
        grantedBy: options?.grantedBy,
        reason: options?.reason,
        expiresAt: options?.expiresAt,
      })
      .returning();

    securityLogger.info({ userId, toolId, action, level }, 'Permission created');
    return result[0];
  }

  /**
   * Get all permissions for a user
   */
  async getUserPermissions(userId: string): Promise<ToolPermission[]> {
    return this.db.select().from(toolPermissions).where(eq(toolPermissions.userId, userId));
  }

  /**
   * Delete a permission
   */
  async deletePermission(userId: string, toolId: string, action: string): Promise<boolean> {
    const result = await this.db
      .delete(toolPermissions)
      .where(
        and(
          eq(toolPermissions.userId, userId),
          eq(toolPermissions.toolId, toolId),
          eq(toolPermissions.action, action)
        )
      )
      .returning();

    if (result.length > 0) {
      securityLogger.info({ userId, toolId, action }, 'Permission deleted');
      return true;
    }

    return false;
  }
}

// Singleton instance
let permissionManagerInstance: PermissionManager | null = null;

export function getPermissionManager(): PermissionManager {
  if (!permissionManagerInstance) {
    permissionManagerInstance = new PermissionManager();
  }
  return permissionManagerInstance;
}
