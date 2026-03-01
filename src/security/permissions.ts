import { eq, and, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import {
  skillPermissions,
  permissionRequests,
  type SkillPermission,
  type NewSkillPermission,
  type PermissionRequest,
  type NewPermissionRequest,
  type PermissionCondition,
} from '@/db/schema/permissions';
import { auditRepository } from '@/db/repositories/audit-repository';
import { securityLogger } from '@/utils/logger';
import { generateId } from '@/utils/crypto';
import type { PermissionLevel } from '@/core/types';

const PERMISSION_REQUEST_TTL = 300000; // 5 minutes

export interface PermissionCheckResult {
  allowed: boolean;
  level: PermissionLevel;
  requiresApproval: boolean;
  requestId?: string;
  reason?: string;
}

export class PermissionManager {
  private db = getDb();
  private pendingRequests: Map<string, (approved: boolean, resolution?: string) => void> = new Map();
  private requestListeners: Set<(request: Record<string, unknown>) => void> = new Set();

  /**
   * Subscribe to new permission requests (for WebSocket forwarding)
   */
  onRequest(handler: (request: Record<string, unknown>) => void): () => void {
    this.requestListeners.add(handler);
    return () => this.requestListeners.delete(handler);
  }

  private emitRequest(request: Record<string, unknown>): void {
    for (const handler of this.requestListeners) {
      try { handler(request); } catch { /* ignore */ }
    }
  }

  /**
   * Check if an action is permitted
   */
  async check(
    userId: string,
    skillId: string,
    action: string,
    context?: Record<string, unknown>
  ): Promise<PermissionCheckResult> {
    // Get permission configuration
    const permission = await this.db
      .select()
      .from(skillPermissions)
      .where(
        and(
          eq(skillPermissions.userId, userId),
          eq(skillPermissions.skillId, skillId),
          eq(skillPermissions.action, action)
        )
      )
      .limit(1);

    // Default to ASK if no permission configured
    const level: PermissionLevel = permission[0]?.level || 'ASK';

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
      const conditionsResult = this.checkConditions(permission[0].conditions as PermissionCondition[], context);
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
  private checkConditions(
    conditions: PermissionCondition[],
    context: Record<string, unknown>
  ): { passed: boolean; reason?: string } {
    for (const condition of conditions) {
      switch (condition.type) {
        case 'path_pattern': {
          const path = context.path as string;
          if (path && typeof condition.value === 'string') {
            const pattern = new RegExp(condition.value);
            if (!pattern.test(path)) {
              return { passed: false, reason: `Path does not match pattern: ${condition.value}` };
            }
          }
          break;
        }

        case 'command_pattern': {
          const command = context.command as string;
          if (command && typeof condition.value === 'string') {
            const pattern = new RegExp(condition.value);
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
          // Rate limiting would need to be implemented with Redis
          // For now, pass through
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
    skillId: string,
    action: string,
    context: Record<string, unknown>,
    sessionId?: string
  ): Promise<string> {
    const requestId = generateId();

    const request: NewPermissionRequest = {
      id: requestId,
      userId,
      agentId,
      sessionId,
      skillId,
      action,
      context: {
        toolName: action,
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
      details: { skillId, action, agentId },
    });

    securityLogger.info({ requestId, userId, skillId, action }, 'Permission requested');

    // Notify WebSocket listeners
    this.emitRequest({
      requestId,
      userId,
      agentId,
      skillId,
      action,
      toolName: action,
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
          this.expireRequest(requestId).catch(() => {});
          resolve(false);
        }
      }, timeoutMs);
    });
  }

  /**
   * Approve a permission request
   */
  async approve(requestId: string, resolvedBy: string, resolution?: string): Promise<boolean> {
    const result = await this.db
      .update(permissionRequests)
      .set({
        status: 'approved',
        resolvedBy,
        resolvedAt: new Date(),
        resolution,
      })
      .where(and(eq(permissionRequests.id, requestId), eq(permissionRequests.status, 'pending')))
      .returning();

    if (result.length > 0) {
      const request = result[0];

      await auditRepository.log({
        userId: request.userId,
        action: 'permission_granted',
        resourceType: 'permission',
        resourceId: requestId,
        sessionId: request.sessionId || undefined,
        details: { skillId: request.skillId, action: request.action, resolvedBy },
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
   * Deny a permission request
   */
  async deny(requestId: string, resolvedBy: string, resolution?: string): Promise<boolean> {
    const result = await this.db
      .update(permissionRequests)
      .set({
        status: 'denied',
        resolvedBy,
        resolvedAt: new Date(),
        resolution,
      })
      .where(and(eq(permissionRequests.id, requestId), eq(permissionRequests.status, 'pending')))
      .returning();

    if (result.length > 0) {
      const request = result[0];

      await auditRepository.log({
        userId: request.userId,
        action: 'permission_denied',
        resourceType: 'permission',
        resourceId: requestId,
        sessionId: request.sessionId || undefined,
        details: { skillId: request.skillId, action: request.action, resolvedBy, reason: resolution },
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
    skillId: string,
    action: string,
    level: PermissionLevel,
    options?: {
      conditions?: PermissionCondition[];
      grantedBy?: string;
      reason?: string;
      expiresAt?: Date;
    }
  ): Promise<SkillPermission> {
    const existing = await this.db
      .select()
      .from(skillPermissions)
      .where(
        and(
          eq(skillPermissions.userId, userId),
          eq(skillPermissions.skillId, skillId),
          eq(skillPermissions.action, action)
        )
      )
      .limit(1);

    if (existing[0]) {
      // Update existing
      const result = await this.db
        .update(skillPermissions)
        .set({
          level,
          conditions: options?.conditions || [],
          grantedBy: options?.grantedBy,
          reason: options?.reason,
          expiresAt: options?.expiresAt,
          updatedAt: new Date(),
        })
        .where(eq(skillPermissions.id, existing[0].id))
        .returning();

      securityLogger.info({ userId, skillId, action, level }, 'Permission updated');
      return result[0];
    }

    // Create new
    const result = await this.db
      .insert(skillPermissions)
      .values({
        userId,
        skillId,
        action,
        level,
        conditions: options?.conditions || [],
        grantedBy: options?.grantedBy,
        reason: options?.reason,
        expiresAt: options?.expiresAt,
      })
      .returning();

    securityLogger.info({ userId, skillId, action, level }, 'Permission created');
    return result[0];
  }

  /**
   * Get all permissions for a user
   */
  async getUserPermissions(userId: string): Promise<SkillPermission[]> {
    return this.db.select().from(skillPermissions).where(eq(skillPermissions.userId, userId));
  }

  /**
   * Delete a permission
   */
  async deletePermission(userId: string, skillId: string, action: string): Promise<boolean> {
    const result = await this.db
      .delete(skillPermissions)
      .where(
        and(
          eq(skillPermissions.userId, userId),
          eq(skillPermissions.skillId, skillId),
          eq(skillPermissions.action, action)
        )
      )
      .returning();

    if (result.length > 0) {
      securityLogger.info({ userId, skillId, action }, 'Permission deleted');
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
