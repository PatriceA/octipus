import { and, eq, sql } from 'drizzle-orm';
import type { PermissionLevel } from '@/core/types';
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

const PERMISSION_REQUEST_TTL = 300000; // 5 minutes

export interface PermissionCheckResult {
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
  private pendingRequests: Map<string, (approved: boolean, resolution?: string) => void> = new Map();
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
    context?: Record<string, unknown>
  ): Promise<PermissionCheckResult> {
    // 1. Check rule engine first (deny→allow→ask pattern matching)
    try {
      const { getPermissionRuleEngine } = await import('./permission-rules');
      const ruleEngine = getPermissionRuleEngine();
      if (ruleEngine.getRuleCount() > 0) {
        const ruleResult = ruleEngine.evaluate(toolId, action, context);
        if (ruleResult) {
          switch (ruleResult.decision) {
            case 'deny':
              return { allowed: false, level: 'DENY', requiresApproval: false, reason: `Denied by rule: ${ruleResult.rule}` };
            case 'allow':
              // A blanket ALLOW does not cover an action its own tool declares
              // `dangerous`. The shipped rules include `filesystem(*)` — "the
              // filesystem tool has its own guards", which are path-containment
              // guards, not destruction guards — and rules match on tool + path,
              // never on action, so that one line silently outranked
              // `delete: ASK, dangerous: true` in the manifest. An agent told to
              // empty a directory simply called `delete_file` twenty-one times
              // and no approval was ever consulted.
              //
              // Falling through (rather than returning ASK here) keeps the
              // manifest and any stored per-user level authoritative for the
              // dangerous action, which is where those decisions belong.
              if (!this.isDangerousAction(toolId, action)) {
                return { allowed: true, level: 'ALLOW', requiresApproval: false };
              }
              break;
            case 'ask':
              return { allowed: false, level: 'ASK', requiresApproval: true, reason: `Requires approval: ${ruleResult.rule}` };
          }
        }
      }
    } catch { /* rule engine not initialized */ }

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

    // Fall back to the tool's default permission level, or ASK if not found
    let defaultLevel: PermissionLevel = 'ASK';
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
    if (permission[0]?.conditions && context) {
      const conditionsResult = await this.checkConditions(
        permission[0].conditions as PermissionCondition[],
        context,
        { userId, toolId, action },
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
        };

      case 'DENY':
        return {
          allowed: false,
          level: 'DENY',
          requiresApproval: false,
          reason: 'Action is denied by policy',
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
    identity: { userId: string; toolId: string; action: string }
  ): Promise<{ passed: boolean; reason?: string }> {
    for (const condition of conditions) {
      switch (condition.type) {
        case 'path_pattern': {
          const path = context.path as string;
          if (path && typeof condition.value === 'string') {
            const pattern = safeRegExp(condition.value);
            if (!pattern) {
              return { passed: false, reason: 'Invalid or too complex path pattern' };
            }
            if (!pattern.test(path)) {
              return { passed: false, reason: `Path does not match pattern: ${condition.value}` };
            }
          }
          break;
        }

        case 'command_pattern': {
          const command = context.command as string;
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
      expiresAt: new Date(Date.now() + PERMISSION_REQUEST_TTL),
    };

    await this.db.insert(permissionRequests).values(request);

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
  async waitForApproval(requestId: string, timeoutMs: number = PERMISSION_REQUEST_TTL): Promise<boolean> {
    return new Promise((resolve) => {
      // Set up callback
      this.pendingRequests.set(requestId, (approved) => {
        resolve(approved);
      });

      // Set timeout
      setTimeout(() => {
        const callback = this.pendingRequests.get(requestId);
        if (callback) {
          this.pendingRequests.delete(requestId);
          this.expireRequest(requestId).catch((err: unknown) => coreLogger.error({ err }, 'background task failed in permissions'));
          resolve(false);
        }
      }, timeoutMs);
    });
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
          sql`${permissionRequests.expiresAt} > NOW()`
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
          expiresAt: options?.expiresAt,
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
