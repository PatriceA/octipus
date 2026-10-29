import type { DelegationAttempt } from '@/core/swarm/attempt-history';
import { and, asc, eq, gt, inArray, isNull, like, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { agents } from '@/db/schema/agents';
import { agentEvents } from '@/db/schema/agent-events';
import { sessionRepository } from '@/db/repositories/session-repository';
import { canActInSession } from '@/core/rooms/access';
import { redactAgentDiagnostics } from '@/security/credential-redaction';
import { redactedCommand } from '@/utils/command-log';
import type { AgentContext } from '@/core/types';
import type { ToolHandler } from '@/core/agent-base';

/** Live handles are run-local; this read-only history remains available after
 * collect or failure. UI ids are agents.id, never inferred from dispatch ids.
 */
export function createAgentActivityTools(): ToolHandler[] {
  return [{
    name: 'get_agent_activity', toolId: 'agent_activity', replaySafety: 'read_only',
    description: 'Read authorized durable agent history, including failed or already-collected children. Filter by sessionId, dispatchId, or UI agentId (full or unambiguous prefix). Returns attempt identifiers/errors and paged events; task_state only indexes task outputs, not all executions.',
    parameters: { type: 'object', properties: {
      sessionId: { type: 'string' }, dispatchId: { type: 'string' }, agentId: { type: 'string' },
      afterAgentId: { type: 'string' }, afterEventId: { type: 'integer', minimum: 0 },
      includeEvents: { type: 'boolean', default: false }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
    } },
    execute: readAgentActivity,
  }];
}

export async function readAgentActivity(args: Record<string, unknown>, context: Pick<AgentContext, 'userId' | 'sessionId' | 'workspaceId'>): Promise<unknown> {

      const currentSession = await sessionRepository.findById(context.sessionId);
      if (!currentSession || !await canActInSession(currentSession, context.userId, 'control')) return { error: 'Session not found' };
      const workspaceId = context.workspaceId ?? currentSession.workspaceId ?? null;
      if ((currentSession.workspaceId ?? null) !== workspaceId) return { error: 'Workspace scope mismatch' };
      const sessionId = typeof args.sessionId === 'string' ? args.sessionId
        : !args.agentId && !args.dispatchId ? context.sessionId : undefined;
      if (sessionId) {
        const session = await sessionRepository.findById(sessionId);
        if (!session || (session.workspaceId ?? null) !== workspaceId || !await canActInSession(session, context.userId, 'control')) return { error: 'Session not found' };
      }
      const limit = typeof args.limit === 'number' && Number.isInteger(args.limit) ? Math.max(1, Math.min(100, args.limit)) : 30;
      const conditions = [eq(agents.userId, context.userId), workspaceId ? eq(agents.workspaceId, workspaceId) : isNull(agents.workspaceId)];
      if (sessionId) conditions.push(eq(agents.sessionId, sessionId));
      if (typeof args.dispatchId === 'string') conditions.push(sql`${agents.metadata}->>'delegationDispatchId' = ${args.dispatchId}`);
      if (typeof args.agentId === 'string') {
        if (!/^[a-zA-Z0-9_-]{8,64}$/.test(args.agentId)) return { error: 'Use a full agent id or a prefix of at least 8 characters' };
        conditions.push(like(agents.id, `${args.agentId.replace(/[_%]/g, '\\$&')}%`));
      }
      const authorized: Array<typeof agents.$inferSelect> = [];
      const access = new Map<string, boolean>();
      let cursor = typeof args.afterAgentId === 'string' ? args.afterAgentId : undefined;
      let scanned = 0;
      let complete = false;
      const batchSize = Math.max(32, limit + 1);
      // Page over authorized rows. Inaccessible gaps cannot cause a returned
      // lookahead row to repeat, or expose an inaccessible id as a cursor.
      while (!complete && authorized.length <= limit && scanned < 1000) {
        const rows = await getDb().select().from(agents)
          .where(and(...conditions, cursor ? gt(agents.id, cursor) : undefined))
          .orderBy(asc(agents.id)).limit(batchSize);
        complete = rows.length < batchSize;
        for (const row of rows) {
          scanned++;
          cursor = row.id;
          if (!access.has(row.sessionId)) {
            const target = await sessionRepository.findById(row.sessionId);
            access.set(row.sessionId, !!target && (target.workspaceId ?? null) === workspaceId
              && await canActInSession(target, context.userId, 'control'));
          }
          if (access.get(row.sessionId)) authorized.push(row);
          if (authorized.length > limit || (args.agentId && authorized.length > 1)) break;
        }
      }
      if (!complete && authorized.length <= limit && scanned >= 1000) return { error: 'Too many inaccessible results; narrow the session or use a full agent id' };
      if (args.agentId && authorized.length > 1 && !authorized.some(row => row.id === args.agentId)) return { error: 'Ambiguous agent id prefix', candidates: authorized.map(row => row.id) };
      const exact = typeof args.agentId === 'string' ? authorized.find(row => row.id === args.agentId) : undefined;
      const selected = exact ? [exact] : authorized.slice(0, limit);
      const after = typeof args.afterEventId === 'number' && Number.isSafeInteger(args.afterEventId) && args.afterEventId >= 0 ? args.afterEventId : 0;
      const events = args.includeEvents === true && selected.length ? await getDb().select().from(agentEvents)
        .where(and(inArray(agentEvents.agentId, selected.map(row => row.id)), gt(agentEvents.id, after)))
        .orderBy(asc(agentEvents.id)).limit(101) : [];
      const result = {
        workspaceId,
        attempts: selected.flatMap(row => Array.isArray(row.metadata?.delegationAttempts)
          ? row.metadata.delegationAttempts as DelegationAttempt[] : [])
          .sort((a,b) => a.dispatchId.localeCompare(b.dispatchId) || (a.sequence ?? 0) - (b.sequence ?? 0) || a.startedAt.localeCompare(b.startedAt)),
        agents: selected.map(row => ({
          agentId: row.id, uiAgentId: row.id, uiPath: `/agents/view?id=${encodeURIComponent(row.id)}`, sessionId: row.sessionId,
          parentAgentId: row.parentAgentId, dispatchId: row.metadata?.delegationDispatchId ?? null,
          model: row.model, topic: row.topic, status: row.status, createdAt: row.createdAt, completedAt: row.completedAt,
          error: row.error ? redactedCommand(row.error) : null, attempts: row.metadata?.delegationAttempts ?? [],
          historicalAttemptCoverage: row.metadata?.delegationAttempts ? 'recorded' : 'legacy: original provider attempts may not have been recorded',
        })),
        hasMoreAgents: !exact && authorized.length > limit, nextAgentCursor: selected.at(-1)?.id ?? null,
        events: events.slice(0, 100), hasMoreEvents: events.length > 100, nextEventCursor: events.slice(0, 100).at(-1)?.id ?? after,
        taskStateBoundary: 'task_state stores task/output records, not the complete execution history. collect_children collects live run-local handles; use this tool for historical diagnostics.',
      };
      return redactAgentDiagnostics(context.userId, workspaceId, result);

}
