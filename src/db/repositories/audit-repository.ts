import { eq, desc, and, gte, lte, sql } from 'drizzle-orm';
import { getDb } from '../postgres';
import { auditLog, auditActionEnum, type AuditLogEntry, type NewAuditLogEntry, type AuditDetails } from '../schema/audit';
import { dbLogger } from '@/utils/logger';

export class AuditRepository {
  private db = getDb();

  async log(entry: Omit<NewAuditLogEntry, 'id' | 'createdAt'>): Promise<AuditLogEntry> {
    const result = await this.db.insert(auditLog).values(entry).returning();
    return result[0];
  }

  async findById(id: string): Promise<AuditLogEntry | null> {
    const result = await this.db.select().from(auditLog).where(eq(auditLog.id, id)).limit(1);
    return result[0] ?? null;
  }

  async findByUser(userId: string, limit: number = 100): Promise<AuditLogEntry[]> {
    return this.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.userId, userId))
      .orderBy(desc(auditLog.createdAt))
      .limit(limit);
  }

  async findByAction(action: string, limit: number = 100): Promise<AuditLogEntry[]> {
    return this.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, action as (typeof auditActionEnum.enumValues)[number]))
      .orderBy(desc(auditLog.createdAt))
      .limit(limit);
  }

  async findByResource(resourceType: string, resourceId: string): Promise<AuditLogEntry[]> {
    return this.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.resourceType, resourceType), eq(auditLog.resourceId, resourceId)))
      .orderBy(desc(auditLog.createdAt));
  }

  async findBySession(sessionId: string): Promise<AuditLogEntry[]> {
    return this.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.sessionId, sessionId))
      .orderBy(desc(auditLog.createdAt));
  }

  async findInTimeRange(startTime: Date, endTime: Date, limit: number = 1000): Promise<AuditLogEntry[]> {
    return this.db
      .select()
      .from(auditLog)
      .where(and(gte(auditLog.createdAt, startTime), lte(auditLog.createdAt, endTime)))
      .orderBy(desc(auditLog.createdAt))
      .limit(limit);
  }

  async listRecent(limit: number = 100): Promise<AuditLogEntry[]> {
    return this.db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(limit);
  }

  async countByAction(action: string, since?: Date): Promise<number> {
    const conditions = [eq(auditLog.action, action as (typeof auditActionEnum.enumValues)[number])];
    if (since) {
      conditions.push(gte(auditLog.createdAt, since));
    }

    const result = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(and(...conditions));

    return result[0]?.count ?? 0;
  }

  async getActionCounts(since: Date): Promise<Record<string, number>> {
    const result = await this.db
      .select({
        action: auditLog.action,
        count: sql<number>`count(*)::int`,
      })
      .from(auditLog)
      .where(gte(auditLog.createdAt, since))
      .groupBy(auditLog.action);

    return Object.fromEntries(result.map((r) => [r.action, r.count]));
  }

  // Convenience methods for common audit actions
  async logLogin(userId: string, ipAddress?: string, userAgent?: string): Promise<void> {
    await this.log({
      userId,
      action: 'login',
      ipAddress,
      userAgent,
    });
  }

  async logLogout(userId: string): Promise<void> {
    await this.log({
      userId,
      action: 'logout',
    });
  }

  async logLoginFailed(username: string, ipAddress?: string, reason?: string): Promise<void> {
    await this.log({
      action: 'login_failed',
      details: { username, reason } as AuditDetails,
      ipAddress,
    });
  }

  async logToolExecuted(
    userId: string,
    sessionId: string,
    toolName: string,
    toolId: string,
    details?: AuditDetails
  ): Promise<void> {
    await this.log({
      userId,
      action: 'tool_executed',
      resourceType: 'tool',
      resourceId: toolName,
      sessionId,
      details: { ...details, toolName, toolId },
    });
  }

  async logToolDenied(
    userId: string,
    sessionId: string,
    toolName: string,
    toolId: string,
    details?: AuditDetails
  ): Promise<void> {
    await this.log({
      userId,
      action: 'permission_denied',
      resourceType: 'tool',
      resourceId: toolName,
      sessionId,
      details: { ...details, toolName, toolId },
    });
  }

  async logCredentialAccessed(userId: string, credentialId: string, toolId?: string): Promise<void> {
    await this.log({
      userId,
      action: 'credential_accessed',
      resourceType: 'credential',
      resourceId: credentialId,
      details: { toolId } as AuditDetails,
    });
  }

  async logAgentSpawned(userId: string, sessionId: string, agentId: string, topic: string): Promise<void> {
    await this.log({
      userId,
      action: 'agent_spawned',
      resourceType: 'agent',
      resourceId: agentId,
      sessionId,
      details: { topic } as AuditDetails,
    });
  }

  async logAgentCompleted(
    userId: string,
    sessionId: string,
    agentId: string,
    details: { durationMs: number; iterations?: number; totalTokensUsed?: number; model?: string; role?: string },
  ): Promise<void> {
    await this.log({
      userId,
      action: 'agent_completed',
      resourceType: 'agent',
      resourceId: agentId,
      sessionId,
      details: { ...details, duration: details.durationMs } as AuditDetails,
    });
  }

  async logAgentFailed(
    userId: string,
    sessionId: string,
    agentId: string,
    details: { error: string; iteration?: number; elapsedMs?: number; totalTokensUsed?: number; model?: string; role?: string },
  ): Promise<void> {
    await this.log({
      userId,
      action: 'agent_failed',
      resourceType: 'agent',
      resourceId: agentId,
      sessionId,
      details: details as AuditDetails,
    });
  }
}

export const auditRepository = new AuditRepository();
