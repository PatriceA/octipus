import type { TurnEvent } from '@/core/agent/service';
import type { AgentEvent } from '@/core/agent-base';
import type { PermissionRequestEvent } from '@/security/permissions';
import { coreLogger } from '@/utils/logger';
import type { GatewayHub } from './hub';

/**
 * Bridge existing root agent and agent manager events to the gateway event bus.
 * This runs after both the gateway hub and root agent are initialized.
 *
 * Call `connectEventBridge(hub)` from the startup sequence after the root agent is ready.
 */
export function connectEventBridge(hub: GatewayHub): () => void {
  const cleanups: (() => void)[] = [];

  // Bridge root agent events → gateway event bus
  try {
    const { getAgentService } = require('@/core/agent');
    const rootAgent = getAgentService();

    const unsubOrch = rootAgent.onEvent((event: TurnEvent) => {
      hub.publishEvent({
        type: mapTurnEventType(event.type),
        source: 'root',
        userId: event.userId,
        sessionId: event.sessionId,
        payload: event.data,
      });
    });

    cleanups.push(unsubOrch);
    coreLogger.debug('Connected rootAgent events to gateway event bus');
  } catch {
    coreLogger.debug('Root agent not available for event bridge (may not be initialized yet)');
  }

  // Bridge agent manager events → gateway event bus
  try {
    const { getAgentManager } = require('@/core/agent-manager');
    const agentManager = getAgentManager();

    const unsubAgent = agentManager.onEvent((event: AgentEvent) => {
      // AgentEvent carries { type, agentId, data, timestamp } — no userId/
      // sessionId (those are undefined here; agent lifecycle events reach
      // clients via the root agent bridge's worker_spawned/worker_completed
      // → agent.spawned/agent.completed mapping above). The worker's emitted
      // `type` union is thought|action|observation|error|complete|
      // status_change|permission_request.

      // Filter `thought` events down to the iteration-update sub-shape so
      // chats and TUIs can show a "iter N/M" tick while the agent is
      // still reasoning. The other `thought` payloads (free-form chain-
      // of-thought) stay internal — surfacing them as gateway events
      // would explode bandwidth and leak reasoning.
      if (event.type === 'thought') {
        const data = event.data as { type?: string; iteration?: number; reason?: string; blockedForMs?: number } | undefined;
        if (data?.type === 'iteration_update' && typeof data.iteration === 'number') {
          hub.publishEvent({
            type: 'agent.iteration',
            source: `agent:${event.agentId}`,
            payload: { agentId: event.agentId, iteration: data.iteration },
          });
        }
        // A long silence is indistinguishable from a hang unless we say what we
        // are waiting for. Low volume by construction — one every 20s, and only
        // while genuinely blocked (docs/plans/blocked-vs-stuck.md Phase 1).
        if (data?.type === 'blocked_progress' && typeof data.reason === 'string') {
          hub.publishEvent({
            type: 'agent.blocked',
            source: `agent:${event.agentId}`,
            payload: { agentId: event.agentId, reason: data.reason, blockedForMs: data.blockedForMs ?? 0 },
          });
        }
        return;
      }
      // 'action' carries the tool-call stream payload — bridge it as its own
      // subtype so the TUI (and any other `/gateway` client) can match it
      // instead of fishing through the generic `agent.event` bucket.
      const subtype = event.type === 'action' ? 'agent.action' : 'agent.event';
      hub.publishEvent({
        type: subtype,
        source: `agent:${event.agentId}`,
        payload: event.data ?? event,
      });
    });

    cleanups.push(unsubAgent);
    coreLogger.debug('Connected agent manager events to gateway event bus');
  } catch {
    coreLogger.debug('Agent manager not available for event bridge');
  }

  // Bridge permission requests → gateway event bus
  try {
    const { getPermissionManager } = require('@/security/permissions');
    const permissionManager = getPermissionManager();

    const unsubPerm = permissionManager.onRequest((request: PermissionRequestEvent) => {
      // Field names must match `PermissionManager.emitRequest` in
      // `src/security/permissions.ts` — the emitter sends `requestId`,
      // `toolName`, and `args`. Reading `request.id`/`request.context` here
      // produced undefined values, leaving the TUI permission prompt with
      // an empty requestId so users could never approve/deny.
      hub.publishEvent({
        type: 'permission.request',
        source: `agent:${request.agentId}`,
        userId: request.userId,
        sessionId: request.sessionId,
        payload: {
          requestId: request.requestId,
          toolId: request.toolId,
          action: request.action,
          toolName: request.toolName,
          args: request.args,
        },
      });
    });

    cleanups.push(unsubPerm);
    coreLogger.debug('Connected permission manager to gateway event bus');
  } catch {
    coreLogger.debug('Permission manager not available for event bridge');
  }

  return () => {
    for (const cleanup of cleanups) {
      try { cleanup(); } catch (err) { coreLogger.warn({ err }, 'event-bridge cleanup failed'); }
    }
  };
}

/**
 * Map root agent event types to gateway event type namespaces.
 */
function mapTurnEventType(type: string): import('./protocol').GatewayEventType {
  switch (type) {
    case 'chat_response': return 'chat.response';
    case 'status_update': return 'rootAgent.status';
    case 'approval_required': return 'agent.approval_required';
    case 'worker_spawned': return 'agent.spawned';
    case 'worker_completed': return 'agent.completed';
    case 'pipeline_event': return 'pipeline.event';
    case 'team_started': return 'team.started';
    case 'team_completed': return 'team.completed';
    default: return 'agent.event';
  }
}
