import { coreLogger } from '@/utils/logger';
import type { GatewayHub } from './hub';

/**
 * Bridge existing orchestrator and agent manager events to the gateway event bus.
 * This runs after both the gateway hub and orchestrator are initialized.
 *
 * Call `connectEventBridge(hub)` from the startup sequence after the orchestrator is ready.
 */
export function connectEventBridge(hub: GatewayHub): () => void {
  const cleanups: (() => void)[] = [];

  // Bridge orchestrator events → gateway event bus
  try {
    const { getOrchestratorService } = require('@/core/orchestrator');
    const orchestrator = getOrchestratorService();

    const unsubOrch = orchestrator.onEvent((event: any) => {
      hub.publishEvent({
        type: mapOrchestratorEventType(event.type),
        source: 'orchestrator',
        userId: event.userId,
        sessionId: event.sessionId,
        payload: event.data,
      });
    });

    cleanups.push(unsubOrch);
    coreLogger.debug('Connected orchestrator events to gateway event bus');
  } catch {
    coreLogger.debug('Orchestrator not available for event bridge (may not be initialized yet)');
  }

  // Bridge agent manager events → gateway event bus
  try {
    const { getAgentManager } = require('@/core/agent-manager');
    const agentManager = getAgentManager();

    const unsubAgent = agentManager.onEvent((event: any) => {
      // Filter `thought` events down to the iteration-update sub-shape so
      // chats and TUIs can show a "iter N/M" tick while the agent is
      // still reasoning. The other `thought` payloads (free-form chain-
      // of-thought) stay internal — surfacing them as gateway events
      // would explode bandwidth and leak reasoning.
      if (event.type === 'thought') {
        const data = event.data as { type?: string; iteration?: number } | undefined;
        if (data?.type === 'iteration_update' && typeof data.iteration === 'number') {
          hub.publishEvent({
            type: 'agent.iteration',
            source: `agent:${event.agentId || 'unknown'}`,
            userId: event.userId,
            sessionId: event.sessionId,
            payload: { agentId: event.agentId, iteration: data.iteration },
          });
        }
        return;
      }
      const subtype = event.type === 'spawned' ? 'agent.spawned'
        : event.type === 'completed' ? 'agent.completed'
        : event.type === 'stopped' ? 'agent.stopped'
        : 'agent.event';
      hub.publishEvent({
        type: subtype,
        source: `agent:${event.agentId || 'unknown'}`,
        userId: event.userId,
        sessionId: event.sessionId,
        payload: event.data || event,
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

    const unsubPerm = permissionManager.onRequest((request: any) => {
      hub.publishEvent({
        type: 'permission.request',
        source: `agent:${request.agentId}`,
        userId: request.userId,
        payload: {
          requestId: request.id,
          toolId: request.toolId,
          action: request.action,
          context: request.context,
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
 * Map orchestrator event types to gateway event type namespaces.
 */
function mapOrchestratorEventType(type: string): import('./protocol').GatewayEventType {
  switch (type) {
    case 'chat_response': return 'chat.response';
    case 'status_update': return 'orchestrator.status';
    case 'approval_required': return 'orchestrator.approval_required';
    case 'worker_spawned': return 'agent.spawned';
    case 'worker_completed': return 'agent.completed';
    case 'pipeline_event': return 'pipeline.event';
    case 'team_started': return 'team.started';
    case 'team_completed': return 'team.completed';
    default: return 'agent.event';
  }
}
